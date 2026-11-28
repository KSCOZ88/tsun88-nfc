'use strict';
const {createHmac,timingSafeEqual,createHash}=require('node:crypto');
const {render,safeUrl}=require('./email-template');
const {sendGmail}=require('./gmail-mailer');
const {sendMerchantProduction}=require('./airwallex-order-mailer');
const fail=(message,status=422)=>Object.assign(new Error(message),{status});
const emailValid=value=>typeof value==='string'&&value.length<=254&&/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
function cors(req,res){const origin=String(req.headers.origin||'');const allowed=['https://8tsun8.com','https://www.8tsun8.com'];if(allowed.includes(origin))res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Headers','Content-Type');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.setHeader('Cache-Control','no-store');}
function pricing(order){const items=Array.isArray(order?.items)?order.items:[];const itemCount=items.length;const decorCount=items.reduce((n,item)=>n+['front','back'].reduce((m,side)=>m+(Array.isArray(item?.decorItems?.[side])?item.decorItems[side].length:0),0),0);if(itemCount<1||itemCount>20||decorCount>240)throw fail('订单数量无效');return {itemCount,decorCount,totalCents:itemCount*29900+decorCount*300};}
function checkoutPaymentMethod(value){const allowed=['card','alipay','wechat_pay'];if(typeof value!=='string'||!allowed.includes(value))throw fail('不支持所选 Stripe 付款方式',422);return value;}
function checkoutLocale(value){return value==='zh-Hant'||value==='zh-HK'?'zh-HK':'en';}
function keyState(raw=process.env.STRIPE_SECRET_KEY){
 const key=String(raw||'').trim();
 if(!key)return 'missing';
 if(/^pk_(live|test)_/.test(key))return 'publishable';
 if(/^(?:sk|rk)_test_/.test(key))return 'test';
 if(/^(?:sk|rk)_live_[A-Za-z0-9]+$/.test(key))return 'live';
 return 'invalid';
}
function config(){
 const state=keyState();
 if(state!=='live'){
  const error=fail('暫時未能開啟付款，請稍後再試。',503);
  error.code='STRIPE_KEY_CONFIGURATION';
  console.error('[Stripe checkout] invalid key configuration',{reason:state,env:process.env.VERCEL_ENV||'local'});
  throw error;
 }
 return String(process.env.STRIPE_SECRET_KEY).trim();
}
function assertCheckoutEnvironment(){
 if(process.env.VERCEL_ENV==='preview'){
  // Preview must never start a live charge or write a live checkout session to the orders DB.
  console.info('[Stripe checkout] preview payment blocked',{keyStatus:keyState(),env:'preview'});
  const error=fail('此頁面是設計預覽版，不能進行真實付款。',403);
  error.code='PREVIEW_PAYMENT_DISABLED';
  throw error;
 }
 config();
}
async function stripeRequest(path,options={}){const key=config();const response=await fetch('https://api.stripe.com/v1/'+path,{...options,headers:{Authorization:'Bearer '+key,...(options.headers||{})}});const result=await response.json().catch(()=>({}));if(!response.ok)throw fail(result.error?.message||'Stripe 请求失败',502);return result;}
async function createSession(req,order,previews=[],locale='en',paymentMethod='card'){paymentMethod=checkoutPaymentMethod(paymentMethod);locale=locale==='zh-Hant'||locale==='zh-HK'?'zh-HK':'en';order.language=locale==='zh-HK'?'zh-Hant':'en';assertCheckoutEnvironment();const total=pricing(order),email=String(order.customerEmail||'').trim();if(!/^[\w-]{1,100}$/.test(order.id||''))throw fail('订单号无效');if(!emailValid(email))throw fail('请填写有效邮箱');const store=require('./stripe-order-store');const lease=await store.begin(order,previews,total,paymentMethod,Boolean(req&&req.switchPaymentMethod));order=lease.order;if(lease.existing)return {id:lease.existing.stripe_session_id,url:lease.existing.stripe_session_url,totalCents:total.totalCents,language:order.language};const base='https://www.8tsun8.com';const form=new URLSearchParams({mode:'payment',success_url:base+'/?stripe_return=success&session_id={CHECKOUT_SESSION_ID}&order_id='+encodeURIComponent(order.id),cancel_url:base+'/?stripe_return=cancelled&order_id='+encodeURIComponent(order.id),customer_email:email,client_reference_id:order.id,locale:checkoutLocale(locale),'metadata[order_id]':order.id,'metadata[item_count]':String(total.itemCount),'metadata[decor_count]':String(total.decorCount),'payment_intent_data[metadata][order_id]':order.id});form.set('adaptive_pricing[enabled]','false');form.set('payment_method_types[0]',paymentMethod);if(paymentMethod==='wechat_pay')form.set('payment_method_options[wechat_pay][client]','web');form.set('line_items[0][quantity]',String(total.itemCount));form.set('line_items[0][price_data][currency]','hkd');form.set('line_items[0][price_data][unit_amount]','29900');form.set('line_items[0][price_data][product_data][name]',order.language==='zh-Hant'?'8TSUN8 NFC 寵物狗牌':'8TSUN8 Smart Pet Tag');if(total.decorCount){form.set('line_items[1][quantity]',String(total.decorCount));form.set('line_items[1][price_data][currency]','hkd');form.set('line_items[1][price_data][unit_amount]','300');form.set('line_items[1][price_data][product_data][name]',order.language==='zh-Hant'?'狗牌裝飾':'Pet Tag Decorations');}let session=null;try{session=await stripeRequest('checkout/sessions',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':'tsun88-checkout-'+order.id+'-'+String(lease.attempt||1)},body:form});if(!session.id||!session.url)throw fail('Stripe 未返回付款链接',502);await store.complete(lease,session);}catch(error){if(!session)await store.abort(lease).catch(()=>{});throw error;}return {id:session.id,url:session.url,totalCents:total.totalCents,language:order.language};}
async function expireStripeSession(sessionId){if(!/^cs_live_[A-Za-z0-9_]+$/.test(sessionId||''))throw fail('Stripe 付款编号无效');return stripeRequest('checkout/sessions/'+encodeURIComponent(sessionId)+'/expire',{method:'POST'});}
async function stripeSession(sessionId){if(!/^cs_live_[A-Za-z0-9_]+$/.test(sessionId||''))throw fail('Stripe 付款编号无效');return stripeRequest('checkout/sessions/'+encodeURIComponent(sessionId));}
function verifyPaidSession(session,order){const total=pricing(order);if(session.payment_status!=='paid')throw fail('Stripe 尚未确认付款',409);if(session.client_reference_id!==order.id||session.metadata?.order_id!==order.id)throw fail('付款与订单号不一致',409);if(!emailValid(order.customerEmail))throw fail('订单邮箱无效');const stripeEmail=String(session.customer_details?.email||session.customer_email||'').toLowerCase();if(stripeEmail&&stripeEmail!==String(order.customerEmail).toLowerCase())throw fail('付款邮箱与订单邮箱不一致',409);if(String(session.currency).toLowerCase()!=='hkd'||session.amount_total!==total.totalCents)throw fail('Stripe 实收金额与订单金额不一致',409);if(String(session.metadata?.item_count||'')!==String(total.itemCount)||String(session.metadata?.decor_count||'')!==String(total.decorCount))throw fail('付款商品数量与订单不一致',409);return total;}
function orderToken(session,order){return createHmac('sha256',config()).update(session.id+'|'+order.id+'|'+String(order.customerEmail).toLowerCase()).digest('hex');}
function verifyOrderToken(token,session,order){if(!/^[a-f0-9]{64}$/.test(token||''))return false;const a=Buffer.from(token,'hex'),b=Buffer.from(orderToken(session,order),'hex');return a.length===b.length&&timingSafeEqual(a,b);}
function pngAttachments(list,inline=false){if(!Array.isArray(list)||list.length>60)throw fail('订单图片数量不正确');return list.map((item,index)=>{const data=String(item?.data||'');if(!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data))throw fail('订单图片必须为 PNG');const content=data.slice(data.indexOf(',')+1);if(!Buffer.from(content,'base64').subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw fail('PNG 图片内容无效');const filename=String(item.name||('狗牌-'+index+'.png')).replace(/[\r\n/\\]/g,'-').slice(0,120);return {filename,content,content_type:'image/png',...(inline?{content_id:'tag-preview-'+index}:{})};});}
async function deliver(stage,order,previews,attachments=[],options={}){
  if(!process.env.SMTP_APP_PASSWORD)throw fail('Gmail 发信授权尚未配置',503);
  if(stage==='order_completed'&&!safeUrl(order.cloudProfile?.publicUrl))throw fail('宠物档案网址尚未生成');
  const identity=createHash('sha256').update(order.id+'|'+stage+'|'+order.customerEmail).digest('hex');
  let customer={sent:Boolean(options.skipCustomer),skipped:true};
  if(!options.skipCustomer){
    const files=pngAttachments(previews,true);
    if(!files.length)throw fail('订单缺少狗牌效果图');
    const message=render(order,stage,files.map((file,index)=>({src:'cid:'+file.content_id,label:previews[index].label})));
    customer=await sendGmail({to:[order.customerEmail],subject:message.subject,html:message.html,
      text:message.text,attachments:files},'tsun-stripe-customer-'+identity);
  }
  let merchant={sent:false,skipped:true};
  if(stage==='order_completed'){
    merchant=options.skipMerchant ? {sent:true,skipped:true}
      : await sendMerchantProduction(order,attachments,'tsun-stripe-merchant-'+identity);
  }
  return {customerSent:customer.sent,merchantSent:merchant.sent,customer,merchant};
}
module.exports={cors,pricing,checkoutLocale,checkoutPaymentMethod,keyState,assertCheckoutEnvironment,createSession,stripeSession,expireStripeSession,verifyPaidSession,orderToken,verifyOrderToken,deliver,fail};
