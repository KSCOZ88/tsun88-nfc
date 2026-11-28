'use strict';
/* 8TSUN8 checkout. Payment marks are served locally. */
(function(){
 const choices=[
  {id:'card',en:'Credit / Debit Card',zh:'信用卡／扣賬卡',subEn:'Visa · Mastercard · Amex',subZh:'Visa · Mastercard · Amex',logos:['visa','mastercard','americanexpress'],stripe:'card'},
  {id:'apple',en:'Apple Pay',zh:'Apple Pay',subEn:'Shown by Stripe when supported',subZh:'Stripe 僅於支援時顯示',logos:['applepay'],stripe:'card'},
  {id:'google',en:'Google Pay',zh:'Google Pay',subEn:'Shown by Stripe when supported',subZh:'Stripe 僅於支援時顯示',logos:['googlepay'],stripe:'card'},
  {id:'paypal',en:'PayPal',zh:'PayPal',subEn:'Secure PayPal checkout',subZh:'使用 PayPal 安全付款',logos:['paypal'],provider:'paypal'},
  {id:'alipay',en:'Alipay',zh:'支付寶 Alipay',subEn:'Mainland wallet · not AlipayHK',subZh:'內地錢包，非 AlipayHK',logos:['alipay'],stripe:'alipay'},
  {id:'wechat',en:'WeChat Pay',zh:'微信支付 WeChat Pay',subEn:'Mainland wallet · not WeChat Pay HK',subZh:'內地錢包，非 WeChat Pay HK',logos:['wechatpay'],stripe:'wechat_pay'},
  {id:'alipayhk',en:'AlipayHK',zh:'AlipayHK 支付寶香港',subEn:'Hong Kong wallet · Airwallex',subZh:'香港錢包 · Airwallex',logos:['alipayhk'],provider:'airwallex'},
  {id:'wechat-hk',en:'WeChat Pay HK',zh:'WeChat Pay HK 微信支付香港',subEn:'Hong Kong wallet · Airwallex',subZh:'香港錢包 · Airwallex',logos:['wechatpay'],provider:'airwallex'},
  {id:'fps',en:'FPS',zh:'FPS 轉數快',subEn:'Hong Kong bank app · Airwallex',subZh:'香港銀行 App · Airwallex',logos:['fps'],provider:'airwallex'},
  {id:'unionpay',en:'UnionPay',zh:'銀聯 UnionPay',subEn:'UnionPay card · Airwallex',subZh:'銀聯卡 · Airwallex',logos:['unionpay'],provider:'airwallex'},
 ];
 function zh(){return String(window.TsunI18n?.locale||document.documentElement.lang||'en').toLowerCase().startsWith('zh');}
 function msg(a,b){return zh()?a:b;}
 function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e;}
 function preview(){return location.hostname.endsWith('.vercel.app');}
 function checkoutOrder(){return typeof currentOrder==='undefined'?null:currentOrder;}
 function pendingAirwallex(order){return Boolean(order?.airwallexSessionId&&order.paymentStatus!=='paid');}
 function init(){
  if(document.getElementById('tsunSpecificPaymentMethods'))return;
  const paypal=document.getElementById('paypalPaymentPanel');
  const stripe=document.getElementById('stripePaymentPanel');
  const paypalBtn=document.getElementById('paypalPayBtn');
  const stripeBtn=document.getElementById('stripePayBtn');
  if(!paypal||!stripe||!paypalBtn||!stripeBtn)return;
  paypal.hidden=true;stripe.hidden=true;paypal.style.display='none';stripe.style.display='none';
  const airwallex=document.getElementById('airwallexPaymentPanel');
  const airwallexBtn=document.getElementById('airwallexPayBtn');
  const recover=document.getElementById('airwallexRecoverBtn');
  const airwallexTest=typeof AIRWALLEX_TEST_CHECKOUT!=='undefined'&&AIRWALLEX_TEST_CHECKOUT;
  if(airwallex){airwallex.hidden=true;airwallex.style.display='none';}
  const available=choices.filter(choice=>choice.provider!=='airwallex'||(airwallexBtn&&recover));
  if(!document.getElementById('tsunSpecificPaymentMethodsStyle')){
   const link=el('link');link.id='tsunSpecificPaymentMethodsStyle';link.rel='stylesheet';link.href='/assets/tsun-payment-method-choice.css';document.head.append(link);
  }
  const panel=el('div','payment-panel');panel.id='tsunSpecificPaymentMethods';panel.setAttribute('role','group');panel.setAttribute('aria-label','Payment methods');
  const wrap=el('div','payment-code-box');panel.append(wrap);
  const heading=el('h3','tsun-method-title');const subtitle=el('p','tsun-method-subtitle');
  const buttons=el('div');buttons.id='tsunMethodButtons';buttons.setAttribute('role','radiogroup');
  const warning=el('small');warning.id='tsunMethodWarning';warning.setAttribute('role','status');warning.setAttribute('aria-live','polite');
  const continueButton=el('button','tsun-method-continue');continueButton.type='button';
  const foot=el('div','tsun-method-footnote');
  wrap.append(heading,subtitle,buttons,warning,continueButton,foot);
  paypal.parentNode.insertBefore(panel,paypal);
  if(recover){
   recover.classList.add('tsun-method-recover');
   wrap.insertBefore(recover,foot);
  }
  const initialOrder=checkoutOrder();
  let selected=initialOrder?.airwallexSelectedMethod||(airwallexTest?'alipayhk':'card');
  let openingPayment=false;
  const nodes=[];
  for(const choice of available){
   const b=el('button','tsun-method-option');b.type='button';b.dataset.tsunMethod=choice.id;b.setAttribute('role','radio');
   const indicator=el('span','tsun-method-indicator');indicator.setAttribute('aria-hidden','true');
   const copy=el('span','tsun-method-copy');const name=el('span','tsun-method-name');const detail=el('span','tsun-method-detail');
   const marks=el('span','tsun-method-logos');
   choice.logos.forEach(id=>{const logo=el('img','tsun-method-logo'+(choice.logos.length===1?' tsun-single-logo':''));logo.src='/assets/payment-logos/'+id+'.svg';logo.alt=id==='wechatpay'?'WeChat Pay':id;logo.loading='lazy';marks.append(logo);});
   copy.append(name,detail);b.append(indicator,copy,marks);buttons.append(b);nodes.push({choice,b,name,detail});
   b.addEventListener('click',()=>{selected=choice.id;warning.textContent='';refresh();});
  }
  function refresh(){
   const order=checkoutOrder();
   const pending=pendingAirwallex(order);
   if(!available.some(choice=>choice.id===selected&&(!pending||choice.provider==='airwallex'))){
    selected=pending?'alipayhk':'card';
   }
   const choice=available.find(choice=>choice.id===selected);
   heading.textContent=msg('選擇付款方式','Choose a payment method');
   subtitle.textContent=msg('安全加密付款 · Secure checkout','Secure checkout · Choose how to pay');
   continueButton.textContent=msg('確認付款','Continue to payment');
   if(choice?.provider==='airwallex'){
    subtitle.textContent=msg('在 Airwallex 付款頁選擇 '+choice.en+'.','Choose '+choice.en+' on the Airwallex payment page.');
    if(choice.id==='unionpay')subtitle.textContent=msg('在 Airwallex 付款頁輸入銀聯卡資料。','Enter your UnionPay card on the Airwallex payment page.');
   }
   if(pending){
    subtitle.textContent=msg('此訂單已有 Airwallex 付款連結。請打開原連結或查詢付款狀態。',
      'This order has an Airwallex payment link. Reopen it or check its payment status.');
    continueButton.textContent=msg('重新開啟付款頁','Reopen payment page');
   }
   if(recover){
    recover.hidden=!pending;
    recover.textContent=msg('查詢 Airwallex 付款狀態','Check Airwallex payment status');
   }
   foot.textContent=msg('付款由安全支付服務商處理','Payments processed securely');
   if(preview())continueButton.textContent=msg('檢視付款介面（不會扣款）','Preview only · No charge');
   continueButton.disabled=openingPayment;
   nodes.forEach(({choice,b,name,detail})=>{
     name.textContent=zh()?choice.zh:choice.en;detail.textContent=zh()?choice.subZh:choice.subEn;
     b.setAttribute('aria-checked',String(selected===choice.id));
     b.disabled=openingPayment||(pending&&choice.provider!=='airwallex');
   });
  }
  continueButton.addEventListener('click',async()=>{
   const choice=available.find(x=>x.id===selected);
   if(preview()){
     warning.textContent=msg('這是 Preview 測試版，已停用真實付款。正式上線前需完成測試。','This is a Preview build. Live payments are disabled to protect customers.');
     return;
   }
   const order=checkoutOrder();
   if(!choice||openingPayment||stripeBtn.disabled||paypalBtn.disabled||airwallexBtn?.disabled)return;
   if(order?.paymentStatus==='paid'){warning.textContent=msg('此訂單已付款，無需再次支付。','This order is already paid.');return;}
   if(pendingAirwallex(order)&&choice.provider!=='airwallex'){refresh();return;}
   if(choice.stripe){
    // The server expires an earlier unpaid Stripe Session before issuing a new
    // one for the newly selected method. The same order and previews are retained.
    window.__tsunStripeMethod=choice.stripe;
    if(choice.id==='apple'||choice.id==='google'){
      warning.textContent=msg('Stripe 會按裝置判斷是否提供 '+choice.en+'，否則可使用銀行卡。','Stripe will show '+choice.en+' only when eligible. You can use a bank card otherwise.');
    }else warning.textContent='';
    stripeBtn.click();
   }else if(choice.provider==='airwallex'){
    warning.textContent='';
    openingPayment=true;
    refresh();
    try{await startAirwallexCheckout(choice.id);}
    finally{openingPayment=false;refresh();}
   }else if(choice.provider==='paypal'){
    if(order?.stripeSessionId&&!order.stripeSessionRetired){
      // Do not leave an open Stripe link behind when moving to a different gateway.
      openingPayment=true;refresh();
      try{
        const response=await fetch('/api/create-checkout-session',{method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({action:'retireStripeSession',order,sessionId:order.stripeSessionId})});
        const result=await response.json().catch(()=>({}));
        if(!response.ok||!result.retired)throw new Error(result.error||'Unable to close previous checkout');
        order.stripeSessionRetired=true;order.stripeCheckoutPending=false;
        if(typeof updateStoredOrder==='function')updateStoredOrder(order);
      }catch(error){
        warning.textContent=msg('原付款狀態尚未確認，為避免重複扣款，請勿再付款。','The earlier checkout could not be safely closed. Please check its status before retrying.');
        return;
      }finally{openingPayment=false;refresh();}
    }
    warning.textContent='';paypalBtn.click();
   }
  });
  refresh();
  new MutationObserver(refresh).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
  panel.addEventListener('focusin',refresh);
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
