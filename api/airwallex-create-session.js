// Compatibility route for the existing website. Store the order before creating a Payment Link.
const {createSession,configuration,parseBody,handleError,method}=require('../server/airwallex-checkout');
const {create}=require('../server/airwallex-payment-links');
const {begin,complete,abort}=require('../server/airwallex-order-store');
module.exports=async function(req,res){
 if(req.query?.channel==='fps')return require('../server/airwallex-fps-endpoint')(req,res);
 if(method(req,res))return;
 try{
   if(process.env.AIRWALLEX_PAYMENT_LINKS_ENABLED!=='true')return res.status(503).json({error:'Airwallex Payment Links are not enabled for this environment yet'});
   const {order}=parseBody(req);
   if(req.query?.channel==='unionpay'){
     if(process.env.VERCEL_ENV!=='production'||!['https://www.8tsun8.com','https://8tsun8.com'].includes(req.headers.origin)){
       return res.status(403).json({error:'Open the 8TSUN8 checkout to pay.'});
     }
     const config=configuration(),lease=await begin(order,'unionpay');
     const existing=lease.existing;
     if(existing?.status==='paid')return res.status(200).json({id:existing.payment_link_id,kind:'unionpay',paid:true});
     const session=existing?.payment_link_id
       ? {id:existing.payment_link_id,url:existing.payment_link_url}
       : await createSession(config,req,order,lease.attempt);
     if(!existing?.payment_link_id)await complete(lease,{paymentLinkId:session.id,url:session.url});
     return res.status(200).json({...session,kind:'unionpay',totalCents:lease.s.totalCents});
   }
   const lease=await begin(order);
   if(lease.existing){
     const x=lease.existing;
     return res.status(200).json({id:x.payment_link_id,url:x.payment_link_url,paymentLinkId:x.payment_link_id,mode:'live',totalCents:lease.s.totalCents,kind:'payment_link'});
   }
   let link;
   try{link=await create(order);}
   catch(error){await abort(lease);throw error;}
   // If persistence fails after Airwallex created a link, keep the creating row.
   // Do not generate a second link without reconciliation.
   await complete(lease,link);
   return res.status(200).json({id:link.paymentLinkId,url:link.url,paymentLinkId:link.paymentLinkId,mode:link.mode,totalCents:link.amountCents,kind:'payment_link'});
 }catch(error){return handleError(res,error);}
};
