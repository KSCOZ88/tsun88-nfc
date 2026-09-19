const {cors,stripeSession,verifyPaidSession,verifyOrderToken,deliver}=require('../server/stripe-orders');
module.exports=async function handler(req,res){
  cors(req,res);if(req.method==='OPTIONS')return res.status(204).end();if(req.method!=='POST')return res.status(405).json({error:'仅支持 POST 请求'});
  try{
    const body=typeof req.body==='string'?JSON.parse(req.body):req.body||{};if(Buffer.byteLength(JSON.stringify(body))>9*1024*1024)return res.status(413).json({error:'订单图片过大'});
    if(!['payment_received','order_completed','in_production','shipped'].includes(body.type))return res.status(422).json({error:'邮件类型无效'});
    const session=await stripeSession(String(body.sessionId||'')),order=body.order||{};verifyPaidSession(session,order);if(!verifyOrderToken(String(body.orderToken||''),session,order))return res.status(401).json({error:'订单验证已失效'});
    order.paymentStatus='paid';order.paymentTransactionId=String(session.payment_intent||session.id);order.paidAmountCents=session.amount_total;
    const delivery=await deliver(body.type,order,body.previews||[],body.attachments||[]);return res.status(200).json(delivery);
  }catch(error){return res.status(422).json({error:error.message||'订单邮件发送失败'});}
};
