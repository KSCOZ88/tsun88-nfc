'use strict';
const {ensureProductionQueue}=require('./production-queue');
const {neon}=require('@neondatabase/serverless');
const {createHash}=require('node:crypto');
const {sendGmail}=require('./gmail-mailer');
const {fail,stripeSession,expireStripeSession,verifyPaidSession,deliver}=require('./stripe-orders');
let schemaPromise;
function db(){if(!process.env.DATABASE_URL)throw fail('订单数据库未配置',503);return neon(process.env.DATABASE_URL);}
async function schema(sql){if(!schemaPromise)schemaPromise=(async()=>{
 await sql`CREATE TABLE IF NOT EXISTS tsun_stripe_orders (
  merchant_order_id TEXT PRIMARY KEY,email TEXT NOT NULL,amount_cents INTEGER NOT NULL,
  order_binding TEXT NOT NULL,order_snapshot JSONB NOT NULL,previews JSONB NOT NULL DEFAULT '[]'::jsonb,
  stripe_session_id TEXT UNIQUE,stripe_session_url TEXT,payment_method TEXT,checkout_attempt INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'creating',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),paid_at TIMESTAMPTZ
 )`;
 await sql`ALTER TABLE tsun_stripe_orders ADD COLUMN IF NOT EXISTS payment_method TEXT`;
 await sql`ALTER TABLE tsun_stripe_orders ADD COLUMN IF NOT EXISTS checkout_attempt INTEGER NOT NULL DEFAULT 1`;
 await sql`CREATE TABLE IF NOT EXISTS tsun_stripe_webhook_events (
  event_id TEXT PRIMARY KEY,stripe_session_id TEXT NOT NULL,received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,processing_until TIMESTAMPTZ,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT
 )`;
 await sql`CREATE TABLE IF NOT EXISTS tsun_stripe_mail (
  merchant_order_id TEXT NOT NULL,stage TEXT NOT NULL,customer_sent BOOLEAN NOT NULL DEFAULT false,
  merchant_sent BOOLEAN NOT NULL DEFAULT false,processing_until TIMESTAMPTZ,
  PRIMARY KEY(merchant_order_id,stage)
 )`;
})().catch(e=>{schemaPromise=null;throw e;});return schemaPromise;}
function snapshot(order){const value=JSON.parse(JSON.stringify(order));function strip(obj,depth=0){if(!obj||typeof obj!=='object'||depth>14)return;for(const [k,v] of Object.entries(obj)){if(typeof v==='string'&&(v.startsWith('data:image/')||v.length>12000))obj[k]='[image not stored]';else if(v&&typeof v==='object')strip(v,depth+1);}}strip(value);if(Buffer.byteLength(JSON.stringify(value))>220000)throw fail('订单内容过大',413);return value;}
function binding(order,total){return createHash('sha256').update(JSON.stringify({id:order.id,email:String(order.customerEmail).toLowerCase(),amount:total.totalCents,items:order.items})).digest('hex');}
async function begin(order,previews,total,paymentMethod='card',allowSwitch=false){const sql=db();await schema(sql);const s=snapshot(order),b=binding(order,total);const inserted=await sql`INSERT INTO tsun_stripe_orders(merchant_order_id,email,amount_cents,order_binding,order_snapshot,previews,payment_method)
 VALUES(${order.id},${String(order.customerEmail).toLowerCase()},${total.totalCents},${b},${JSON.stringify(s)}::jsonb,${JSON.stringify(previews||[])}::jsonb,${paymentMethod})
 ON CONFLICT DO NOTHING RETURNING merchant_order_id`;
 if(inserted.length)return {sql,order,total,fresh:true,attempt:1};
 const [existing]=await sql`SELECT email,amount_cents,order_binding,stripe_session_id,stripe_session_url,payment_method,checkout_attempt,status FROM tsun_stripe_orders WHERE merchant_order_id=${order.id}`;
 if(!existing||existing.amount_cents!==total.totalCents||existing.email!==String(order.customerEmail).toLowerCase())throw fail('订单资料或金额已改变，请重新创建订单',409);
 // Returning from Stripe may rehydrate design objects with different non-payment
 // fields/serialization. Reuse the immutable server snapshot; never replace the
 // original paid-order design with mutable browser content.
 const canonicalChanged=existing.order_binding!==b;
 if(canonicalChanged){
  if(!existing.stripe_session_id||order.stripeSessionId!==existing.stripe_session_id)
    throw fail('訂單資料不一致，請返回原訂單再試',409);
  const [saved]=await sql`SELECT order_snapshot,previews FROM tsun_stripe_orders WHERE merchant_order_id=${order.id}`;
  if(!saved?.order_snapshot)throw fail('原訂單資料無法恢復，請聯絡商戶',409);
  const safeOrder=saved.order_snapshot;
  if(safeOrder.id!==order.id||String(safeOrder.customerEmail).toLowerCase()!==String(order.customerEmail).toLowerCase()||
     require('./stripe-orders').pricing(safeOrder).totalCents!==total.totalCents)
     throw fail('原訂單資料不一致，請聯絡商戶',409);
  order=safeOrder;previews=saved.previews||[];
 }
 if(existing.stripe_session_id&&existing.stripe_session_url&&existing.status==='pending'){
  const previousMethod=existing.payment_method||'card';
  if(previousMethod===paymentMethod)return {sql,order,total,existing};
  if(!allowSwitch)throw fail('切換支付方式需要確認舊付款會話已失效',409);
  // The current Stripe Checkout must be expired before replacing its pointer in our
  // order table. A completed session can never be switched, even if not yet settled.
  const previous=await stripeSession(existing.stripe_session_id);
  if(previous.status==='open'){
   const expired=await expireStripeSession(existing.stripe_session_id);
   if(expired.status!=='expired')throw fail('無法取消原付款連結，請勿重複付款',409);
  }else if(previous.status!=='expired'){
   throw fail('原付款已提交或正在處理，請先確認付款結果',409);
  }
  const changed=await sql`UPDATE tsun_stripe_orders
   SET stripe_session_id=NULL,stripe_session_url=NULL,payment_method=${paymentMethod},
       checkout_attempt=checkout_attempt+1,status='creating'
   WHERE merchant_order_id=${order.id} AND stripe_session_id=${existing.stripe_session_id}
     AND status='pending'
   RETURNING checkout_attempt`;
  if(!changed.length)throw fail('付款狀態已變更，請重新整理後核對',409);
  return {sql,order,total,fresh:true,attempt:changed[0].checkout_attempt};
 }
 if(existing.status==='cancelled'&&allowSwitch){
  const [changed]=await sql`UPDATE tsun_stripe_orders SET stripe_session_id=NULL,stripe_session_url=NULL,
    payment_method=${paymentMethod},checkout_attempt=checkout_attempt+1,status='creating'
    WHERE merchant_order_id=${order.id} AND status='cancelled' RETURNING checkout_attempt`;
  if(!changed.length)throw fail('付款狀態已變更，請重新整理',409);
  return {sql,order,total,fresh:true,attempt:changed[0].checkout_attempt};
 }
 if(existing.status==='paid')throw fail('该订单已付款，请勿重复付款',409);
 throw fail('Stripe 付款链接正在创建，请稍后刷新订单',409);
}
async function expireForAlternateProvider(order,sessionId){
 if(!/^cs_live_[A-Za-z0-9_]+$/.test(sessionId||''))throw fail('Stripe 付款編號無效',422);
 const sql=db();await schema(sql);
 const total=require('./stripe-orders').pricing(order),b=binding(order,total);
 const [existing]=await sql`SELECT merchant_order_id,email,amount_cents,order_binding,stripe_session_id,status
 FROM tsun_stripe_orders WHERE merchant_order_id=${order.id}`;
 if(!existing||existing.amount_cents!==total.totalCents||
 existing.email!==String(order.customerEmail||'').toLowerCase()||
 existing.stripe_session_id!==sessionId)throw fail('訂單資料與 Stripe 付款記錄不符',409);
 if(existing.status==='paid')throw fail('原訂單已付款，不可再次支付',409);
 if(existing.status==='cancelled')return {retired:true};
 if(existing.status!=='pending')throw fail('付款會話仍在建立中，請稍後重試',409);
 const session=await stripeSession(sessionId);
 if(session.status==='open'){
  const expired=await expireStripeSession(sessionId);
  if(expired.status!=='expired')throw fail('舊付款連結未能失效，請勿重複付款',409);
 }else if(session.status!=='expired')throw fail('付款已提交或正在處理，請先確認結果',409);
 const updated=await sql`UPDATE tsun_stripe_orders SET status='cancelled'
 WHERE merchant_order_id=${order.id} AND status='pending' AND stripe_session_id=${sessionId}
 RETURNING merchant_order_id`;
 if(!updated.length)throw fail('付款狀態已變更，請重新核對',409);
 return {retired:true};
}
async function complete(lease,session){const rows=await lease.sql`UPDATE tsun_stripe_orders SET stripe_session_id=${session.id},stripe_session_url=${session.url},status='pending'
 WHERE merchant_order_id=${lease.order.id} AND status='creating' AND stripe_session_id IS NULL RETURNING merchant_order_id`;if(!rows.length)throw fail('Stripe 付款链接保存失败，请联系客服核查，不要重复付款',503);}
