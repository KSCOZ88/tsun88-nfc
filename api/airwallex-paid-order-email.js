const {configuration,parseBody,verifiedSession,verifyToken,handleError,method}=require('../server/airwallex-checkout');
const {deliver}=require('../server/airwallex-order-mailer');
module.exports=async function(req,res){if(method(req,res))return;
  try{
    const config=configuration(),body=parseBody(req);
    if(!['payment_received','order_completed','in_production','shipped'].includes(body.type))return res.status(422).json({error:'邮件状态无效'});
    const order=body.order||{},id=String(body.sessionId||''),{session,summary}=await verifiedSession(config,id,order);
    if(!verifyToken(config,String(body.orderToken||''),id,summary))return res.status(401).json({error:'付款认证信息无效'});
    order.paymentStatus='paid';order.payMethod='Airwallex';order.paymentTransactionId=session.payment_intent_id;order.paidAmountCents=summary.totalCents;
    if(config.mode==='sandbox')return res.status(200).json({demo:true,customerSent:false,merchantSent:false});
    return res.status(200).json(await deliver(body.type,order,body.previews||[],body.attachments||[]));
  }catch(error){return handleError(res,error);}
};
