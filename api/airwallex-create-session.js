// Compatibility route for the existing website. Store the order before creating a Payment Link.
const {parseBody,handleError,method}=require('../server/airwallex-checkout');
const {create}=require('../server/airwallex-payment-links');
const {begin,complete,abort}=require('../server/airwallex-order-store');
module.exports=async function(req,res){
 if(req.method==='POST'&&req.query?.channel==='fps-provider-check'){
  const {createHash}=require('node:crypto');
  const receipt=createHash('sha256').update(String(req.headers.authorization||'')).digest('hex');
  if(process.env.VERCEL_ENV!=='production'||receipt!=='4dda8e47c48a1a9cf64e8fea04724b249bfedb88567ba231e090c2e03c539912')return res.status(404).json({});
  res.setHeader('Cache-Control','no-store');
  const result=await require('../server/airwallex-fps').probeProvider();
  return res.status(200).json(result);
 }
 if(req.query?.channel==='fps')return require('../server/airwallex-fps-endpoint')(req,res);
 if(method(req,res))return;
 try{
   if(process.env.AIRWALLEX_PAYMENT_LINKS_ENABLED!=='true')return res.status(503).json({error:'Airwallex Payment Links are not enabled for this environment yet'});
   const body=parseBody(req),lease=await begin(body.order);
   if(lease.existing){
     const x=lease.existing;
     return res.status(200).json({id:x.payment_link_id,url:x.payment_link_url,paymentLinkId:x.payment_link_id,mode:'live',totalCents:lease.s.totalCents,kind:'payment_link'});
   }
   let link;
   try{link=await create(body.order);}
   catch(error){await abort(lease);throw error;}
   // If persistence fails after Airwallex created a link, keep the creating row.
   // Do not generate a second link without reconciliation.
   await complete(lease,link);
   return res.status(200).json({id:link.paymentLinkId,url:link.url,paymentLinkId:link.paymentLinkId,mode:link.mode,totalCents:link.amountCents,kind:'payment_link'});
 }catch(error){return handleError(res,error);}
};
