// The old client sends sessionId; during Payment Links testing this carries a link ID.
const {configuration,parseBody,summary,makeToken,handleError,method}=require('../server/airwallex-checkout');
const {verify}=require('../server/airwallex-payment-links');
module.exports=async function(req,res){
 if(method(req,res))return;
 try{
   if(process.env.AIRWALLEX_PAYMENT_LINKS_ENABLED!=='true')return res.status(503).json({error:'Airwallex Payment Links are not enabled for this environment yet'});
   const body=parseBody(req),id=String(body.sessionId||body.paymentLinkId||'');
   const confirmation=await verify(id,body.order||{});
   const config=configuration(),s=summary(body.order);
   return res.status(200).json({
    paid:true,sessionId:id,paymentLinkId:id,paymentIntentId:confirmation.paymentIntentId,
    orderToken:makeToken(config,id,s),amountTotal:s.totalCents,currency:'hkd',mode:config.mode,kind:'payment_link'
   });
 }catch(error){return handleError(res,error);}
};
