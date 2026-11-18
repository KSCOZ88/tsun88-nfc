// The old client sends sessionId; during Payment Links testing this carries a link ID.
const {configuration,parseBody,summary,makeToken,handleError,method}=require('../server/airwallex-checkout');
const {verify}=require('../server/airwallex-payment-links');
const {recordPaid}=require('../server/airwallex-order-store');
const {enqueue,processEvent}=require('../server/airwallex-webhook-queue');
const {queueConfirmedReceipt}=require('../server/airwallex-confirmation-notifier');
const {waitUntil}=require('@vercel/functions');
module.exports=async function(req,res){
 if(method(req,res))return;
 try{
   if(process.env.AIRWALLEX_PAYMENT_LINKS_ENABLED!=='true')return res.status(503).json({error:'Airwallex Payment Links are not enabled for this environment yet'});
   const body=parseBody(req),id=String(body.sessionId||body.paymentLinkId||'');
   const confirmation=await verify(id,body.order||{});
   const saved=await recordPaid(body.order,id);
   // A verified on-site payment should start the durable email worker even if
   // Airwallex's webhook is delayed or the buyer closes their browser.
   // Legacy links without a persisted order are deliberately excluded.
   if(!saved.legacy){
     try{
       await queueConfirmedReceipt(id,true,{enqueue,processEvent,waitUntil});
       console.info('[Airwallex confirmation] receipt queued');
     }catch(error){
       // Do not tell an already-paid customer their payment failed because
       // notification queuing is temporarily unavailable. Daily retry covers
       // paid orders with missing delivery records.
       console.error('[Airwallex confirmation] receipt queue failed',{status:Number(error?.status)||500});
     }
   }
   const config=configuration(),s=summary(body.order);
   return res.status(200).json({
    paid:true,sessionId:id,paymentLinkId:id,paymentIntentId:confirmation.paymentIntentId,
    orderToken:makeToken(config,id,s),amountTotal:s.totalCents,currency:'hkd',mode:config.mode,kind:'payment_link'
   });
 }catch(error){return handleError(res,error);}
};
