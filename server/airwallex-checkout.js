// Airwallex-hosted Checkout Sessions: secrets only on server. API version 2026-05-29+.
const {createHash,createHmac,timingSafeEqual,randomUUID}=require('node:crypto');
const EMAIL=/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
let cache={token:'',until:0,mode:''};
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
  try{response=await fetch(config.base+path,{method,headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json','x-api-version':'2026-05-29'},...(payload?{body:JSON.stringify(payload)}:{}),signal:AbortSignal.timeout(20000)});}catch{throw fail('Airwallex 网络暂时无法连接，请稍后再试',503)}
  const body=await response.json().catch(()=>({}));
  if(!response.ok){
    // Don't return provider raw details or tokens to public clients.
    if(response.status===403)throw fail('Airwallex 尚未授权此功能，需核对 Checkout Sessions 权限或产品开通状态',503);
    if(response.status===401)throw fail('Airwallex API 登录权限失效，请联系网站管理员',503);
    if(response.status===400||response.status===422)throw fail('Airwallex 暂时无法创建此类付款，请联系商户核对开通情况',503);
    throw fail('Airwallex 请求失败，请稍后再试',502);
  }
  return body;
}
function expectedMeta(s){return {order_id:s.orderId,order_binding:s.binding,item_count:String(s.itemCount),decor_count:String(s.decorCount),total_cents:String(s.totalCents)};}
async function createSession(config,req,order){
  const s=summary(order),origin=siteBase(req);
  const qs='&order_id='+encodeURIComponent(s.orderId);
  const lineItems=[{price:{currency:'HKD',unit_amount:299,pricing_model:'PER_UNIT',product:{name:'8TSUN8 NFC Pet Tag'}},quantity:s.itemCount}];
  if(s.decorCount)lineItems.push({price:{currency:'HKD',unit_amount:3,pricing_model:'PER_UNIT',product:{name:'8TSUN8 Tag Charms'}},quantity:s.decorCount});
  const data=await request(config,'/api/v1/checkout/checkout_sessions/create','POST',{
    account_id:config.accountId,request_id:randomUUID(),mode:'PAYMENT',ui_mode:'HOSTED',currency:'HKD',
    line_items:lineItems,metadata:expectedMeta(s),customer_data:{email:s.email,type:'INDIVIDUAL'},
    payment_intent_data:{merchant_order_id:s.orderId.slice(0,64)},
    payment_options:{auto_capture:true,payment_method_save:{mode:'DISABLED'},payment_method_types:['card','applepay','googlepay','alipayhk','airwallex_pay','fps']},
    success_url:origin+'/?airwallex_return=success'+qs,
    back_url:origin+'/?airwallex_return=cancelled'+qs
  });
  if(!/^cs_|^ch_|^cko_|^cse_/.test(data.id||'')){
    // Some accounts use different checkout-session id prefixes; validate generically.
    if(!/^[a-zA-Z0-9_-]{6,120}$/.test(data.id||''))throw fail('Airwallex 没有返回有效订单编号',502);
  }
  const url=new URL(String(data.url||''));
  if(url.protocol!=='https:'||!(url.hostname==='airwallex.com'||url.hostname.endsWith('.airwallex.com')))throw fail('Airwallex 没有返回有效付款链接',502);
  return {id:data.id,url:data.url,mode:config.mode,totalCents:s.totalCents};
}
async function verifiedSession(config,sessionId,order){
  const s=summary(order);
  if(!/^[A-Za-z0-9_-]{6,120}$/.test(sessionId||''))throw fail('Airwallex 付款编号无效');
  const session=await request(config,'/api/v1/checkout/checkout_sessions/'+encodeURIComponent(sessionId));
  if(session.status!=='COMPLETED'||session.mode!=='PAYMENT'||!session.payment_intent_id)throw fail('Airwallex 尚未确认付款完成，请不要重复付款',409);
  if(session.account_id!==config.accountId||String(session.currency||'').toUpperCase()!=='HKD')throw fail('收款账户或币种不匹配',409);
  for(const [key,value] of Object.entries(expectedMeta(s))){if(String(session.metadata?.[key]||'')!==value)throw fail('订单编号、金额或商品资料不一致',409);}
  if(session.customer_data?.email&&session.customer_data.email.toLowerCase()!==s.email.toLowerCase())throw fail('付款邮箱与订单邮箱不一致',409);
  return {session,summary:s};
}
function makeToken(config,sessionId,s){return createHmac('sha256',config.key).update([config.mode,config.accountId,sessionId,s.binding,s.orderId,s.email.toLowerCase()].join('|')).digest('hex');}
function verifyToken(config,token,sessionId,s){return typeof token==='string'&&/^[a-f0-9]{64}$/.test(token)&&timingSafeEqual(Buffer.from(token,'hex'),Buffer.from(makeToken(config,sessionId,s),'hex'));}
function handleError(res,error){return res.status(error.status||502).json({error:error.message||'Airwallex 操作暂时失败'});}
function method(req,res){res.setHeader('Cache-Control','no-store');if(req.method==='OPTIONS')return res.status(204).end();if(req.method!=='POST')return res.status(405).json({error:'仅支持 POST'});return null;}
module.exports={configuration,parseBody,summary,createSession,verifiedSession,makeToken,verifyToken,handleError,method};
