'use strict';

const qrcode=require('qrcode-generator');
const {parseBody,handleError,method}=require('./airwallex-checkout');
const {prepare,cancel,supportsQr}=require('./airwallex-fps');

function enabled(type){
 return process.env.VERCEL_ENV==='production'&&
  process.env.AIRWALLEX_PAYMENT_LINKS_ENABLED==='true'&&
  supportsQr(type)&&process.env['AIRWALLEX_DIRECT_'+type.toUpperCase()+'_ENABLED']!=='false';
}

module.exports=async function(req,res){
 res.setHeader('Cache-Control','private, no-store');
 const type=req.query?.paymentMethod??'fps';
 if(req.method==='GET')return res.status(200).json({enabled:enabled(type)});
 if(method(req,res))return;
 if(req.headers.origin!=='https://www.8tsun8.com'&&req.headers.origin!=='https://8tsun8.com'){
  return res.status(403).json({error:'Open the 8TSUN8 checkout to pay.'});
 }
 try{
  const {order,action}=parseBody(req);
  if(action==='cancel'&&process.env.VERCEL_ENV==='production')return res.status(200).json(await cancel(order,type));
  if(!enabled(type))return res.status(403).json({error:'Direct QR payment is unavailable.'});
  const {text,...result}=await prepare(order,type);
  if(text){
   const code=qrcode(0,'M');
   code.addData(text);
   code.make();
   result.qrImage=code.createDataURL(5,20);
  }
  return res.status(200).json(result);
 }catch(error){return handleError(res,error);}
};
