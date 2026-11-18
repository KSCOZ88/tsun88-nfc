'use strict';
// Durable webhook queue: acknowledge authenticated events before external payment lookup / SMTP.
const {db,schema,recordPaid}=require('./airwallex-order-store');
const {verify}=require('./airwallex-payment-links');
const {sendGmail,GMAIL_ADDRESS}=require('./gmail-mailer');
const {escape}=require('./email-template');
const {createHash}=require('node:crypto');
const fail=(message,status=422)=>Object.assign(new Error(message),{status});
let tablesPromise;
async function tables(sql){
 if(!tablesPromise)tablesPromise=(async()=>{
  await schema(sql);
  await sql`ALTER TABLE tsun_airwallex_orders ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ`;
  await sql`CREATE TABLE IF NOT EXISTS tsun_airwallex_webhook_events (
   event_id TEXT PRIMARY KEY,
   payment_link_id TEXT NOT NULL,
   received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
   processed_at TIMESTAMPTZ,
   processing_until TIMESTAMPTZ,
   attempts INTEGER NOT NULL DEFAULT 0,
   last_error TEXT
  )`;
  await sql`CREATE TABLE IF NOT EXISTS tsun_airwallex_mail (
   merchant_order_id TEXT NOT NULL,
   payment_link_id TEXT NOT NULL,
   stage TEXT NOT NULL,
   customer_sent BOOLEAN NOT NULL DEFAULT false,
   merchant_sent BOOLEAN NOT NULL DEFAULT false,
   processing_until TIMESTAMPTZ,
   PRIMARY KEY (merchant_order_id,stage)
  )`;
 })().catch(err=>{tablesPromise=null;throw err;});
 return tablesPromise;
}
async function enqueue(eventId,linkId){
 if(!/^[a-zA-Z0-9_-]{6,130}$/.test(eventId)||!/^[a-zA-Z0-9_-]{6,130}$/.test(linkId))throw fail('Webhook event identifiers invalid');
 const sql=db();await tables(sql);
 await sql`INSERT INTO tsun_airwallex_webhook_events (event_id,payment_link_id)
 VALUES (${eventId},${linkId}) ON CONFLICT(event_id) DO NOTHING`;
}
async function receipts(sql,row){
 const id=row.merchant_order_id,linkId=row.payment_link_id,stage='payment_received';
 await sql`INSERT INTO tsun_airwallex_mail (merchant_order_id,payment_link_id,stage)
 VALUES (${id},${linkId},${stage}) ON CONFLICT DO NOTHING`;
 const [claim]=await sql`UPDATE tsun_airwallex_mail SET processing_until=now()+interval '3 minutes'
 WHERE merchant_order_id=${id} AND payment_link_id=${linkId} AND stage=${stage}
 AND (processing_until IS NULL OR processing_until<now())
 AND (customer_sent=false OR merchant_sent=false)
 RETURNING customer_sent,merchant_sent`;
 if(!claim)return;
 try{
  const amount='HK$'+(row.amount_cents/100).toFixed(2);
  const subject='8TSUN8 付款确认 / Payment received – '+id;
  if(!claim.customer_sent){
   const customer=await sendGmail({
    to:[row.email],subject,
    html:'<p>您的 8TSUN8 订单已经收到付款。</p><p>订单号：'+escape(id)+'</p><p>金额：'+amount+'</p><p>请继续补齐订单及配送资料，完成后我们安排制作。</p>',
    text:'8TSUN8 已收到付款。订单：'+id+'，金额：'+amount+'。请继续完善订单和配送资料。'
   },'tsun-awx-receipt-'+id);
   if(!customer.sent)throw fail('Customer SMTP delivery not accepted',503);
   await sql`UPDATE tsun_airwallex_mail SET customer_sent=true WHERE merchant_order_id=${id} AND payment_link_id=${linkId} AND stage=${stage}`;
  }
  if(!claim.merchant_sent){
   const merchant=await sendGmail({
    to:[process.env.MERCHANT_EMAIL||GMAIL_ADDRESS],subject:'8TSUN8 已付款订单｜'+id,
    html:'<p>Airwallex 已验证付款。</p><p>订单：'+escape(id)+'</p><p>金额：'+amount+'</p><p>客户邮箱：'+escape(row.email)+'</p><p>注意：待客户补齐狗牌制作及配送资料后再安排生产。</p>',
    text:'Airwallex 已付款订单：'+id+'，金额：'+amount+'，客户邮箱：'+row.email+'。待完整订单资料后制作。'
   },'tsun-awx-merchant-'+id);
   if(!merchant.sent)throw fail('Merchant SMTP delivery not accepted',503);
   await sql`UPDATE tsun_airwallex_mail SET merchant_sent=true WHERE merchant_order_id=${id} AND payment_link_id=${linkId} AND stage=${stage}`;
  }
 }finally{
  await sql`UPDATE tsun_airwallex_mail SET processing_until=NULL WHERE merchant_order_id=${id} AND payment_link_id=${linkId} AND stage=${stage}`;
 }
}
async function processEvent(eventId){
 const sql=db();await tables(sql);
 const [evt]=await sql`UPDATE tsun_airwallex_webhook_events
 SET processing_until=now()+interval '2 minutes',attempts=attempts+1
 WHERE event_id=${eventId} AND processed_at IS NULL
 AND (processing_until IS NULL OR processing_until<now())
 RETURNING payment_link_id`;
 if(!evt)return {status:'handled-or-busy'};
 try{
  const [row]=await sql`SELECT merchant_order_id,email,amount_cents,payment_link_id,order_snapshot
   FROM tsun_airwallex_orders WHERE payment_link_id=${evt.payment_link_id}`;
  if(!row){
   // Old links created before the order-store rollout cannot be reconstructed safely.
   await sql`UPDATE tsun_airwallex_webhook_events SET processed_at=now(),processing_until=NULL,
   last_error='unmatched historical order' WHERE event_id=${eventId}`;
   return {status:'unmatched'};
  }
  if(!process.env.SMTP_APP_PASSWORD)throw fail('SMTP not configured',503);
  await verify(row.payment_link_id,row.order_snapshot);
  await recordPaid(row.order_snapshot,row.payment_link_id);
  await receipts(sql,row);
  const [mail]=await sql`SELECT customer_sent,merchant_sent FROM tsun_airwallex_mail WHERE merchant_order_id=${row.merchant_order_id} AND stage='payment_received'`;
  if(!mail?.customer_sent||!mail?.merchant_sent)throw fail('Mail delivery incomplete',503);
  await sql`UPDATE tsun_airwallex_webhook_events SET processed_at=now(),processing_until=NULL,last_error=NULL
   WHERE event_id=${eventId}`;
  return {status:'processed'};
 }catch(error){
  console.error('[Airwallex worker] event failed',{kind:String(error?.status||'unexpected')});
  await sql`UPDATE tsun_airwallex_webhook_events SET processing_until=NULL,last_error=${String(error?.status||'processing_failed')}
   WHERE event_id=${eventId}`.catch(()=>{});
  return {status:'retryable-error'};
 }
}
async function retryPending(limit=3){
 const sql=db();await tables(sql);
 const waiting=await sql`SELECT event_id FROM tsun_airwallex_webhook_events
 WHERE processed_at IS NULL AND (processing_until IS NULL OR processing_until<now())
 ORDER BY received_at ASC LIMIT ${Math.min(3,Math.max(1,limit))}`;
 return Promise.all(waiting.map(row=>processEvent(row.event_id)));
}
// Fallback for missing Airwallex deliveries: independently reconcile a few
// unconfirmed Payment Links on each scheduled run. A successful lookup creates
// a durable synthetic event, so SMTP failure is retried through the same queue.
async function reconcilePending(limit=3){
 const sql=db();await tables(sql);
 const capped=Math.min(3,Math.max(1,Number(limit)||3));
 const pending=await sql`SELECT merchant_order_id,payment_link_id,order_snapshot
 FROM tsun_airwallex_orders
 WHERE status='pending' AND payment_link_id IS NOT NULL
 ORDER BY last_reconciled_at ASC NULLS FIRST, created_at ASC
 LIMIT ${capped}`;
 const results=[];
 for(const order of pending){
   await sql`UPDATE tsun_airwallex_orders SET last_reconciled_at=now()
      WHERE merchant_order_id=${order.merchant_order_id} AND status='pending'`;
   try{
     await verify(order.payment_link_id,order.order_snapshot);
     const eventId='reconcile_'+createHash('sha256').update(order.payment_link_id).digest('hex');
     await enqueue(eventId,order.payment_link_id);
     const outcome=await processEvent(eventId);
     results.push({status:outcome.status});
   }catch(error){
     // A pending/unpaid link is expected; API/permission errors are retried on
     // the next reconciliation cycle. Never send mail on failed verification.
     const status=Number(error?.status)||500;
     results.push({status:status===409?'not-paid':'verification-unavailable'});
     if(status!==409)console.warn('[Airwallex reconcile] lookup unavailable',{status});
   }
 }
 return results;
}
async function dailyReconciliation(){
 const queued=await retryPending(3);
 const polled=await reconcilePending(3);
 console.info('[Airwallex reconcile] sweep complete',{queued:queued.length,polled:polled.length});
 return {queued:queued.length,polled:polled.length};
}
module.exports={enqueue,processEvent,retryPending,reconcilePending,dailyReconciliation};
