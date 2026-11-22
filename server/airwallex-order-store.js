'use strict';
// Persist a minimal server-side snapshot before sending customers to Airwallex.
// No API secrets, payment credentials or uploaded image base64 are saved.
const {ensureProductionQueue,scheduleProductionSync}=require('./production-queue');
const {neon}=require('@neondatabase/serverless');
const {summary}=require('./airwallex-checkout');
const fail=(message,status=409)=>Object.assign(new Error(message),{status});
let schemaPromise;
function db(){
 if(!process.env.DATABASE_URL)throw fail('订单数据库未配置',503);
 return neon(process.env.DATABASE_URL);
}
async function schema(sql){
 if(!schemaPromise)schemaPromise=sql`CREATE TABLE IF NOT EXISTS tsun_airwallex_orders (
 merchant_order_id TEXT PRIMARY KEY,
 email TEXT NOT NULL,
 amount_cents INTEGER NOT NULL,
 order_binding TEXT NOT NULL,
 order_snapshot JSONB NOT NULL,
 payment_link_id TEXT UNIQUE,
 payment_link_url TEXT,
 status TEXT NOT NULL DEFAULT 'creating',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 paid_at TIMESTAMPTZ
 )`.catch(err=>{schemaPromise=null;throw err;});
 return schemaPromise;
}
function safeSnapshot(order){
 const result=JSON.parse(JSON.stringify(order));
 function strip(value,depth=0){
  if(!value||typeof value!=='object'||depth>14)return;
  for(const [key,v] of Object.entries(value)){
   if(typeof v==='string'&&(v.startsWith('data:image/')||v.length>12000))value[key]='[image not stored]';
   else if(typeof v==='object')strip(v,depth+1);
  }
 }
 strip(result);
 if(Buffer.byteLength(JSON.stringify(result))>220000)throw fail('订单内容过大',413);
 return result;
}
async function begin(order){
 const s=summary(order),sql=db();await schema(sql);
 const snapshot=safeSnapshot(order);
 const inserted=await sql`INSERT INTO tsun_airwallex_orders
 (merchant_order_id,email,amount_cents,order_binding,order_snapshot)
 VALUES (${s.orderId},${s.email},${s.totalCents},${s.binding},${JSON.stringify(snapshot)}::jsonb)
 ON CONFLICT DO NOTHING RETURNING merchant_order_id`;
 if(inserted.length)return {s,sql,fresh:true};
 const [existing]=await sql`SELECT merchant_order_id,email,amount_cents,order_binding,payment_link_id,payment_link_url,status
 FROM tsun_airwallex_orders WHERE merchant_order_id=${s.orderId}`;
 if(!existing||existing.order_binding!==s.binding||existing.amount_cents!==s.totalCents||existing.email.toLowerCase()!==s.email.toLowerCase())throw fail('该订单的金额或邮箱已改变，请联系商户',409);
 if(existing.payment_link_id&&existing.payment_link_url&&existing.status==='pending')
  return {s,sql,fresh:false,existing};
 if(existing.status==='paid')throw fail('该订单已付款，请勿重复付款',409);
 throw fail('订单付款链接正在处理，请勿重复提交',409);
}
async function complete(lease,link){
 const {sql,s}=lease;
 const rows=await sql`UPDATE tsun_airwallex_orders SET payment_link_id=${link.paymentLinkId},
 payment_link_url=${link.url},status='pending'
 WHERE merchant_order_id=${s.orderId} AND payment_link_id IS NULL AND status='creating'
 RETURNING merchant_order_id`;
 if(!rows.length)throw fail('订单链接保存失败，请联系客服核查，不要再次付款',503);
}
async function abort(lease){
 if(!lease.fresh)return;
 const {sql,s}=lease;
 await sql`DELETE FROM tsun_airwallex_orders WHERE merchant_order_id=${s.orderId}
 AND status='creating' AND payment_link_id IS NULL`;
}
async function recordPaid(order,linkId){
 const summaryData=summary(order),sql=db();await schema(sql);
 const [stored]=await sql`SELECT payment_link_id,order_binding,amount_cents,status FROM tsun_airwallex_orders WHERE merchant_order_id=${summaryData.orderId}`;
 if(!stored)return {legacy:true};
 if(stored.payment_link_id!==linkId||stored.order_binding!==summaryData.binding||stored.amount_cents!==summaryData.totalCents)
  throw fail('付款链接与原订单记录不匹配，请联系商户核查',409);
 await ensureProductionQueue(sql);
 await sql`WITH paid AS (
  UPDATE tsun_airwallex_orders SET status='paid',paid_at=COALESCE(paid_at,now())
 WHERE merchant_order_id=${summaryData.orderId} AND payment_link_id=${linkId} RETURNING merchant_order_id, paid_at
 )
  INSERT INTO tsun_production_outbox (merchant_order_id, payment_provider)
  SELECT merchant_order_id, 'airwallex' FROM paid WHERE ${process.env.VERCEL_ENV==='production'} AND paid_at = now()
  ON CONFLICT (merchant_order_id) DO NOTHING`;
 scheduleProductionSync(sql,summaryData.orderId);
 return {legacy:false};
}
module.exports={begin,complete,abort,recordPaid,db,schema};
