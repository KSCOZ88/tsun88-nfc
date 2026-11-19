'use strict';
const fs=require('node:fs');
const file='index.html';
let html=fs.readFileSync(file,'utf8');

function insertBefore(marker,content,label){
  if(html.includes(content.trim()))return;
  const first=html.indexOf(marker),last=html.lastIndexOf(marker);
  if(first<0||first!==last)throw new Error('Stripe Live UI: missing or ambiguous '+label);
  html=html.slice(0,first)+content+html.slice(first);
}
function replaceRange(startMarker,endMarker,replacement,label){
  const start=html.indexOf(startMarker),end=html.indexOf(endMarker,start);
  if(start<0||end<0||html.indexOf(startMarker,start+startMarker.length)>=0)throw new Error('Stripe Live UI: missing or ambiguous '+label);
  html=html.slice(0,start)+replacement+html.slice(end);
}

const stripePanel=[
'  <div class="payment-panel" id="stripePaymentPanel" role="group" aria-label="Stripe card and Apple Pay checkout" style="margin-top:14px">',
'    <div class="payment-code-box" style="gap:12px">',
'      <b id="stripePanelTitle" translate="no">Stripe · Card / Apple Pay</b>',
'      <small class="payment-scan-note" translate="no">Pay securely by card or Apple Pay where available. Return here after payment to confirm your order and enter delivery details.</small>',
'      <button type="button" class="primary demo-pay-btn" id="stripePayBtn" translate="no" style="background:#635bff;color:#fff">Pay by card / Apple Pay</button>',
'      <button type="button" class="secondary" id="stripeRecoverBtn" hidden translate="no">Already paid? Check Stripe payment status</button>',
'      <small id="stripePaymentStatus" aria-live="polite"></small>',
'    </div>',
'  </div>',
''
].join('\n');
insertBefore('  <div class="payment-panel" id="paypalPaymentPanel"',stripePanel,'PayPal checkout panel');

const paypalEndpoint="const PAYPAL_EMAIL_ENDPOINT=PAYMENT_API_ORIGIN+'/api/paypal-paid-order-email';";
if(!html.includes("const STRIPE_CREATE_ENDPOINT=")){
  if(html.indexOf(paypalEndpoint)<0||html.lastIndexOf(paypalEndpoint)!==html.indexOf(paypalEndpoint))throw new Error('Stripe Live UI: PayPal endpoint marker changed');
  html=html.replace(paypalEndpoint,paypalEndpoint+"\nconst STRIPE_CREATE_ENDPOINT=PAYMENT_API_ORIGIN+'/api/stripe-create-session';\nconst STRIPE_CONFIRM_ENDPOINT=PAYMENT_API_ORIGIN+'/api/stripe-confirm-session';\nconst STRIPE_EMAIL_ENDPOINT=PAYMENT_API_ORIGIN+'/api/stripe-paid-order-email';");
}

const notifyStart='async function notifyOrderStage(order,stage,attachments=[]){';
const notifyEnd='\nfunction startPaymentEmail(order){';
const notifyReplacement=[
'async function notifyOrderStage(order,stage,attachments=[]){',
'  if(PROFILE_PREVIEW_MODE)return {demo:true,customerSent:false,merchantSent:false,previews:[]};',
'  const previews=await prepareEmailPreviews(order);',
'  if(order.isDemo||location.protocol===\'file:\')return {demo:true,customerSent:false,merchantSent:false,previews};',
'  const isStripe=order.payMethod===\'Stripe\';',
'  const isPaypal=order.payMethod===\'PayPal\';',
'  const paymentId=isStripe?order.stripeSessionId:isPaypal?order.paypalOrderId:order.airwallexSessionId;',
'  const token=isStripe?order.stripeOrderToken:isPaypal?order.paypalOrderToken:order.airwallexOrderToken;',
'  if(!paymentId||!token)return {ok:false,customerSent:false,merchantSent:false,error:\'付款尚未通过服务器核验\'};',
'  const endpoint=isStripe?STRIPE_EMAIL_ENDPOINT:isPaypal?PAYPAL_EMAIL_ENDPOINT:AIRWALLEX_EMAIL_ENDPOINT;',
'  try{',
'    const response=await fetch(endpoint,{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify({type:stage,sessionId:paymentId,stripeSessionId:isStripe?paymentId:undefined,paypalOrderId:isPaypal?paymentId:undefined,orderToken:token,order,previews,attachments})});',
'    const result=await response.json().catch(()=>({}));return {...result,ok:response.ok};',
'  }catch{return {ok:false,customerSent:false,merchantSent:false,error:\'订单通知暂未发送，请稍后重试\'};}',
'}'
].join('\n');
if(!html.slice(html.indexOf(notifyStart),html.indexOf(notifyEnd)).includes('const isStripe=')){
  replaceRange(notifyStart,notifyEnd,notifyReplacement,'order email payment routing');
}

