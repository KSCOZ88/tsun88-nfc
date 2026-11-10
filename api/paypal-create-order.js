const {requireConfiguration,createPayPalOrder,sendError,parseBody,methods}=require('../server/paypal-orders');
module.exports=async function handler(req,res){
  if(methods(req,res,'POST'))return;
  try{
    const config=requireConfiguration(),body=parseBody(req);
    const result=await createPayPalOrder(config,{orderId:body.orderId,customerEmail:body.customerEmail,itemCount:body.itemCount,decorCount:body.decorCount});
    if(!result.id)return res.status(502).json({error:'PayPal 未返回订单编号'});
    return res.status(200).json({id:result.id,mode:config.mode});
  }catch(error){return sendError(res,error);}
};
