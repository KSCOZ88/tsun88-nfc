const {requireConfiguration,orderSummary,capturePayPalOrder,orderToken,sendError,parseBody,methods}=require('../server/paypal-orders');
module.exports=async function handler(req,res){
  if(methods(req,res,'POST'))return;
  try{
    const config=requireConfiguration(),body=parseBody(req),summary=orderSummary(body.order||{});
    const id=String(body.paypalOrderId||''),{capture}=await capturePayPalOrder(config,id,summary);
    return res.status(200).json({paid:true,paypalOrderId:id,captureId:capture.id,amountTotal:summary.totalCents,currency:'HKD',orderToken:orderToken(config,id,capture.id,summary)});
  }catch(error){return sendError(res,error);}
};
