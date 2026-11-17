// Compatibility route for the existing website. Payment Links rollout is deliberately gated.
const {parseBody,handleError,method}=require('../server/airwallex-checkout');
const {create}=require('../server/airwallex-payment-links');
module.exports=async function(req,res){
 if(method(req,res))return;
 try{
   if(process.env.AIRWALLEX_PAYMENT_LINKS_ENABLED!=='true')return res.status(503).json({error:'Airwallex Payment Links are not enabled for this environment yet'});
   const body=parseBody(req),link=await create(body.order);
   return res.status(200).json({id:link.paymentLinkId,url:link.url,paymentLinkId:link.paymentLinkId,mode:link.mode,totalCents:link.amountCents,kind:'payment_link'});
 }catch(error){return handleError(res,error);}
};
