const {createHmac,timingSafeEqual}=require('node:crypto');
function rawBody(req){return new Promise((resolve,reject)=>{const chunks=[];req.on('data',chunk=>chunks.push(Buffer.from(chunk)));req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',reject);});}
module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','no-store');if(req.method!=='POST')return res.status(405).end();
  try{
    const secret=process.env.STRIPE_WEBHOOK_SECRET||'';if(!/^whsec_/.test(secret))return res.status(503).json({error:'Webhook 密钥尚未配置'});
    const raw=await rawBody(req),header=String(req.headers['stripe-signature']||''),parts=Object.fromEntries(header.split(',').map(part=>part.split('='))),stamp=parts.t,signature=parts.v1;
    if(!/^\d+$/.test(stamp)||!/[a-f0-9]{64}/.test(signature||'')||Math.abs(Date.now()/1000-Number(stamp))>300)return res.status(400).json({error:'Stripe 签名无效'});
    const expected=createHmac('sha256',secret).update(stamp+'.'+raw.toString('utf8')).digest(),actual=Buffer.from(signature,'hex');if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return res.status(400).json({error:'Stripe 签名无效'});
    const event=JSON.parse(raw.toString('utf8'));console.log('Stripe event verified',event.type,event.id);return res.status(200).json({received:true});
  }catch{return res.status(400).json({error:'Webhook 内容无效'});}
};
module.exports.config={api:{bodyParser:false}};
