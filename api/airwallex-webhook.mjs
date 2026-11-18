import {createHmac,timingSafeEqual} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {db,schema,recordPaid}=require('../server/airwallex-order-store');
const {verify}=require('../server/airwallex-payment-links');
const {sendGmail,GMAIL_ADDRESS}=require('../server/gmail-mailer');
const {escape}=require('../server/email-template');
const json=(obj,status=200)=>Response.json(obj,{status,headers:{'Cache-Control':'no-store'}});
function verifyHmac(secret,stamp,signature,raw){
 if(!secret||!/^[0-9]{13}$/.test(stamp)||!/^[a-f0-9]{64}$/i.test(signature))return false;
 if(Math.abs(Date.now()-Number(stamp))>5*60*1000)return false;
 const expected=createHmac('sha256',secret).update(stamp+raw).digest();
 const actual=Buffer.from(signature,'hex');
 return actual.length===expected.length&&timingSafeEqual(actual,expected);
}
function authenticate(request,raw){
 const stamp=request.headers.get('x-timestamp')||'';
 const signature=request.headers.get('x-signature')||'';
 // A live event must be signed with the configured webhook's secret.
 if(verifyHmac(process.env.AIRWALLEX_WEBHOOK_SECRET||'',stamp,signature,raw))return 'live';
 // Airwallex explicitly documents a separate signature key header for test events.
 // Such requests are acknowledged for connectivity testing only; never fulfill orders.
 const testKey=request.headers.get('client-secret-key')||'';
 if(testKey&&verifyHmac(testKey,stamp,signature,raw))return 'test';
 return null;
}
async function ensureMailTable(sql){
 await sql`CREATE TABLE IF NOT EXISTS tsun_airwallex_mail (
   merchant_order_id TEXT NOT NULL,
   payment_link_id TEXT NOT NULL,
   stage TEXT NOT NULL,
   customer_sent BOOLEAN NOT NULL DEFAULT false,
   merchant_sent BOOLEAN NOT NULL DEFAULT false,
   processing_until TIMESTAMPTZ,
   PRIMARY KEY (merchant_order_id,stage)
 )`;
}
async function sendReceipts(sql,row){
 const id=row.merchant_order_id,linkId=row.payment_link_id,stage='payment_received';
 const [known]=await sql`SELECT customer_sent,merchant_sent FROM tsun_airwallex_mail WHERE merchant_order_id=${id} AND stage=${stage}`;
 if(!known)await sql`INSERT INTO tsun_airwallex_mail (merchant_order_id,payment_link_id,stage) VALUES (${id},${linkId},${stage}) ON CONFLICT DO NOTHING`;
 const claimed=await sql`UPDATE tsun_airwallex_mail SET processing_until=now()+interval '4 minutes'
 WHERE merchant_order_id=${id} AND payment_link_id=${linkId} AND stage=${stage}
 AND (processing_until IS NULL OR processing_until<now())
 AND (customer_sent=false OR merchant_sent=false)
 RETURNING customer_sent,merchant_sent`;
 if(!claimed.length)return; // Already delivered, or another worker owns the claim.
 const status=claimed[0];
 const subject='8TSUN8 付款确认 / Payment received – '+id;
 const html='<p>您的 8TSUN8 订单已收到付款。</p><p>订单号：'+escape(id)+'</p><p>金额：HK$'+(row.amount_cents/100).toFixed(2)+'</p><p>请妥善保留此邮件；狗牌制作还需要完整订单及配送资料。</p>';
 try{
   if(!status.customer_sent){
     const sent=await sendGmail({to:[row.email],subject,html,text:'8TSUN8 payment received. Order '+id+'; HK$'+(row.amount_cents/100).toFixed(2)},'tsun-awx-receipt-'+id);
     if(!sent.sent)throw Error('Customer email was not accepted');
     await sql`UPDATE tsun_airwallex_mail SET customer_sent=true WHERE merchant_order_id=${id} AND stage=${stage} AND payment_link_id=${linkId}`;
   }
   if(!status.merchant_sent){
     const merchant=await sendGmail({to:[GMAIL_ADDRESS],subject:'8TSUN8 已付款订单｜'+id,html:'<h2>Airwallex 已确认付款</h2><p>订单：'+escape(id)+'</p><p>金额：HK$'+(row.amount_cents/100).toFixed(2)+'</p><p>客户邮箱：'+escape(row.email)+'</p><p>请在订单资料补全后制作狗牌。</p>',text:'Airwallex paid: '+id+'; HK$'+(row.amount_cents/100).toFixed(2)+'; '+row.email},'tsun-awx-merchant-'+id);
     if(!merchant.sent)throw Error('Merchant email was not accepted');
     await sql`UPDATE tsun_airwallex_mail SET merchant_sent=true WHERE merchant_order_id=${id} AND stage=${stage} AND payment_link_id=${linkId}`;
   }
 }finally{
   await sql`UPDATE tsun_airwallex_mail SET processing_until=NULL WHERE merchant_order_id=${id} AND stage=${stage} AND payment_link_id=${linkId}`;
 }
}
export async function POST(request){
 if(!process.env.AIRWALLEX_WEBHOOK_SECRET)return json({error:'webhook not configured'},503);
 const raw=await request.text();
 if(raw.length>250000)return json({error:'payload too large'},413);
 const auth=authenticate(request,raw);
 if(!auth)return json({error:'invalid signature'},401);
 if(auth==='test')return json({received:true,test:true});
 let event;
 try{event=JSON.parse(raw);}catch{return json({error:'invalid JSON'},400);}
 if(event.name!=='payment_link.paid')return json({received:true,ignored:true});
 const linkId=String(event.data?.object?.id||'');
 if(!/^[A-Za-z0-9_-]{6,120}$/.test(linkId))return json({error:'invalid link id'},422);
 try{
   const sql=db();await schema(sql);
   const [row]=await sql`SELECT merchant_order_id,email,amount_cents,payment_link_id,order_snapshot
     FROM tsun_airwallex_orders WHERE payment_link_id=${linkId}`;
   if(!row)return json({received:true,unmatched:true});
   if(!process.env.SMTP_APP_PASSWORD)return json({error:'mail service not configured'},503);
   await verify(linkId,row.order_snapshot);
   await recordPaid(row.order_snapshot,linkId);
   await ensureMailTable(sql);
   await sendReceipts(sql,row);
   return json({received:true});
 }catch(error){
   console.error('Airwallex webhook processing failed',String(error?.message||'Unknown error').slice(0,95));
   return json({error:'webhook processing unavailable'},502);
 }
}
