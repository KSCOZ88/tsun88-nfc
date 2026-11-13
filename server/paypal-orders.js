'use strict';
// PayPal Orders v2. Server-side prices; persistent order/capture state in Neon.
const {createHash,createHmac,timingSafeEqual}=require('node:crypto');
const {neon}=require('@neondatabase/serverless');
const {summary}=require('./airwallex-checkout');
const fail=(message,status=422)=>Object.assign(new Error(message),{status});
let schemaPromise;
function config(){
  const live=process.env.VERCEL_ENV==='production';
  const id=process.env[live?'PAYPAL_CLIENT_ID':'PAYPAL_SANDBOX_CLIENT_ID'];
  const secret=process.env[live?'PAYPAL_CLIENT_SECRET':'PAYPAL_SANDBOX_CLIENT_SECRET'];
  if(!id||!secret)throw fail(live?'PayPal 正式收款密钥未配置':'PayPal 测试环境密钥未配置',503);
  if(!process.env.DATABASE_URL)throw fail('订单数据库尚未连接',503);
  return {id,secret,live,base:live?'https://api-m.paypal.com':'https://api-m.sandbox.paypal.com'};
}
function db(){return neon(process.env.DATABASE_URL);}
async function schema(sql){
  if(!schemaPromise)schemaPromise=(async()=>{
    await sql`CREATE TABLE IF NOT EXISTS tsun_paypal_orders (
      merchant_order_id TEXT PRIMARY KEY,
      paypal_order_id TEXT UNIQUE,
      email TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      order_digest TEXT NOT NULL,
      order_snapshot JSONB NOT NULL,
      payment_status TEXT NOT NULL DEFAULT 'pending',
      capture_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      paid_at TIMESTAMPTZ
    )`;
    await sql`CREATE TABLE IF NOT EXISTS tsun_paypal_mail (
      merchant_order_id TEXT NOT NULL REFERENCES tsun_paypal_orders(merchant_order_id),
      stage TEXT NOT NULL,
      customer_sent BOOLEAN NOT NULL DEFAULT false,
      merchant_sent BOOLEAN NOT NULL DEFAULT false,
      processing_until TIMESTAMPTZ,
      PRIMARY KEY(merchant_order_id,stage)
    )`;
  })().catch(err=>{schemaPromise=null;console.error('PayPal schema setup failed',err?.code||'unknown');throw fail('订单数据库初始化失败，请联系商户',503);});
  return schemaPromise;
}
function hash(x){return createHash('sha256').update(x).digest('hex');}
function safeOrder(order){
  const data=JSON.parse(JSON.stringify(order));
  // Do not store full base64 pet photos in payment DB; production art is sent separately.
  const strip=(obj,depth=0)=>{
    if(!obj||typeof obj!=='object'||depth>12)return;
    for(const [k,v] of Object.entries(obj)){
      if(typeof v==='string'&&(v.startsWith('data:image/')||v.length>15000))obj[k]='[image stored in browser]';
      else if(v&&typeof v==='object')strip(v,depth+1);
    }
  };
  strip(data);
  if(JSON.stringify(data).length>240000)throw fail('订单资料过大，请精简上传图片后重试',413);
  return data;
}
function siteOrigin(req){
  const origin=String(req.headers.origin||'');
  try{const u=new URL(origin);if(u.protocol==='https:'&&(/^tsun88-nfc-l86b(?:-[a-z0-9-]+)?\.vercel\.app$/.test(u.hostname)||['8tsun8.com','www.8tsun8.com'].includes(u.hostname)))return u.origin;}catch{}
  const host=String(process.env.VERCEL_URL||'');if(/^[-\w.]+\.vercel\.app$/.test(host))return 'https://'+host;
  return 'https://www.8tsun8.com';
}
let authCache={key:'',token:'',expires:0};
async function token(c){
  if(authCache.key===c.id&&authCache.expires>Date.now()+30000)return authCache.token;
  let response;try{response=await fetch(c.base+'/v1/oauth2/token',{method:'POST',headers:{Authorization:'Basic '+Buffer.from(c.id+':'+c.secret).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials',signal:AbortSignal.timeout(12000)});}catch{throw fail('暂时无法连接 PayPal',503);}
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!data.access_token){console.error('PayPal token error',response.status,data.name||'');throw fail('PayPal API 授权失败，请核对正式凭证',503);}
  authCache={key:c.id,token:data.access_token,expires:Date.now()+Math.max(60,Number(data.expires_in)||300)*1000};return authCache.token;
}
async function request(c,path,method='GET',body,requestId){
  const access=await token(c);let response;
  try{response=await fetch(c.base+path,{method,headers:{Authorization:'Bearer '+access,'Content-Type':'application/json','Prefer':'return=representation',...(requestId?{'PayPal-Request-Id':requestId}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});}catch{throw fail('PayPal 连接超时，请查询订单状态，避免重复付款',503);}
  const data=await response.json().catch(()=>({}));
  if(!response.ok){console.error('[PayPal API]',{status:response.status,name:String(data.name||'').slice(0,60),issue:String(data.details?.[0]?.issue||'').slice(0,70)});throw fail('PayPal 暂时无法处理订单，请稍后重试',response.status===422?422:502);}
  return data;
}
function safeSummary(order){return summary(order);}
function monetary(cents){return (cents/100).toFixed(2);}
async function create(req,order){
  const c=config(),sql=db();await schema(sql);const s=safeSummary(order);
  const snapshot=safeOrder(order);
  await sql`INSERT INTO tsun_paypal_orders (merchant_order_id,email,amount_cents,order_digest,order_snapshot) VALUES (${s.orderId},${s.email},${s.totalCents},${s.binding},${JSON.stringify(snapshot)}::jsonb) ON CONFLICT(merchant_order_id) DO NOTHING`;
  let [row]=await sql`SELECT * FROM tsun_paypal_orders WHERE merchant_order_id=${s.orderId}`;
  if(!row||row.order_digest!==s.binding||row.amount_cents!==s.totalCents||row.email.toLowerCase()!==s.email.toLowerCase())throw fail('订单金额或邮箱已经变更，请创建新订单',409);
  if(row.payment_status==='paid')throw fail('该订单已经付款，请勿重复支付',409);
  const origin=siteOrigin(req),qs='&order_id='+encodeURIComponent(s.orderId);
  if(row.paypal_order_id){
    const previous=await request(c,'/v2/checkout/orders/'+encodeURIComponent(row.paypal_order_id));
    if(previous.status==='CREATED'||previous.status==='PAYER_ACTION_REQUIRED'||previous.status==='APPROVED'){
      const url=previous.links?.find(l=>['payer-action','approve'].includes(l.rel))?.href;
      if(url)return {id:row.paypal_order_id,url,totalCents:s.totalCents};
    }
    throw fail('已有付款订单，请先核对支付状态后再尝试',409);
  }
  const items=[{name:'8TSUN8 NFC Pet Tag',quantity:String(s.itemCount),unit_amount:{currency_code:'HKD',value:'299.00'}}];
  if(s.decorCount)items.push({name:'8TSUN8 Tag Charms',quantity:String(s.decorCount),unit_amount:{currency_code:'HKD',value:'3.00'}});
  const created=await request(c,'/v2/checkout/orders','POST',{
    intent:'CAPTURE',purchase_units:[{reference_id:'8TSUN8',custom_id:s.orderId,amount:{currency_code:'HKD',value:monetary(s.totalCents),breakdown:{item_total:{currency_code:'HKD',value:monetary(s.totalCents)}}},items}],
    payment_source:{paypal:{experience_context:{brand_name:'8TSUN8',user_action:'PAY_NOW',return_url:origin+'/?paypal_return=success'+qs,cancel_url:origin+'/?paypal_return=cancelled'+qs}}}
  },hash('tsun-create-'+s.orderId).slice(0,36));
  const paymentUrl=created.links?.find(l=>['payer-action','approve'].includes(l.rel))?.href;
  if(!created.id||!paymentUrl||!/^https:\/\/([^/]+\.)?paypal\.com\//i.test(paymentUrl))throw fail('PayPal 未返回有效的付款链接',502);
  const updated=await sql`UPDATE tsun_paypal_orders SET paypal_order_id=${created.id} WHERE merchant_order_id=${s.orderId} AND paypal_order_id IS NULL RETURNING merchant_order_id`;
  if(!updated.length)throw fail('订单状态发生变化，请核对后重试',409);
  return {id:created.id,url:paymentUrl,totalCents:s.totalCents,mode:c.live?'live':'sandbox'};
}
function successfulCapture(data,row){
  const unit=data.purchase_units?.[0];const captures=unit?.payments?.captures||[];
  const capture=captures.find(x=>x.status==='COMPLETED');
  if(data.status!=='COMPLETED'||!capture||!capture.id||unit.custom_id!==row.merchant_order_id||
    capture.amount?.currency_code!=='HKD'||Math.round(Number(capture.amount?.value)*100)!==row.amount_cents||
    unit.amount?.currency_code!=='HKD'||Math.round(Number(unit.amount?.value)*100)!==row.amount_cents)
    throw fail('付款尚未完成或订单金额不一致，请勿重复付款',409);
  return capture;
}
function signingToken(c,row){return createHmac('sha256',c.secret).update([row.merchant_order_id,row.paypal_order_id,row.order_digest,row.capture_id].join('|')).digest('hex');}
function verifySigningToken(c,row,v){return typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)&&timingSafeEqual(Buffer.from(signingToken(c,row),'hex'),Buffer.from(v,'hex'));}
async function capture(orderId,paypalOrderId){
  const c=config(),sql=db();await schema(sql);
  if(!/^[A-Za-z0-9_-]{4,120}$/.test(orderId||'')||!/^[A-Z0-9]{8,40}$/.test(paypalOrderId||''))throw fail('付款编号无效');
  let [row]=await sql`SELECT * FROM tsun_paypal_orders WHERE merchant_order_id=${orderId} AND paypal_order_id=${paypalOrderId}`;
  if(!row)throw fail('找不到匹配的付款订单',404);
  let data=await request(c,'/v2/checkout/orders/'+encodeURIComponent(paypalOrderId));
  if(data.status!=='COMPLETED'){
    if(data.status!=='APPROVED')throw fail('客户尚未完成 PayPal 付款授权',409);
    data=await request(c,'/v2/checkout/orders/'+encodeURIComponent(paypalOrderId)+'/capture','POST',{},hash('tsun-capture-'+paypalOrderId).slice(0,36));
  }
  const captureData=successfulCapture(data,row);
  const result=await sql`UPDATE tsun_paypal_orders SET payment_status='paid',capture_id=${captureData.id},paid_at=COALESCE(paid_at,now()) WHERE merchant_order_id=${orderId} AND paypal_order_id=${paypalOrderId} AND (capture_id IS NULL OR capture_id=${captureData.id}) RETURNING *`;
  row=result[0];if(!row)throw fail('付款记录不一致，请联系商户核实',409);
  return {paid:true,orderId,paypalOrderId,captureId:captureData.id,amountTotal:row.amount_cents,currency:'HKD',orderToken:signingToken(c,row),mode:c.live?'live':'sandbox'};
}
async function verifiedPaid(orderId,paypalOrderId,signature,order){
  const c=config(),sql=db();await schema(sql);
  const [row]=await sql`SELECT * FROM tsun_paypal_orders WHERE merchant_order_id=${orderId} AND paypal_order_id=${paypalOrderId} AND payment_status='paid'`;
  if(!row||!verifySigningToken(c,row,signature))throw fail('没有有效的 PayPal 已付款记录',401);
  const s=safeSummary(order);
  if(s.binding!==row.order_digest||s.totalCents!==row.amount_cents)throw fail('提交订单与已付款商品不一致',409);
  const current=await request(c,'/v2/checkout/orders/'+encodeURIComponent(paypalOrderId));successfulCapture(current,row);
  return {row,sql,summary:s};
}
function bodyOf(req){const body=typeof req.body==='string'?JSON.parse(req.body):req.body||{};if(!body||Array.isArray(body)||typeof body!=='object'||Buffer.byteLength(JSON.stringify(body))>9*1024*1024)throw fail('订单资料无效',413);return body;}
function post(req,res){res.setHeader('Cache-Control','no-store');if(req.method!=='POST'){res.status(405).json({error:'仅支持 POST'});return false;}return true;}
function error(res,err){console.error('[PayPal handler]',err?.status||500,err?.message||'unknown');res.status(err?.status||502).json({error:err?.status<500?err.message:'付款服务暂时无法处理，请稍后重试'});}
module.exports={config,db,schema,create,capture,verifiedPaid,bodyOf,post,error};
