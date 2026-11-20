'use strict';
const {neon}=require('@neondatabase/serverless');
const {createHash}=require('node:crypto');
const {sendGmail}=require('./gmail-mailer');
const {fail,stripeSession,verifyPaidSession,deliver}=require('./stripe-orders');
let schemaPromise;
function db(){if(!process.env.DATABASE_URL)throw fail('订单数据库未配置',503);return neon(process.env.DATABASE_URL);}
async function schema(sql){if(!schemaPromise)schemaPromise=(async()=>{
 await sql`CREATE TABLE IF NOT EXISTS tsun_stripe_orders (
  merchant_order_id TEXT PRIMARY KEY,email TEXT NOT NULL,amount_cents INTEGER NOT NULL,
  order_binding TEXT NOT NULL,order_snapshot JSONB NOT NULL,previews JSONB NOT NULL DEFAULT '[]'::jsonb,
  stripe_session_id TEXT UNIQUE,stripe_session_url TEXT,payment_method TEXT,status TEXT NOT NULL DEFAULT 'creating',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),paid_at TIMESTAMPTZ
 )`;
 await sql`ALTER TABLE tsun_stripe_orders ADD COLUMN IF NOT EXISTS payment_method TEXT`;
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
async function begin(order,previews,total,paymentMethod='card'){const sql=db();await schema(sql);const s=snapshot(order),b=binding(order,total);const inserted=await sql`INSERT INTO tsun_stripe_orders(merchant_order_id,email,amount_cents,order_binding,order_snapshot,previews,payment_method)
 VALUES(${order.id},${String(order.customerEmail).toLowerCase()},${total.totalCents},${b},${JSON.stringify(s)}::jsonb,${JSON.stringify(previews||[])}::jsonb,${paymentMethod})
 ON CONFLICT DO NOTHING RETURNING merchant_order_id`;
 if(inserted.length)return {sql,order,total,fresh:true};
 const [existing]=await sql`SELECT email,amount_cents,order_binding,stripe_session_id,stripe_session_url,payment_method,status FROM tsun_stripe_orders WHERE merchant_order_id=${order.id}`;
 if(!existing||existing.order_binding!==b||existing.amount_cents!==total.totalCents||existing.email!==String(order.customerEmail).toLowerCase())throw fail('订单资料或金额已改变，请重新创建订单',409);
 if(existing.stripe_session_id&&existing.stripe_session_url&&existing.status==='pending'){
  if(existing.payment_method&&existing.payment_method!==paymentMethod)throw fail('此订单已有其他付款方式的 Stripe 链接，请勿重复付款',409);
  if(!existing.payment_method&&paymentMethod!=='card')throw fail('此订单已有旧版 Stripe 付款链接，暂不能切换付款方式',409);
  return {sql,order,total,existing};
 }
 if(existing.status==='paid')throw fail('该订单已付款，请勿重复付款',409);
 throw fail('Stripe 付款链接正在创建，请稍后刷新订单',409);
}
async function complete(lease,session){const rows=await lease.sql`UPDATE tsun_stripe_orders SET stripe_session_id=${session.id},stripe_session_url=${session.url},status='pending'
 WHERE merchant_order_id=${lease.order.id} AND status='creating' AND stripe_session_id IS NULL RETURNING merchant_order_id`;if(!rows.length)throw fail('Stripe 付款链接保存失败，请联系客服核查，不要重复付款',503);}
async function abort(lease){if(!lease.fresh)return;await lease.sql`DELETE FROM tsun_stripe_orders WHERE merchant_order_id=${lease.order.id} AND status='creating' AND stripe_session_id IS NULL`;}
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
 await sql`UPDATE tsun_stripe_orders SET status='paid',paid_at=COALESCE(paid_at,now()) WHERE stripe_session_id=${evt.stripe_session_id}`;
 const order={...row.order_snapshot,paymentStatus:'paid',payMethod:'Stripe',paymentTransactionId:String(session.payment_intent||session.id),paidAmountCents:session.amount_total,paidAt:new Date((session.created||Math.floor(Date.now()/1000))*1000).toISOString()};
 await deliverStage(order,evt.stripe_session_id,'payment_received',row.previews||[]);
 await sql`UPDATE tsun_stripe_webhook_events SET processed_at=now(),processing_until=NULL,last_error=NULL WHERE event_id=${eventId}`;
 return {status:'processed'};
 }catch(error){await sql`UPDATE tsun_stripe_webhook_events SET processing_until=NULL,last_error=${String(error?.status||'processing_failed')} WHERE event_id=${eventId}`.catch(()=>{});console.error('[Stripe webhook] queued event failed',{status:Number(error?.status)||500});return {status:'retryable-error'};}
}
async function retryPending(limit=5){const sql=db();await schema(sql);const rows=await sql`SELECT event_id FROM tsun_stripe_webhook_events WHERE processed_at IS NULL AND (processing_until IS NULL OR processing_until<now()) ORDER BY received_at ASC LIMIT ${Math.min(5,Math.max(1,Number(limit)||5))}`;return Promise.all(rows.map(row=>processEvent(row.event_id)));}
module.exports={begin,complete,abort,enqueue,processEvent,retryPending,deliverStage,db,schema};
