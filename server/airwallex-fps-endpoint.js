'use strict';

const qrcode=require('qrcode-generator');
const {parseBody,handleError,method}=require('./airwallex-checkout');
const {prepare}=require('./airwallex-fps');

function enabled(){
 return process.env.VERCEL_ENV==='production'&&
  process.env.AIRWALLEX_PAYMENT_LINKS_ENABLED==='true'&&
  process.env.AIRWALLEX_DIRECT_FPS_ENABLED!=='false';
}

module.exports=async function(req,res){
 res.setHeader('Cache-Control','private, no-store');
 if(req.method==='GET')return res.status(200).json({enabled:enabled()});
 if(method(req,res))return;
 if(!enabled())return res.status(403).json({error:'Direct FPS payment is unavailable.'});
 if(req.headers.origin!=='https://www.8tsun8.com'&&req.headers.origin!=='https://8tsun8.com'){
  return res.status(403).json({error:'Open the 8TSUN8 checkout to pay.'});
 }
 try{
  const {order}=parseBody(req);
  const {text,...result}=await prepare(order);
  if(text){
   const code=qrcode(0,'M');
   code.addData(text);
   code.make();
   result.qrImage=code.createDataURL(5,20);
  }
  return res.status(200).json(result);
 }catch(error){return handleError(res,error);}
};
