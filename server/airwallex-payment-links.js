'use strict';
// Payment Links API adapter. Isolated from Checkout Sessions; not a frontend drop-in.
const {auth,configuration,summary}=require('./airwallex-checkout');
const {timingSafeEqual}=require('node:crypto');
const fail=(message,status=502)=>Object.assign(new Error(message),{status});
const fields=s=>({order_id:s.orderId,order_binding:s.binding,item_count:String(s.itemCount),decor_count:String(s.decorCount),total_cents:String(s.totalCents)});
const match=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y);};
const validUrl=value=>{try{const url=new URL(value);return url.protocol==='https:'&&(url.hostname==='pay.airwallex.com'||url.hostname==='www.airwallex.com'||url.hostname==='airwallex.com'||url.hostname.endsWith('.airwallex.com'))&&url.pathname.length>1;}catch{return false;}};
async function call(config,path,method='GET',payload){
 const token=await auth(config);
 let response;
 try{response=await fetch(config.base+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','x-api-version':'2025-02-14'},...(payload?{body:JSON.stringify(payload)}:{}),signal:AbortSignal.timeout(12000)});}catch{throw fail('Airwallex payment service unavailable',503);}
 const data=await response.json().catch(()=>({}));
 if(!response.ok){
  const code=String(data.code||data.error?.code||'unknown').slice(0,80).replace(/[^a-zA-Z0-9_.-]/g,'');
  console.error('[Airwallex payment links]',{status:response.status,code});
  if(response.status===401)throw fail('Airwallex authentication failed',503);
  if(response.status===403)throw fail('Payment Links API permission or product access denied',503);
  if(response.status===400||response.status===422)throw fail('Payment Link request rejected: check merchant capabilities',503);
  throw fail('Airwallex Payment Links request failed',502);
 }
 return data;
}
async function create(order){
 const cfg=configuration(),s=summary(order);
 const data=await call(cfg,'/api/v1/pa/payment_links/create','POST',{
  title:'8TSUN8 Order '+s.orderId,description:'8TSUN8 NFC Pet Tag',amount:s.totalCents/100,currency:'HKD',reusable:false,reference:s.orderId,metadata:fields(s),
  collectable_shopper_info:{message:false,reference:false,shipping_address:false}
 });
 if(typeof data.id!=='string'||!/^[a-zA-Z0-9_-]{6,120}$/.test(data.id)||!validUrl(data.url))throw fail('Invalid payment link response');
 return {paymentLinkId:data.id,url:data.url,amountCents:s.totalCents,currency:'HKD',mode:cfg.mode};
}
async function verify(linkId,order){
 const cfg=configuration(),s=summary(order);
 if(typeof linkId!=='string'||!/^[a-zA-Z0-9_-]{6,120}$/.test(linkId))throw fail('Invalid payment link id',422);
 const data=await call(cfg,'/api/v1/pa/payment_links/'+encodeURIComponent(linkId));
 if(data.status!=='PAID'||data.reusable!==false||!data.latest_successful_payment_intent_id||Number(data.successful_payment_intent_count)<1)throw fail('Payment is not confirmed',409);
 checkOrder(data,s);
 return {paid:true,paymentLinkId:linkId,paymentIntentId:data.latest_successful_payment_intent_id,amountCents:s.totalCents,currency:'HKD',mode:cfg.mode};
}
function checkOrder(data,s){
 if(!match(data.reference,s.orderId)||String(data.currency||'').toUpperCase()!=='HKD'||Math.round(Number(data.amount)*100)!==s.totalCents)throw fail('Payment amount or reference mismatch',409);
 for(const [key,value] of Object.entries(fields(s))){if(!match(data.metadata?.[key]??'',value))throw fail('Payment order metadata mismatch',409);}
}

async function retire(id,s){
 const cfg=configuration();
 if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{6,120}$/.test(id))throw fail('Invalid payment link id',422);
 const path='/api/v1/pa/payment_links/'+encodeURIComponent(id);
 const checked=async()=>{
  const link=await call(cfg,path);
  if(link.id!==id||link.reusable!==false)throw fail('Payment link does not match this order',409);
  checkOrder(link,s);
  return link;
 };
 const hasPayment=link=>link.status==='PAID'||Boolean(link.latest_successful_payment_intent_id)||Number(link.successful_payment_intent_count)>0;
 let link=await checked();
 if(hasPayment(link))return {paid:true,id};
 if(link.active===true){
  // Re-read after deactivation so a payment completed in another tab is picked up.
  let deactivationError;
  try{await call(cfg,path+'/deactivate','POST');}catch(error){deactivationError=error;}
  link=await checked();
  if(deactivationError&&link.active!==false&&!hasPayment(link))throw deactivationError;
 }
 if(hasPayment(link))return {paid:true,id};
 if(link.active!==false||!['UNPAID','EXPIRED'].includes(link.status))return {pending:true,id};
 return null;
}

module.exports={create,verify,retire};