const stripeHandlers=[
'async function startStripeCheckout(){',
'  if(!ensureCheckoutProfiles())return;',
'  if(currentOrder&&!validateOrderPhoneConfirmations(currentOrder.items||[captureTagDesign()]))return;',
'  if(LOCAL_FILE_REVIEW||PROFILE_PREVIEW_MODE){toast(\'本地预览不能发起正式付款\');return;}',
'  if(!currentOrder||!validateCustomerEmail())return;',
'  const button=document.getElementById(\'stripePayBtn\');',
'  if(button){button.disabled=true;button.textContent=\'Opening Stripe…\';}',
'  try{',
'    currentOrder.customerEmail=state.customerEmail;currentOrder.payMethod=\'Stripe\';currentOrder.status=\'等待付款\';',
'    currentOrder.pricing=calculateOrderPricing(currentOrder.items||[]);updateStoredOrder(currentOrder);',
'    const response=await fetch(STRIPE_CREATE_ENDPOINT,{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify({order:currentOrder})});',
'    const result=await response.json().catch(()=>({}));',
'    if(!response.ok||result.kind!==\'stripe_checkout\'||!result.id||result.mode!==\'live\')throw new Error(result.error||\'Stripe Live 付款暂时不可用\');',
'    currentOrder.stripeSessionId=result.id;currentOrder.stripeCheckoutPending=!result.alreadyPaid;updateStoredOrder(currentOrder);',
'    if(result.alreadyPaid){location.assign(\'/?stripe_recover=1&order_id=\'+encodeURIComponent(currentOrder.id));return;}',
'    const paymentUrl=new URL(result.url||\'\');',
'    if(paymentUrl.protocol!==\'https:\'||!(paymentUrl.hostname===\'checkout.stripe.com\'||paymentUrl.hostname.endsWith(\'.stripe.com\')))throw new Error(\'Stripe 返回的付款网址无效\');',
'    if(result.totalCents!==Math.round(currentOrder.pricing.total*100))throw new Error(\'付款金额与订单不一致\');',
'    updateStoredOrder(currentOrder);',
'    location.assign(paymentUrl.href);',
'  }catch(error){',
'    toast(error.message||\'Stripe 暂时无法打开，请稍后重试。\',9000);',
'    if(button){button.disabled=false;renderPaymentOrder(currentOrder);}',
'  }',
'}',
'',
'async function handleStripeReturn(){',
'  if(PROFILE_PREVIEW_MODE)return;',
'  const params=new URLSearchParams(location.search);',
'  const result=params.get(\'stripe_return\'),recover=params.get(\'stripe_recover\')===\'1\';',
'  if(![\'success\',\'cancelled\'].includes(result)&&!recover)return;',
'  document.getElementById(\'tsunEnterGate\')?.remove();',
'  const orderId=params.get(\'order_id\'),order=orderId?loadOrders().find(item=>item.id===orderId):null;',
'  if(!order){toast(\'本浏览器找不到这笔订单，请回到发起付款时使用的设备核对。\',9000);return;}',
'  currentOrder=order;cartDesigns=order.items||[];currentCartIndex=0;',
'  applyTagDesign({...order.items?.[0],nfcProfile:order.nfcProfile});go(\'checkout\');renderPaymentOrder(order);',
'  if(order.paymentStatus===\'paid\'&&order.stripeOrderToken){',
'    preparePaidOrderScreen(order);go(\'orderSuccess\');history.replaceState({},document.title,location.pathname+location.hash);',
'    startPaymentEmail(order);return;',
'  }',
'  if(result===\'cancelled\'&&!recover){',
'    history.replaceState({},document.title,location.pathname+location.hash);',
'    toast(\'付款已取消，没有扣款。你可以修改订单或重新付款。\');return;',
'  }',
'  const sessionId=params.get(\'session_id\')||order.stripeSessionId;',
'  if(!sessionId){toast(\'缺少 Stripe 付款编号，请联系客服核对。\',9000);return;}',
'  if(order.stripeSessionId&&order.stripeSessionId!==sessionId){toast(\'Stripe 付款编号与当前订单不匹配。\',9000);return;}',
'  try{',
'    toast(\'正在向 Stripe 核对正式付款，请稍候…\',7000);',
'    const response=await fetch(STRIPE_CONFIRM_ENDPOINT,{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify({sessionId,order})});',
'    const confirmation=await response.json().catch(()=>({}));',
'    if(!response.ok||!confirmation.paid||!confirmation.orderToken||confirmation.mode!==\'live\')throw new Error(confirmation.error||\'Stripe 尚未确认付款成功\');',
'    order.isDemo=false;order.status=\'已付款\';order.paymentStatus=\'paid\';order.payMethod=\'Stripe\';',
'    order.stripeOrderToken=confirmation.orderToken;order.stripeSessionId=confirmation.sessionId||sessionId;',
'    order.stripeCheckoutPending=false;order.paymentTransactionId=confirmation.paymentIntentId;',
'    order.paidAmountCents=confirmation.amountTotal;order.paidAt=new Date().toISOString();order.nfcStatus=\'等待客户填写\';',
'    updateStoredOrder(order);currentOrder=order;preparePaidOrderScreen(order);',
'    if(!state.nfcProfile.breed)syncNfcBreedFromSelection();go(\'orderSuccess\');',
'    history.replaceState({},document.title,location.pathname+location.hash);openPaymentSuccess();startPaymentEmail(order);',
'  }catch(error){',
'    go(\'checkout\');renderPaymentOrder(order);',
'    toast((error.message||\'Stripe 付款核验失败\')+\'。如果已扣款，请勿重复付款，联系客服核对。\',10000);',
'  }',
'}',
''
].join('\n');
if(!html.includes('async function startStripeCheckout(){')){
  const anchor='async function startAirwallexCheckout(){';
  const pos=html.indexOf(anchor);
  if(pos<0||html.lastIndexOf(anchor)!==pos)throw new Error('Stripe Live UI: Airwallex checkout handler marker changed');
  html=html.slice(0,pos)+stripeHandlers+html.slice(pos);
}

