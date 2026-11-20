'use strict';
/* 8TSUN8 customer-facing payment choices. Gateway credentials and paid verification stay server-side. */
(function(){
 const choices=[
  {id:'card',nameEn:'Credit / Debit Card',nameZh:'信用卡／扣賬卡',detailEn:'Visa · Mastercard · supported cards',detailZh:'Visa · Mastercard · 支援的銀行卡',stripe:'card'},
  {id:'apple',nameEn:'Apple Pay',nameZh:'Apple Pay',detailEn:'Available on eligible Apple devices',detailZh:'須使用符合條件的 Apple 裝置',stripe:'card'},
  {id:'google',nameEn:'Google Pay',nameZh:'Google Pay',detailEn:'Available on eligible browsers',detailZh:'須使用符合條件的瀏覽器',stripe:'card'},
  {id:'alipay',nameEn:'Alipay',nameZh:'支付寶 Alipay',detailEn:'Mainland Alipay wallet · not AlipayHK',detailZh:'內地支付寶錢包，非 AlipayHK',stripe:'alipay'},
  {id:'wechat',nameEn:'WeChat Pay',nameZh:'微信支付 WeChat Pay',detailEn:'Mainland WeChat Pay · not WeChat Pay HK',detailZh:'內地微信支付，非 WeChat Pay HK',stripe:'wechat_pay'},
  {id:'paypal',nameEn:'PayPal',nameZh:'PayPal',detailEn:'Secure PayPal checkout',detailZh:'使用 PayPal 安全付款',provider:'paypal'}
 ];
 function zh(){return String(window.TsunI18n?.locale||document.documentElement.lang||'en').toLowerCase().startsWith('zh');}
 function msg(zhText,enText){return zh()?zhText:enText;}
 function init(){
  if(document.getElementById('tsunSpecificPaymentMethods'))return;
  const paypal=document.getElementById('paypalPaymentPanel');
  const stripe=document.getElementById('stripePaymentPanel');
  const paypalBtn=document.getElementById('paypalPayBtn');
  const stripeBtn=document.getElementById('stripePayBtn');
  if(!paypal||!stripe||!paypalBtn||!stripeBtn)return;
  const panel=document.createElement('div');
  panel.id='tsunSpecificPaymentMethods';
  panel.className='payment-panel';
  panel.setAttribute('role','group');
  panel.style.marginTop='14px';
  panel.innerHTML='<div class="payment-code-box" style="gap:12px"><b id="tsunMethodHeading"></b><small class="payment-scan-note" id="tsunMethodExplanation"></small><div id="tsunMethodButtons" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px"></div><small id="tsunMethodWarning" aria-live="polite"></small></div>';
  paypal.parentNode.insertBefore(panel,paypal);
  paypal.hidden=true;stripe.hidden=true;
  const airwallex=document.getElementById('airwallexPaymentPanel');
  // Preserve the legacy recovery UI for unpaid orders that already have an Airwallex session.
  if(airwallex&&!window.currentOrder?.airwallexSessionId)airwallex.hidden=true;
  const holder=panel.querySelector('#tsunMethodButtons');
  for(const choice of choices){
   const button=document.createElement('button');
   button.type='button';button.className='secondary';button.dataset.tsunMethod=choice.id;
   button.style.cssText='display:flex;flex-direction:column;align-items:flex-start;gap:4px;text-align:left;min-height:68px;padding:12px;border:1px solid #b9c6cb;border-radius:10px;background:transparent;color:inherit;cursor:pointer';
   const name=document.createElement('strong'), detail=document.createElement('small');
   button.append(name,detail);holder.append(button);
   choice.button=button;choice.nameNode=name;choice.detailNode=detail;
   button.addEventListener('click',function(){
    const order=typeof currentOrder!=='undefined'?currentOrder:null;
    if(choice.stripe){
     // Existing sessions are tied to the selected payment method. Do not silently reuse
     // a session for a different method, because the store is idempotent by order id.
     if(order?.stripeSessionId&&(!order.stripeSelectedMethod||order.stripeSelectedMethod!==choice.stripe)){
      const warning=msg('此訂單已有待處理的 Stripe 付款連結，無法直接改用另一付款方式。請先完成原有付款或聯絡商戶處理。','This order already has a Stripe payment session for another payment method. Finish that session or contact the merchant before switching.');
      panel.querySelector('#tsunMethodWarning').textContent=warning;
      return;
     }
     window.__tsunStripeMethod=choice.stripe;
     if(choice.id==='apple'||choice.id==='google')panel.querySelector('#tsunMethodWarning').textContent=msg('Stripe 會按裝置及瀏覽器判斷是否顯示 '+choice.nameEn+'；若不支援，可使用銀行卡。','Stripe decides whether to show '+choice.nameEn+' on this device. Card payment remains available.');
     else panel.querySelector('#tsunMethodWarning').textContent='';
     stripeBtn.click();
    }else if(choice.provider==='paypal'){
     panel.querySelector('#tsunMethodWarning').textContent='';
     paypalBtn.click();
    }
   });
  }
  function translate(){
   panel.querySelector('#tsunMethodHeading').textContent=msg('選擇付款方式','Choose a payment method');
   panel.querySelector('#tsunMethodExplanation').textContent=msg('選擇支付方式後將開啟安全付款頁面。Apple Pay、Google Pay 是否顯示取決於你的裝置。','You will continue to secure checkout. Apple Pay and Google Pay depend on device eligibility.');
   for(const c of choices){c.nameNode.textContent=zh()?c.nameZh:c.nameEn;c.detailNode.textContent=zh()?c.detailZh:c.detailEn;}
  }
  translate();
  new MutationObserver(translate).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
