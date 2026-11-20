'use strict';
/* 8TSUN8 checkout v2. Local SVG marks are sourced from Simple Icons. */
(function(){
 const choices=[
  {id:'card',en:'Credit / Debit Card',zh:'信用卡／扣賬卡',subEn:'Visa · Mastercard · Amex',subZh:'Visa · Mastercard · Amex',logos:['visa','mastercard','americanexpress'],stripe:'card'},
  {id:'apple',en:'Apple Pay',zh:'Apple Pay',subEn:'On compatible Apple devices',subZh:'適用於支援的 Apple 裝置',logos:['applepay'],stripe:'card'},
  {id:'google',en:'Google Pay',zh:'Google Pay',subEn:'On compatible browsers',subZh:'適用於支援的瀏覽器',logos:['googlepay'],stripe:'card'},
  {id:'alipay',en:'Alipay',zh:'支付寶 Alipay',subEn:'Mainland wallet · not AlipayHK',subZh:'內地錢包，非 AlipayHK',logos:['alipay'],stripe:'alipay'},
  {id:'wechat',en:'WeChat Pay',zh:'微信支付 WeChat Pay',subEn:'Mainland wallet · not WeChat Pay HK',subZh:'內地錢包，非 WeChat Pay HK',logos:['wechatpay'],stripe:'wechat_pay'},
  {id:'paypal',en:'PayPal',zh:'PayPal',subEn:'Secure PayPal checkout',subZh:'使用 PayPal 安全付款',logos:['paypal'],provider:'paypal'}
 ];
 function zh(){return String(window.TsunI18n?.locale||document.documentElement.lang||'en').toLowerCase().startsWith('zh');}
 function msg(a,b){return zh()?a:b;}
 function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e;}
 function preview(){return location.hostname.endsWith('.vercel.app');}
 function init(){
  if(document.getElementById('tsunSpecificPaymentMethods'))return;
  const paypal=document.getElementById('paypalPaymentPanel');
  const stripe=document.getElementById('stripePaymentPanel');
  const paypalBtn=document.getElementById('paypalPayBtn');
  const stripeBtn=document.getElementById('stripePayBtn');
  if(!paypal||!stripe||!paypalBtn||!stripeBtn)return;
  if(!document.getElementById('tsunSpecificPaymentMethodsStyle')){
   const link=el('link');link.id='tsunSpecificPaymentMethodsStyle';link.rel='stylesheet';link.href='/assets/tsun-payment-method-choice.css';document.head.append(link);
  }
  const panel=el('div','payment-panel');panel.id='tsunSpecificPaymentMethods';panel.setAttribute('role','group');panel.setAttribute('aria-label','Payment methods');
  const wrap=el('div','payment-code-box');panel.append(wrap);
  const heading=el('h3','tsun-method-title');const subtitle=el('p','tsun-method-subtitle');
  const buttons=el('div');buttons.id='tsunMethodButtons';buttons.setAttribute('role','radiogroup');
  const warning=el('small');warning.id='tsunMethodWarning';warning.setAttribute('role','status');warning.setAttribute('aria-live','polite');
  const total=el('div','tsun-method-total');const totalLabel=el('span');const totalValue=el('strong');
  total.append(totalLabel,totalValue);
  const continueButton=el('button','tsun-method-continue');continueButton.type='button';
  const foot=el('div','tsun-method-footnote');
  wrap.append(heading,subtitle,buttons,warning,total,continueButton,foot);
  paypal.parentNode.insertBefore(panel,paypal);
  paypal.hidden=true;stripe.hidden=true;paypal.style.display='none';stripe.style.display='none';
  const airwallex=document.getElementById('airwallexPaymentPanel');
  if(airwallex){const pending=typeof currentOrder!=='undefined'&&currentOrder?.airwallexSessionId&&currentOrder?.paymentStatus!=='paid';if(!pending){airwallex.hidden=true;airwallex.style.display='none';}}
  let selected='card';
  const nodes=[];
  for(const choice of choices){
   const b=el('button','tsun-method-option');b.type='button';b.dataset.tsunMethod=choice.id;b.setAttribute('role','radio');
   const indicator=el('span','tsun-method-indicator');indicator.setAttribute('aria-hidden','true');
   const copy=el('span','tsun-method-copy');const name=el('span','tsun-method-name');const detail=el('span','tsun-method-detail');
   const marks=el('span','tsun-method-logos');
   choice.logos.forEach(id=>{const logo=el('img','tsun-method-logo'+(choice.logos.length===1?' tsun-single-logo':''));logo.src='/assets/payment-logos/'+id+'.svg';logo.alt=id==='wechatpay'?'WeChat Pay':id;logo.loading='lazy';marks.append(logo);});
   copy.append(name,detail);b.append(indicator,copy,marks);buttons.append(b);nodes.push({choice,b,name,detail});
   b.addEventListener('click',()=>{selected=choice.id;warning.textContent='';refresh();});
  }
  function refresh(){
   heading.textContent=msg('選擇付款方式','Choose a payment method');
   subtitle.textContent=msg('安全加密付款 · Secure checkout','Secure checkout · Choose how to pay');
   totalLabel.textContent=msg('訂單總額','Order total');
   const order=typeof currentOrder!=='undefined'?currentOrder:null;
   const amount=order?.pricing?.total;
   totalValue.textContent=typeof amount==='number'&&Number.isFinite(amount)?'HK$'+amount.toFixed(2):'';
   total.hidden=!totalValue.textContent;
   continueButton.textContent=msg('確認付款','Continue to payment');
   foot.textContent=msg('付款由安全支付服務商處理','Payments processed securely');
   if(preview())continueButton.textContent=msg('預覽付款介面','Preview payment interface');
   nodes.forEach(({choice,b,name,detail})=>{
     name.textContent=zh()?choice.zh:choice.en;detail.textContent=zh()?choice.subZh:choice.subEn;
     b.setAttribute('aria-checked',String(selected===choice.id));
   });
  }
  continueButton.addEventListener('click',()=>{
   const choice=choices.find(x=>x.id===selected);
   if(preview()){
     warning.textContent=msg('這是 Preview 測試版，已停用真實付款。正式上線前需完成測試。','This is a Preview build. Live payments are disabled to protect customers.');
     return;
   }
   const order=typeof currentOrder!=='undefined'?currentOrder:null;
   if(choice.stripe){
    if(order?.stripeSessionId&&(!order.stripeSelectedMethod||order.stripeSelectedMethod!==choice.stripe)){
      warning.textContent=msg('此訂單已有不同支付方式的待處理付款連結。為防止重複扣款，請聯絡商戶處理。','This order already has a pending session for a different method. Contact the merchant before switching.');
      return;
    }
    window.__tsunStripeMethod=choice.stripe;
    if(choice.id==='apple'||choice.id==='google'){
      warning.textContent=msg('Stripe 會按裝置判斷是否提供 '+choice.en+'，否則可使用銀行卡。','Stripe will show '+choice.en+' only when eligible. You can use a bank card otherwise.');
    }else warning.textContent='';
    stripeBtn.click();
   }else if(choice.provider==='paypal'){warning.textContent='';paypalBtn.click();}
  });
  refresh();
  new MutationObserver(refresh).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
  panel.addEventListener('focusin',refresh);
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
