const stripe=require('../server/stripe-orders');
const {waitUntil}=require('@vercel/functions');

function readRawBody(req,maxBytes=250000){
  return new Promise((resolve,reject)=>{
    const chunks=[];let size=0,tooLarge=false;
    req.on('data',chunk=>{
      size+=chunk.length;
      if(size>maxBytes){tooLarge=true;return;}
      if(!tooLarge)chunks.push(chunk);
    });
    req.on('end',()=>{
      if(tooLarge){reject(Object.assign(new Error('Webhook payload too large'),{status:413}));return;}
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error',reject);
  });
}

async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method==='GET'){
    const secret=process.env.CRON_SECRET||'';
    if(secret&&req.headers.authorization==='Bearer '+secret){
      waitUntil(stripe.dailyReconciliation().catch(error=>{
        console.error('[Stripe cron] reconciliation failed',{status:Number(error?.status)||500});
      }));
      return res.status(200).json({retry:'scheduled'});
    }
    return res.status(200).json({webhook:'reachable',accepts:'POST'});
  }
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  let raw;
  try{raw=await readRawBody(req);}catch(error){return res.status(error.status||400).json({error:'Invalid webhook payload'});}
  let config;
  try{config=stripe.liveConfig(true);}catch(error){return res.status(error.status||503).json({error:'Stripe Live webhook is not configured'});}
  const signature=req.headers['stripe-signature']||'';
  if(!stripe.verifyWebhookSignature(raw,String(signature),config.webhookSecret)){
    console.warn('[Stripe webhook] signature verification failed');
    return res.status(400).json({error:'Invalid Stripe signature'});
  }
  let event;
  try{event=JSON.parse(raw);}catch{return res.status(400).json({error:'Invalid JSON'});}
  if(event.livemode!==true)return res.status(400).json({error:'Live events only'});
  const supported=new Set([
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded',
    'checkout.session.async_payment_failed',
    'checkout.session.expired'
  ]);
  if(!supported.has(event.type))return res.status(200).json({received:true,ignored:true});
  const sessionId=String(event.data?.object?.id||'');
  const eventId=String(event.id||'');
  if(!/^cs_[A-Za-z0-9_]+$/.test(sessionId)||!/^evt_[A-Za-z0-9_]+$/.test(eventId)){
    return res.status(422).json({error:'Invalid Stripe event identifiers'});
  }
  try{
    await stripe.enqueue(eventId,sessionId,event.type);
    waitUntil(Promise.resolve().then(()=>stripe.processEvent(eventId)).catch(error=>{
      console.error('[Stripe webhook] deferred processing failed',{status:Number(error?.status)||500});
    }));
    return res.status(200).json({received:true});
  }catch(error){
    console.error('[Stripe webhook] queue unavailable',{status:Number(error?.status)||500});
    return res.status(503).json({error:'Temporary webhook processing error'});
  }
}
handler.config={api:{bodyParser:false}};
module.exports=handler;