const renderStart='function renderPaymentOrder(order){';
const renderEnd='\nfunction beginPayment(){';
const rstart=html.indexOf(renderStart),rend=html.indexOf(renderEnd,rstart);
if(rstart<0||rend<0)throw new Error('Stripe Live UI: payment renderer not found');
const renderBlock=html.slice(rstart,rend);
if(!renderBlock.includes('const stripeButton=')){
  const anchor="  const paypalButton=document.getElementById('paypalPayBtn');";
  const pos=html.indexOf(anchor,rstart);
  if(pos<0||pos>=rend)throw new Error('Stripe Live UI: PayPal renderer marker changed');
  const add=[
"  const stripeButton=document.getElementById('stripePayBtn');if(stripeButton&&!stripeButton.disabled){const zh=window.TsunI18n?.locale==='zh-Hant';stripeButton.textContent=(PROFILE_PREVIEW_MODE||LOCAL_FILE_REVIEW)?(zh?'預覽模式，不會付款':'Preview only · No payment'):(zh?'信用卡 / Apple Pay 付款 · ':'Pay by card / Apple Pay · ')+money(pricing.total);}",
"  const stripeRecover=document.getElementById('stripeRecoverBtn');if(stripeRecover)stripeRecover.hidden=!order.stripeSessionId||order.paymentStatus==='paid';",
"  const stripeStatus=document.getElementById('stripePaymentStatus');if(stripeStatus&&!order.stripeSessionId)stripeStatus.textContent='';",
""
  ].join('\n');
  html=html.slice(0,pos)+add+html.slice(pos);
}

