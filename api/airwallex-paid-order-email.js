const {publishPaidReview} = require('../server/order-review');
const {configuration,parseBody,summary,verifyToken,handleError,method}=require('../server/airwallex-checkout');
const {verify}=require('../server/airwallex-payment-links');
const {deliver}=require('../server/airwallex-order-mailer');
const {deliveryOutcome}=require('../server/airwallex-mail-status');
const {neon}=require('@neondatabase/serverless');
let schemaPromise;
function db(){
 if(!process.env.DATABASE_URL)throw Object.assign(new Error('订单数据库未配置'),{status:503});
 return neon(process.env.DATABASE_URL);
}
async function schema(sql){
 if(!schemaPromise)schemaPromise=sql`CREATE TABLE IF NOT EXISTS tsun_airwallex_mail (
   merchant_order_id TEXT NOT NULL,
   payment_link_id TEXT NOT NULL,
   stage TEXT NOT NULL,
   customer_sent BOOLEAN NOT NULL DEFAULT false,
   merchant_sent BOOLEAN NOT NULL DEFAULT false,
   processing_until TIMESTAMPTZ,
   PRIMARY KEY (merchant_order_id,stage)
 )`.catch(err=>{schemaPromise=null;throw err;});
 return schemaPromise;
}
module.exports=async function(req,res){
 if(method(req,res))return;
 try{
   if(process.env.AIRWALLEX_PAYMENT_LINKS_ENABLED!=='true')return res.status(503).json({error:'Airwallex Payment Links are not enabled for this environment yet'});
   const body=parseBody(req);
   if(!['payment_received','order_completed','in_production','shipped'].includes(body.type))return res.status(422).json({error:'邮件状态无效'});
   const order=body.order||{},id=String(body.sessionId||body.paymentLinkId||'');
   const confirmed=await verify(id,order);
   const config=configuration(),s=summary(order);
   if(!verifyToken(config,String(body.orderToken||''),id,s))return res.status(401).json({error:'付款认证信息无效'});
   order.paymentStatus='paid';order.payMethod='Airwallex';order.paymentTransactionId=confirmed.paymentIntentId;order.paidAmountCents=s.totalCents;
   if(config.mode==='sandbox')return res.status(200).json({demo:true,customerSent:false,merchantSent:false});
   if(body.type==='order_completed')await publishPaidReview('airwallex',order,body.previews);
   if(!process.env.SMTP_APP_PASSWORD)return res.status(503).json({error:'邮件服务尚未设置'});
   const sql=db();await schema(sql);
   await sql`INSERT INTO tsun_airwallex_mail (merchant_order_id,payment_link_id,stage)
      VALUES (${s.orderId},${id},${body.type}) ON CONFLICT DO NOTHING`;
   const claimed=await sql`UPDATE tsun_airwallex_mail SET processing_until=now()+interval '4 minutes'
      WHERE merchant_order_id=${s.orderId} AND stage=${body.type} AND payment_link_id=${id}
      AND (processing_until IS NULL OR processing_until<now())
      AND (customer_sent=false OR (stage='order_completed' AND merchant_sent=false))
      RETURNING customer_sent,merchant_sent`;
   if(!claimed.length){
     const [prior]=await sql`SELECT customer_sent,merchant_sent,payment_link_id FROM tsun_airwallex_mail
       WHERE merchant_order_id=${s.orderId} AND stage=${body.type}`;
     if(!prior||prior.payment_link_id!==id)return res.status(409).json({error:'订单已有另一笔付款记录，请联系商户核实'});
     return res.status(200).json({customerSent:prior.customer_sent,merchantSent:prior.merchant_sent,alreadyHandled:true,pending:!prior.customer_sent||(body.type==='order_completed'&&!prior.merchant_sent)});
   }
   const previous=claimed[0];
   try{
     const result=await deliver(body.type,order,body.previews||[],body.attachments||[],{skipCustomer:previous.customer_sent,skipMerchant:previous.merchant_sent});
     const {customerSent,merchantSent,complete}=deliveryOutcome(body.type,previous,result);
     await sql`UPDATE tsun_airwallex_mail SET customer_sent=${customerSent},merchant_sent=${merchantSent},processing_until=NULL
       WHERE merchant_order_id=${s.orderId} AND stage=${body.type} AND payment_link_id=${id}`;
     return res.status(complete?200:502).json({customerSent,merchantSent,error:complete?undefined:'邮件未全部发送，请重试'});
   }catch(error){
     await sql`UPDATE tsun_airwallex_mail SET processing_until=NULL
       WHERE merchant_order_id=${s.orderId} AND stage=${body.type} AND payment_link_id=${id}`;
     throw error;
   }
 }catch(error){return handleError(res,error);}
};
