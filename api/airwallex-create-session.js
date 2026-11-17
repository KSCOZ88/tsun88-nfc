// Compatibility route for the existing website. Store the order before creating a Payment Link.
const {parseBody,handleError,method}=require('../server/airwallex-checkout');
const {create}=require('../server/airwallex-payment-links');
const {begin,complete,abort}=require('../server/airwallex-order-store');
module.exports=async function(req,res){
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