const paymentSuccessStart='function openPaymentSuccess(){';
const paymentSuccessEnd='\nfunction continueAfterPayment(){';
const successReplacement=[
'function openPaymentSuccess(){',
'  const modal=document.getElementById(\'paymentSuccessModal\'),method=document.getElementById(\'paymentSuccessMethod\'),continueButton=document.getElementById(\'paymentSuccessContinue\');',
'  const paymentName=currentOrder?.payMethod===\'Stripe\'?\'Stripe\':currentOrder?.payMethod===\'PayPal\'?\'PayPal\':\'Airwallex\';',
'  if(method)method.textContent=paymentName+\' 付款成功\';',
'  if(modal)modal.hidden=false;',
'  if(continueButton)continueButton.focus();',
'}'
].join('\n');
if(!html.slice(html.indexOf(paymentSuccessStart),html.indexOf(paymentSuccessEnd)).includes("currentOrder?.payMethod==='Stripe'")){
  replaceRange(paymentSuccessStart,paymentSuccessEnd,successReplacement,'payment success message');
}

const bindStart='function bindInputs(){';
const bindEnd='\nfunction bindNfcDraftFlow(){';
const bindPos=html.indexOf(bindStart),bindEndPos=html.indexOf(bindEnd,bindPos);
if(bindPos<0||bindEndPos<0)throw new Error('Stripe Live UI: input binding section not found');
const bindBlock=html.slice(bindPos,bindEndPos);
if(!bindBlock.includes("addEventListener('click',startStripeCheckout)")){
  const marker="  const awxButton=document.getElementById('airwallexPayBtn');";
  const pos=html.indexOf(marker,bindPos);
  if(pos<0||pos>=bindEndPos)throw new Error('Stripe Live UI: Airwallex button binding marker changed');
  const add=[
"  const stripeButton=document.getElementById('stripePayBtn');if(stripeButton&&!stripeButton.dataset.bound){stripeButton.dataset.bound='1';stripeButton.addEventListener('click',startStripeCheckout);}",
"  const stripeRecover=document.getElementById('stripeRecoverBtn');if(stripeRecover&&!stripeRecover.dataset.bound){stripeRecover.dataset.bound='1';stripeRecover.addEventListener('click',()=>{if(currentOrder?.stripeSessionId)location.href='/?stripe_recover=1&order_id='+encodeURIComponent(currentOrder.id);});}",
""
  ].join('\n');
  html=html.slice(0,pos)+add+html.slice(pos);
}

const startupMarker='  handleAirwallexReturn();\n  handlePaypalReturn();';
if(!html.includes('  handleStripeReturn();')){
  if(html.indexOf(startupMarker)<0||html.lastIndexOf(startupMarker)!==html.indexOf(startupMarker))throw new Error('Stripe Live UI: startup recovery marker changed');
  html=html.replace(startupMarker,startupMarker+'\n  handleStripeReturn();');
}

if(!html.includes('id="stripePaymentPanel"')||!html.includes('async function startStripeCheckout()')||
   !html.includes('const STRIPE_WEBHOOK')&& !html.includes('STRIPE_CONFIRM_ENDPOINT')||
   !html.includes("addEventListener('click',startStripeCheckout)")||
   !html.includes('handleStripeReturn();')||!html.includes('const isStripe=order.payMethod')){
  throw new Error('Stripe Live UI validation failed');
}
if(!html.includes('id="paypalPaymentPanel"')||!html.includes('id="airwallexPaymentPanel"'))throw new Error('Existing PayPal or Airwallex checkout UI was lost');
fs.writeFileSync(file,html,'utf8');
console.log('Stripe Live Checkout UI injected; PayPal and Airwallex panels preserved.');
