// TSUN88 PayPal Orders v2 support. Secrets never reach the browser.
const {createHmac,timingSafeEqual,createHash}=require('node:crypto');
const {pricing}=require('./stripe-orders');

const emailValid=value=>typeof value==='string'&&value.length<=254&&/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
const orderIdValid=value=>typeof value==='string'&&/^[\w-]{1,100}$/.test(value);
const paypalIdValid=value=>typeof value==='string'&&/^[A-Z0-9]{8,32}$/.test(value);
function configuration(){
  // NEVER use sandbox credentials on a production deployment.
  const production=process.env.VERCEL_ENV==='production';
  const mode=production?'live':'sandbox';
  if(production&&process.env.PAYPAL_MODE!=='live')return null;
  const prefix=production?'PAYPAL_LIVE_':'PAYPAL_SANDBOX_';
  const clientId=process.env[prefix+'CLIENT_ID']||'';
  const clientSecret=process.env[prefix+'CLIENT_SECRET']||'';
  if(!clientId||!clientSecret)return null;
  return {clientId,clientSecret,mode,base:production?'https://api-m.paypal.com':'https://api-m.sandbox.paypal.com'};
}
function requireConfiguration(){
  const config=configuration();if(!config)throw Object.assign(new Error('PayPal 尚未在此环境启用'),{httpStatus:503});return config;
}
function verifiedCounts(itemCount,decorCount){
  if(!Number.isInteger(itemCount)||itemCount<1||itemCount>20||!Number.isInteger(decorCount)||decorCount<0||decorCount>240||decorCount>itemCount*12)throw Object.assign(new Error('商品数量无效'),{httpStatus:422});
  return {itemCount,decorCount,totalCents:(itemCount*299+decorCount*3)*100};
}
function orderSummary(order){
  if(!orderIdValid(order?.id)||!emailValid(order?.customerEmail))throw Object.assign(new Error('订单编号或通知邮箱无效'),{httpStatus:422});
  const items=order.items;
  if(!Array.isArray(items)||items.length<1||items.length>20||items.some(item=>!item||!item.decorItems||['front','back'].some(side=>!Array.isArray(item.decorItems[side])||item.decorItems[side].length>6)))throw Object.assign(new Error('订单商品或配饰无效'),{httpStatus:422});
  const p=pricing(order);return {...verifiedCounts(p.itemCount,p.decorCount),orderId:order.id,customerEmail:order.customerEmail};
}
async function request(config,path,{method='GET',body,headers={}}={}){
  const response=await fetch(config.base+path,{method,headers:{'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{}) ,signal:AbortSignal.timeout(22000)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok){const err=data?.details?.[0]?.issue||data?.name||'PayPal 请求未完成';throw Object.assign(new Error('PayPal: '+String(err).slice(0,160)),{httpStatus:response.status===422?422:502,paypalIssue:String(err)});}
  return data;
}
async function accessToken(config){
  const auth=Buffer.from(config.clientId+':'+config.clientSecret).toString('base64');
  const response=await fetch(config.base+'/v1/oauth2/token',{method:'POST',headers:{Authorization:'Basic '+auth,'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials',signal:AbortSignal.timeout(22000)});
  const result=await response.json().catch(()=>({}));if(!response.ok||!result.access_token)throw Object.assign(new Error('PayPal 登录验证失败，请检查 API 凭证'),{httpStatus:503});
  return result.access_token;
}
async function createPayPalOrder(config,{orderId,customerEmail,itemCount,decorCount}){
  if(!orderIdValid(orderId)||!emailValid(customerEmail))throw Object.assign(new Error('订单编号或邮箱无效'),{httpStatus:422});
  const counts=verifiedCounts(itemCount,decorCount),token=await accessToken(config);
  return request(config,'/v2/checkout/orders',{method:'POST',headers:{Authorization:'Bearer '+token,'PayPal-Request-Id':createHash('sha256').update('create:'+orderId+':'+config.mode).digest('hex').slice(0,32)},body:{
    intent:'CAPTURE',purchase_units:[{reference_id:'tsun88',custom_id:orderId,description:'8TSUN8 personalised NFC pet tag',amount:{currency_code:'HKD',value:(counts.totalCents/100).toFixed(2)}}],
    application_context:{shipping_preference:'NO_SHIPPING',user_action:'PAY_NOW'}
  }});
}
function verifyOrderDetails(paypalOrder,summary,{captured=false}={}){
  const unit=paypalOrder?.purchase_units?.[0];
  if(paypalOrder?.purchase_units?.length!==1||unit?.custom_id!==summary.orderId||unit?.amount?.currency_code!=='HKD'||Number(unit?.amount?.value)*100!==summary.totalCents)throw Object.assign(new Error('PayPal 付款金额或订单编号不一致'),{httpStatus:409});
  if(captured){
    const capture=unit?.payments?.captures?.find(record=>record.status==='COMPLETED');
    if(paypalOrder.status!=='COMPLETED'||!capture||capture.amount?.currency_code!=='HKD'||Number(capture.amount?.value)*100!==summary.totalCents)throw Object.assign(new Error('PayPal 尚未确认完成收款'),{httpStatus:409});
    return capture;
  }
  return unit;
}
async function fetchPayPalOrder(config,paypalOrderId){
  if(!paypalIdValid(paypalOrderId))throw Object.assign(new Error('PayPal 订单编号无效'),{httpStatus:422});
  const token=await accessToken(config);
  const order=await request(config,'/v2/checkout/orders/'+encodeURIComponent(paypalOrderId),{headers:{Authorization:'Bearer '+token}});
  return {order,token};
}
async function capturePayPalOrder(config,paypalOrderId,summary){
  const fetched=await fetchPayPalOrder(config,paypalOrderId);
  verifyOrderDetails(fetched.order,summary);
  if(fetched.order.status==='COMPLETED')return {order:fetched.order,capture:verifyOrderDetails(fetched.order,summary,{captured:true})};
  if(fetched.order.status!=='APPROVED')throw Object.assign(new Error('PayPal 尚未得到买家付款授权，请不要重复付款'),{httpStatus:409});
  const attemptId=createHash('sha256').update('capture:'+paypalOrderId).digest('hex').slice(0,32);
  let captured;
  try{
    captured=await request(config,'/v2/checkout/orders/'+encodeURIComponent(paypalOrderId)+'/capture',{method:'POST',headers:{Authorization:'Bearer '+fetched.token,'PayPal-Request-Id':attemptId},body:{}});
  }catch(error){
    // If the client lost the response after a completed capture, re-fetch safely.
    const recovered=await fetchPayPalOrder(config,paypalOrderId);
    if(recovered.order.status!=='COMPLETED')throw error;
    captured=recovered.order;
  }
  return {order:captured,capture:verifyOrderDetails(captured,summary,{captured:true})};
}
function orderToken(config,paypalOrderId,captureId,summary){
  return createHmac('sha256',config.clientSecret).update([config.mode,paypalOrderId,captureId,summary.orderId,summary.customerEmail.toLowerCase()].join('|')).digest('hex');
}
function verifyOrderToken(config,received,paypalOrderId,captureId,summary){
  if(!/^[a-f0-9]{64}$/.test(received||''))return false;
  return timingSafeEqual(Buffer.from(received,'hex'),Buffer.from(orderToken(config,paypalOrderId,captureId,summary),'hex'));
}
function sendError(res,error){return res.status(error.httpStatus||502).json({error:error.message||'PayPal 请求失败'});}
function parseBody(req){const body=typeof req.body==='string'?JSON.parse(req.body):req.body||{};if(!body||typeof body!=='object'||Array.isArray(body)||Buffer.byteLength(JSON.stringify(body))>4*1024*1024)throw Object.assign(new Error('订单资料无效或过大'),{httpStatus:413});return body;}
function methods(req,res,allowed){res.setHeader('Cache-Control','no-store');if(req.method!==allowed)return res.status(405).json({error:'请求方法无效'});return null;}
module.exports={configuration,requireConfiguration,verifiedCounts,orderSummary,createPayPalOrder,fetchPayPalOrder,capturePayPalOrder,verifyOrderDetails,orderToken,verifyOrderToken,sendError,parseBody,methods};