async function abort(lease){if(!lease.fresh)return;if((lease.attempt||1)>1){await lease.sql`UPDATE tsun_stripe_orders SET status='cancelled' WHERE merchant_order_id=${lease.order.id} AND status='creating' AND stripe_session_id IS NULL`;return;}await lease.sql`DELETE FROM tsun_stripe_orders WHERE merchant_order_id=${lease.order.id} AND status='creating' AND stripe_session_id IS NULL`;}
async function enqueue(eventId,sessionId){if(!/^[A-Za-z0-9_-]{6,130}$/.test(eventId)||!/^cs_live_[A-Za-z0-9_]+$/.test(sessionId))throw fail('Stripe webhook identifiers invalid');const sql=db();await schema(sql);await sql`INSERT INTO tsun_stripe_webhook_events(event_id,stripe_session_id) VALUES(${eventId},${sessionId}) ON CONFLICT(event_id) DO NOTHING`;}
async function deliverStage(order,sessionId,stage,previews,attachments=[]){const sql=db();await schema(sql);await sql`INSERT INTO tsun_stripe_mail(merchant_order_id,stage) VALUES(${order.id},${stage}) ON CONFLICT DO NOTHING`;const [claim]=await sql`UPDATE tsun_stripe_mail SET processing_until=now()+interval '4 minutes'
 WHERE merchant_order_id=${order.id} AND stage=${stage} AND (processing_until IS NULL OR processing_until<now())
 AND (customer_sent=false OR (stage='order_completed' AND merchant_sent=false))
 RETURNING customer_sent,merchant_sent`;
 if(!claim){const [prior]=await sql`SELECT customer_sent,merchant_sent FROM tsun_stripe_mail WHERE merchant_order_id=${order.id} AND stage=${stage}`;return {customerSent:!!prior?.customer_sent,merchantSent:!!prior?.merchant_sent,alreadyHandled:true,pending:!prior?.customer_sent||(stage==='order_completed'&&!prior?.merchant_sent)};}
 try{const result=await deliver(stage,order,previews||[],attachments||[],{skipCustomer:claim.customer_sent,skipMerchant:claim.merchant_sent});const customerSent=!!(claim.customer_sent||result.customerSent),merchantSent=!!(claim.merchant_sent||result.merchantSent);await sql`UPDATE tsun_stripe_mail SET customer_sent=${customerSent},merchant_sent=${merchantSent},processing_until=NULL WHERE merchant_order_id=${order.id} AND stage=${stage}`;if(!customerSent||(stage==='order_completed'&&!merchantSent))throw fail('邮件未全部发送，请重试',503);return {customerSent,merchantSent};}
 catch(error){await sql`UPDATE tsun_stripe_mail SET processing_until=NULL WHERE merchant_order_id=${order.id} AND stage=${stage}`;throw error;}
}
async function processEvent(eventId){const sql=db();await schema(sql);const [evt]=await sql`UPDATE tsun_stripe_webhook_events SET processing_until=now()+interval '3 minutes',attempts=attempts+1
 WHERE event_id=${eventId} AND processed_at IS NULL AND (processing_until IS NULL OR processing_until<now()) RETURNING stripe_session_id`;if(!evt)return {status:'handled-or-busy'};
 try{const [row]=await sql`SELECT merchant_order_id,email,amount_cents,order_snapshot,previews,status FROM tsun_stripe_orders WHERE stripe_session_id=${evt.stripe_session_id}`;if(!row){await sql`UPDATE tsun_stripe_webhook_events SET processed_at=now(),processing_until=NULL,last_error='unmatched order' WHERE event_id=${eventId}`;return {status:'unmatched'};}
 const session=await stripeSession(evt.stripe_session_id);const total=verifyPaidSession(session,row.order_snapshot);if(total.totalCents!==row.amount_cents)throw fail('Stored Stripe amount mismatch',409);
 await ensureProductionQueue(sql);
 await sql`WITH paid AS (
  UPDATE tsun_stripe_orders SET status='paid',paid_at=COALESCE(paid_at,now()) WHERE stripe_session_id=${evt.stripe_session_id} RETURNING merchant_order_id
 )
  INSERT INTO tsun_production_jobs (merchant_order_id, payment_provider)
  SELECT merchant_order_id, 'stripe' FROM paid
  ON CONFLICT (merchant_order_id) DO NOTHING`;
 const order={...row.order_snapshot,paymentStatus:'paid',payMethod:'Stripe',paymentTransactionId:String(session.payment_intent||session.id),paidAmountCents:session.amount_total,paidAt:new Date((session.created||Math.floor(Date.now()/1000))*1000).toISOString()};
 await deliverStage(order,evt.stripe_session_id,'payment_received',row.previews||[]);
 await sql`UPDATE tsun_stripe_webhook_events SET processed_at=now(),processing_until=NULL,last_error=NULL WHERE event_id=${eventId}`;
 return {status:'processed'};
 }catch(error){await sql`UPDATE tsun_stripe_webhook_events SET processing_until=NULL,last_error=${String(error?.status||'processing_failed')} WHERE event_id=${eventId}`.catch(()=>{});console.error('[Stripe webhook] queued event failed',{status:Number(error?.status)||500});return {status:'retryable-error'};}
}
async function retryPending(limit=5){const sql=db();await schema(sql);const rows=await sql`SELECT event_id FROM tsun_stripe_webhook_events WHERE processed_at IS NULL AND (processing_until IS NULL OR processing_until<now()) ORDER BY received_at ASC LIMIT ${Math.min(5,Math.max(1,Number(limit)||5))}`;return Promise.all(rows.map(row=>processEvent(row.event_id)));}
module.exports={begin,complete,abort,expireForAlternateProvider,enqueue,processEvent,retryPending,deliverStage,db,schema};
