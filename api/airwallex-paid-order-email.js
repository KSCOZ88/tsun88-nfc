const {configuration,parseBody,summary,verifyToken,handleError,method}=require('../server/airwallex-checkout');
const {verify}=require('../server/airwallex-payment-links');
const {deliver}=require('../server/airwallex-order-mailer');
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
   return res.status(200).json(await deliver(body.type,order,body.previews||[],body.attachments||[]));
 }catch(error){return handleError(res,error);}
};
