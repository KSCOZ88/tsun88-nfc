const {requireConfiguration,orderSummary,fetchPayPalOrder,verifyOrderDetails,verifyOrderToken,sendError,parseBody,methods}=require('../server/paypal-orders');
const {deliver}=require('../server/stripe-orders');
module.exports=async function handler(req,res){
  if(methods(req,res,'POST'))return;
  try{
    const config=requireConfiguration(),body=parseBody(req),order=body.order||{},summary=orderSummary(order),id=String(body.paypalOrderId||'');
    if(!['payment_received','order_completed','in_production','shipped'].includes(body.type))return res.status(422).json({error:'订单通知类型无效'});
    const {order:verified}=await fetchPayPalOrder(config,id),capture=verifyOrderDetails(verified,summary,{captured:true});
    if(!verifyOrderToken(config,String(body.orderToken||''),id,capture.id,summary))return res.status(401).json({error:'付款验证已失效'});
    order.paymentStatus='paid';order.payMethod='PayPal';order.paymentTransactionId=capture.id;order.paidAmountCents=summary.totalCents;
    // Never send real customer or merchant notifications from sandbox payment tests.
    if(config.mode==='sandbox')return res.status(200).json({demo:true,customerSent:false,merchantSent:false});
    const delivery=await deliver(body.type,order,body.previews||[],body.attachments||[]);
    return res.status(200).json(delivery);
  }catch(error){return sendError(res,error);}
};
