const stripe=require('../server/stripe-orders');
const {waitUntil}=require('@vercel/functions');
module.exports=async function(req,res){
  if(!stripe.post(req,res))return;
  try{
    const body=stripe.parseBody(req);
    const sessionId=String(body.sessionId||body.stripeSessionId||'');
    const result=await stripe.confirm(sessionId,body.order);
    waitUntil(Promise.resolve().then(()=>stripe.processEvent(result.eventId)).catch(error=>{
      console.error('[Stripe confirmation] deferred processing failed',{status:Number(error?.status)||500});
    }));
    return res.status(200).json(result);
  }catch(error){return stripe.handleError(res,error);}
};
