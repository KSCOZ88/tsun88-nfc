const {publishPaidReview} = require('../server/order-review');
const p=require('../server/stripe-orders');
const store=require('../server/stripe-order-store');
const {savePaidProduction}=require('../server/paid-production-assets');
module.exports=async function(req,res){p.cors(req,res);if(req.method==='OPTIONS')return res.status(204).end();if(req.method!=='POST')return res.status(405).json({error:'仅支持 POST 请求'});try{const body=typeof req.body==='string'?JSON.parse(req.body):req.body||{};
if(Buffer.byteLength(JSON.stringify(body))>9*1024*1024)return res.status(413).json({error:'订单图片过大'});if(!['payment_received','order_completed','in_production','shipped'].includes(body.type))return res.status(422).json({error:'邮件类型无效'});const order=body.order||{};const session=await p.stripeSession(String(body.sessionId||''));p.verifyPaidSession(session,order);if(!p.verifyOrderToken(String(body.orderToken||''),session,order))return res.status(401).json({error:'订单验证已失效'});order.paymentStatus='paid';order.payMethod='Stripe';order.paymentTransactionId=String(session.payment_intent||session.id);order.paidAmountCents=session.amount_total;
if(body.type==='order_completed'){
 await publishPaidReview('stripe',order,body.previews);
 if(process.env.VERCEL_ENV==='production')await savePaidProduction('stripe',order,body.attachments);
}
const result=await store.deliverStage(order,session.id,body.type,body.previews||[],body.attachments||[]);return res.status(200).json(result);}catch(error){return res.status(Number(error.status)||422).json({error:error.message||'Stripe 订单邮件发送失败'});}};
