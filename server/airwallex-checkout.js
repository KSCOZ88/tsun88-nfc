// Airwallex-hosted Checkout Sessions: secrets only on server. API version 2026-05-29+.
const {createHash,createHmac,timingSafeEqual}=require('node:crypto');
const EMAIL=/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
let cache={token:'',until:0,mode:''};
const sessionPath='/api/v1/checkout/checkout_sessions/';
const sessionIdPattern=/^[A-Za-z0-9_-]{6,120}$/;
const fail=(message,status=422)=>Object.assign(new Error(message),{status});
function configuration(){
  const mode=process.env.VERCEL_ENV==='production'?'live':'sandbox';
  const prefix=mode==='live'?'AIRWALLEX_':'AIRWALLEX_SANDBOX_';
  const key=process.env[prefix+'API_KEY']||'',clientId=process.env[prefix+'CLIENT_ID']||'',accountId=process.env[prefix+'ACCOUNT_ID']||'';
  if(!key||!clientId||!/^acct_[\w-]+$/.test(accountId))throw fail(mode==='live'?'Airwallex 正式收款尚未配置完整':'Airwallex Sandbox 测试凭证尚未设置。正式密钥不会用于测试。',503);
  return {mode,key,clientId,accountId,base:mode==='live'?'https://api.airwallex.com':'https://api.sandbox.airwallex.com'};
}
function parseBody(req){
  const body=typeof req.body==='string'?JSON.parse(req.body):req.body||{};
  if(!body||typeof body!=='object'||Array.isArray(body)||Buffer.byteLength(JSON.stringify(body))>9*1024*1024)throw fail('订单资料无效或过大',413);
  return body;
}
function summary(order){
  if(!order||typeof order!=='object'||!/^[-\w]{1,100}$/.test(order.id||'')||typeof order.customerEmail!=='string'||order.customerEmail.length>254||!EMAIL.test(order.customerEmail))throw fail('订单编号或邮箱无效');
  const items=order.items;if(!Array.isArray(items)||items.length<1||items.length>20)throw fail('狗牌数量无效');
  let decorCount=0;
  for(const item of items){
    if(!item||typeof item!=='object'||!item.decorItems)throw fail('狗牌资料无效');
    for(const side of ['front','back']){
      const decorations=item.decorItems[side];
      if(!Array.isArray(decorations)||decorations.length>6)throw fail('每面的配饰数量不能超过六枚');
      decorCount+=decorations.length;
    }
  }
  const itemCount=items.length,totalCents=(299*itemCount+3*decorCount)*100;
  // Bind the payment and follow-on notifications to the same order contents.
  // Customers may edit text, pet details and shipping after paying; only bind chargeable quantities.
  const binding=createHash('sha256').update([order.id,order.customerEmail.toLowerCase(),itemCount,decorCount].join('|')).digest('hex');
  return {orderId:order.id,email:order.customerEmail,itemCount,decorCount,totalCents,binding};
}
function siteBase(req){
  const origin=String(req.headers.origin||'');
  try{
    const url=new URL(origin);const h=url.hostname.toLowerCase();
    if(url.protocol==='https:'&&(/^tsun88-nfc-l86b(?:-[a-z0-9-]+)?\.vercel\.app$/.test(h)||h==='8tsun8.com'||h==='www.8tsun8.com'))return url.origin;
    if(process.env.VERCEL_ENV!=='production'&&url.protocol==='http:'&&['localhost','127.0.0.1'].includes(h))return url.origin;
  }catch{}
  const host=process.env.VERCEL_URL;
  if(host&&/^tsun88-nfc-l86b(?:-[a-z0-9-]+)?\.vercel\.app$/.test(host))return 'https://'+host;
  return 'https://tsun88-nfc-l86b.vercel.app';
}
async function auth(config){
  if(cache.mode===config.mode&&cache.token&&cache.until>Date.now()+60000)return cache.token;
  let resp;
  try{resp=await fetch(config.base+'/api/v1/authentication/login',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':config.key,'x-client-id':config.clientId},signal:AbortSignal.timeout(14000)});}catch{throw fail('无法连接 Airwallex，请稍后再试',503)}
  const data=await resp.json().catch(()=>({}));
  if(!resp.ok||!data.token)throw fail('Airwallex 验证失败，请检查 API 凭证及密钥权限',503);
  cache={token:data.token,until:Date.parse(data.expires_at||'')||Date.now()+20*60000,mode:config.mode};
  return data.token;
}
async function request(config,path,method='GET',payload){
  const token=await auth(config);
  let response;
  try{response=await fetch(config.base+path,{method,headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json','x-api-version':'2026-05-29'},...(payload?{body:JSON.stringify(payload)}:{}),signal:AbortSignal.timeout(13000)});}catch{throw fail('Airwallex 网络暂时无法连接，请稍后再试',503)}
  const body=await response.json().catch(()=>({}));
  if(!response.ok){

const errorCode = body?.code ?? body?.error?.code;
const errorSource = body?.source ?? body?.error?.source;

const safeField = value =>
  typeof value === 'string' &&
  /^[a-zA-Z_][a-zA-Z0-9_.\[\]-]{0,119}$/.test(value)
    ? value
    : 'unavailable';

console.error('[Airwallex Checkout Error]', {
  status: response.status,
  code: safeField(errorCode),
  source: safeField(errorSource)
});

    // Don't return provider raw details or tokens to public clients.
    if(response.status===403)throw fail('Airwallex 尚未授权此功能，需核对 Checkout Sessions 权限或产品开通状态',503);
    if(response.status===401)throw fail('Airwallex API 登录权限失效，请联系网站管理员',503);
    if(response.status===400||response.status===422)throw fail('Airwallex 暂时无法创建此类付款，请联系商户核对开通情况',503);
    throw fail('Airwallex 请求失败，请稍后再试',502);
  }
  return body;
}
function expectedMeta(s){return {order_id:s.orderId,order_binding:s.binding,item_count:String(s.itemCount),decor_count:String(s.decorCount),total_cents:String(s.totalCents)};}
async function createSession(config,req,order,attempt){
  const s=summary(order),origin=siteBase(req);
  if(s.orderId.length>64)throw fail('Invalid order number.');
  const qs='&order_id='+encodeURIComponent(s.orderId);
  const requestId=createHash('sha256').update(JSON.stringify(['unionpay',s.binding,attempt])).digest('hex');
  const lineItems=[{price:{currency:'HKD',unit_amount:299,pricing_model:'PER_UNIT',product:{name:'8TSUN8 NFC Pet Tag'}},quantity:s.itemCount}];
  if(s.decorCount)lineItems.push({price:{currency:'HKD',unit_amount:3,pricing_model:'PER_UNIT',product:{name:'8TSUN8 Tag Charms'}},quantity:s.decorCount});
  const data=await request(config,sessionPath+'create','POST',{
    account_id:config.accountId,request_id:requestId,mode:'PAYMENT',ui_mode:'HOSTED',currency:'HKD',
    line_items:lineItems,metadata:expectedMeta(s),customer_data:{email:s.email,country_code:'HK',type:'INDIVIDUAL'},
    payment_intent_data:{merchant_order_id:s.orderId},
    payment_options:{auto_capture:true,payment_method_save:{mode:'DISABLED'},payment_method_types:['card'],allowed_card_networks:['unionpay']},
    success_url:origin+'/?airwallex_return=success'+qs,
    back_url:origin+'/?recover=1'+qs
  });
  if(typeof data.id!=='string'||!sessionIdPattern.test(data.id))throw fail('Airwallex 没有返回有效订单编号',502);
  checkSession(config,data,data.id,s);
  const url=URL.parse(String(data.url||''));
  if(data.status!=='ACTIVE'||url?.protocol!=='https:'||!(url.hostname==='airwallex.com'||url.hostname.endsWith('.airwallex.com')))throw fail('Airwallex 没有返回有效付款链接',502);
  return {id:data.id,url:url.href};
}
function checkSession(config,session,sessionId,s){
  if(session.id!==sessionId||session.mode!=='PAYMENT'||session.account_id!==config.accountId||session.currency!=='HKD')throw fail('銀聯付款帳戶或幣種不匹配',409);
  for(const [key,value] of Object.entries(expectedMeta(s))){if(String(session.metadata?.[key]||'')!==value)throw fail('订单编号、金额或商品资料不一致',409);}
  if(session.customer_data?.email&&session.customer_data.email.toLowerCase()!==s.email.toLowerCase())throw fail('付款邮箱与订单邮箱不一致',409);
  const {payment_method_types:types,allowed_card_networks:networks}=session.payment_options||{};
  if(types?.length!==1||types[0]!=='card'||networks?.length!==1||networks[0]!=='unionpay')throw fail('Airwallex 未能限制此付款頁只收銀聯卡',502);
}
async function lookupSession(config,id,s){
  if(typeof id!=='string'||!sessionIdPattern.test(id))throw fail('Airwallex 付款编号无效');
  const session=await request(config,sessionPath+encodeURIComponent(id));
  checkSession(config,session,id,s);
  return session;
}
async function verifiedSession(id,order){
  const config=configuration(),s=summary(order);
  const session=await lookupSession(config,id,s);
  const paymentIntentId=session.payment_intent_id;
  if(session.status!=='COMPLETED'||typeof paymentIntentId!=='string'||!sessionIdPattern.test(paymentIntentId))throw fail('銀聯付款尚未確認',409);
  const intent=await request(config,'/api/v1/pa/payment_intents/'+encodeURIComponent(paymentIntentId));
  const attempt=intent.latest_payment_attempt;
  const method=attempt?.payment_method;
  if(intent.id!==paymentIntentId||intent.status!=='SUCCEEDED'||intent.currency!=='HKD'||intent.merchant_order_id!==s.orderId||
     Math.round(Number(intent.amount)*100)!==s.totalCents||
     Math.round(Number(attempt?.captured_amount??intent.captured_amount)*100)!==s.totalCents||
     method?.type!=='card'||String(method.card?.brand||'').toLowerCase().replace(/\s+/g,'')!=='unionpay'){
    throw fail('銀聯付款方式或已收金額尚未確認',409);
  }
  return {paid:true,paymentIntentId,amountCents:s.totalCents,currency:'HKD',mode:config.mode};
}
async function retireSession(id,s){
  const config=configuration();
  let session=await lookupSession(config,id,s);
  if(session.status==='ACTIVE'){
    let cancellationError;
    try{await request(config,sessionPath+encodeURIComponent(id)+'/cancel','POST');}catch(error){cancellationError=error;}
    session=await lookupSession(config,id,s);
    if(cancellationError&&session.status==='ACTIVE')throw cancellationError;
  }
  if(session.status==='COMPLETED')return {paid:true,id};
  return ['CANCELLED','EXPIRED'].includes(session.status)?null:{pending:true,id};
}
function makeToken(config,sessionId,s){return createHmac('sha256',config.key).update([config.mode,config.accountId,sessionId,s.binding,s.orderId,s.email.toLowerCase()].join('|')).digest('hex');}
function verifyToken(config,token,sessionId,s){return typeof token==='string'&&/^[a-f0-9]{64}$/.test(token)&&timingSafeEqual(Buffer.from(token,'hex'),Buffer.from(makeToken(config,sessionId,s),'hex'));}
function handleError(res,error){return res.status(error.status||502).json({error:error.message||'Airwallex 操作暂时失败'});}
function method(req,res){res.setHeader('Cache-Control','no-store');if(req.method==='OPTIONS')return res.status(204).end();if(req.method!=='POST')return res.status(405).json({error:'仅支持 POST'});return null;}
module.exports={configuration,auth,parseBody,summary,createSession,verifiedSession,retireSession,makeToken,verifyToken,handleError,method};
