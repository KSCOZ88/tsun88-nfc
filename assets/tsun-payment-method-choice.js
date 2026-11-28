'use strict';
/* 8TSUN8 checkout. Payment marks are served locally. */
(function(){
 const choices=[
  {id:'card',en:'Credit / Debit Card',zh:'信用卡／扣賬卡',subEn:'Visa · Mastercard · Amex',subZh:'Visa · Mastercard · Amex',logos:['visa','mastercard','americanexpress'],stripe:'card'},
  {id:'apple',en:'Apple Pay',zh:'Apple Pay',subEn:'Shown by Stripe when supported',subZh:'Stripe 僅於支援時顯示',logos:['applepay'],stripe:'card'},
  {id:'google',en:'Google Pay',zh:'Google Pay',subEn:'Shown by Stripe when supported',subZh:'Stripe 僅於支援時顯示',logos:['googlepay'],stripe:'card'},
  {id:'paypal',en:'PayPal',zh:'PayPal',subEn:'Secure PayPal checkout',subZh:'使用 PayPal 安全付款',logos:['paypal'],provider:'paypal'},
  {id:'alipay',en:'Alipay',zh:'支付寶（內地版）',subEn:'Mainland wallet · Airwallex',subZh:'內地錢包 · Airwallex',logos:['alipay'],provider:'airwallex',qr:'alipaycn'},
  {id:'alipayhk',en:'AlipayHK',zh:'AlipayHK 支付寶香港',subEn:'Hong Kong wallet · Airwallex',subZh:'香港錢包 · Airwallex',logos:['alipayhk'],provider:'airwallex',qr:'alipayhk'},
  {id:'wechat',en:'WeChat Pay',zh:'微信支付 WeChat Pay',subEn:'Mainland and Hong Kong wallets · Airwallex',subZh:'內地及香港錢包 · Airwallex',logos:['wechatpay'],provider:'airwallex',qr:'wechatpay'},
  {id:'fps',en:'FPS',zh:'FPS 轉數快',subEn:'Hong Kong bank app · Airwallex',subZh:'香港銀行 App · Airwallex',logos:['fps'],provider:'airwallex',qr:'fps'},
  {id:'unionpay',en:'UnionPay',zh:'銀聯 UnionPay',subEn:'UnionPay card · Airwallex',subZh:'銀聯卡 · Airwallex',logos:['unionpay'],provider:'airwallex'},
 ];
 function zh(){return String(window.TsunI18n?.locale||document.documentElement.lang||'en').toLowerCase().startsWith('zh');}
 function msg(a,b){return zh()?a:b;}
 function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e;}
 function preview(){return location.hostname.endsWith('.vercel.app');}
 function checkoutOrder(){return typeof currentOrder==='undefined'?null:currentOrder;}
 function directMethod(order){return order?.airwallexQrMethod||(order?.airwallexFpsStarted?'fps':null);}
 function pendingAirwallex(order){return Boolean((order?.airwallexSessionId||directMethod(order))&&order.paymentStatus!=='paid');}
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
  const fpsTest=typeof AIRWALLEX_FPS_MERCHANT_TEST!=='undefined'&&AIRWALLEX_FPS_MERCHANT_TEST;
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
  const qrBox=el('section','tsun-fps-qr');
  qrBox.hidden=true;
  const qrImage=el('img');
  const qrInstructions=el('p');
  const qrStatus=el('p');qrStatus.setAttribute('role','status');
  qrBox.append(qrInstructions,qrImage,qrStatus);
  const changeMethod=el('button','secondary tsun-method-recover');
  changeMethod.type='button';
  changeMethod.addEventListener('click',()=>switchFromQr('card'));
  wrap.append(heading,subtitle,buttons,warning,continueButton,foot);
  wrap.insertBefore(qrBox,continueButton);
  wrap.insertBefore(changeMethod,foot);
  paypal.parentNode.insertBefore(panel,paypal);
  if(recover){
   recover.classList.add('tsun-method-recover');
   wrap.insertBefore(recover,foot);
  }
  const initialOrder=checkoutOrder();
  const previousChoice=initialOrder?.airwallexSelectedMethod;
  let selected=(previousChoice==='wechat-hk'?'wechat':previousChoice)||(fpsTest?'fps':airwallexTest?'alipayhk':'card');
  let openingPayment=false;
  const qrAvailability=new Map();
  let qrTimer;
  let qrOrder;
  let qrExpires=0;
  const qrEndpoint=method=>'/api/airwallex-create-session?channel=fps&paymentMethod='+encodeURIComponent(method);
  const nodes=[];
  for(const choice of available){
   const b=el('button','tsun-method-option');b.type='button';b.dataset.tsunMethod=choice.id;b.setAttribute('role','radio');
   const indicator=el('span','tsun-method-indicator');indicator.setAttribute('aria-hidden','true');
   const copy=el('span','tsun-method-copy');const name=el('span','tsun-method-name');const detail=el('span','tsun-method-detail');
   const marks=el('span','tsun-method-logos');
   choice.logos.forEach(id=>{const logo=el('img','tsun-method-logo'+(choice.logos.length===1?' tsun-single-logo':''));logo.src='/assets/payment-logos/'+id+'.svg';logo.alt=id==='wechatpay'?'WeChat Pay':id;logo.loading='lazy';marks.append(logo);});
   copy.append(name,detail);b.append(indicator,copy,marks);buttons.append(b);nodes.push({choice,b,name,detail});
   b.addEventListener('click',()=>{
    const active=directMethod(checkoutOrder());
    if(active&&choice.qr!==active){
     void switchFromQr(choice.id);
     return;
    }
    selected=choice.id;warning.textContent='';refresh();
   });
  }
  function refresh(){
   const order=checkoutOrder();
   const pending=pendingAirwallex(order);
   const active=pending&&directMethod(order);
   if(active)selected=available.find(choice=>choice.qr===active)?.id||selected;
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
   if(active||(choice?.qr&&qrAvailability.get(choice.qr)!==false&&!pending&&!preview())){
    subtitle.textContent=choice.qr==='fps'
     ?msg('用香港銀行 App 掃描轉數快二維碼。','Scan the FPS QR code with your Hong Kong banking app.')
     :msg('用 '+choice.zh+' App 掃描付款二維碼。','Scan the QR code with the '+choice.en+' app.');
    continueButton.textContent=qrOrder===order&&Date.now()>=qrExpires
     ?msg('更新付款二維碼','Refresh payment QR code')
     :msg('顯示付款二維碼','Show '+choice.en+' QR code');
   }else if(pending){
    subtitle.textContent=msg('此訂單已有 Airwallex 付款連結。請打開原連結或查詢付款狀態。',
      'This order has an Airwallex payment link. Reopen it or check its payment status.');
    continueButton.textContent=msg('重新開啟付款頁','Reopen payment page');
   }
   if(recover){
    recover.hidden=!pending||Boolean(active);
    recover.textContent=msg('查詢 Airwallex 付款狀態','Check Airwallex payment status');
   }
   foot.textContent=msg('付款由安全支付服務商處理','Payments processed securely');
   qrInstructions.textContent=msg('請在付款 App 確認金額後付款。','Check the amount in your app before approving payment.');
   qrImage.alt=msg('付款二維碼','Payment QR code');
   qrBox.hidden=!active||qrOrder!==order;
   changeMethod.hidden=!active;
   changeMethod.disabled=openingPayment;
   changeMethod.textContent=msg('更換付款方式','Change payment method');
   if(preview())continueButton.textContent=msg('檢視付款介面（不會扣款）','Preview only · No charge');
   continueButton.disabled=openingPayment;
   nodes.forEach(({choice,b,name,detail})=>{
     name.textContent=zh()?choice.zh:choice.en;detail.textContent=zh()?choice.subZh:choice.subEn;
     b.setAttribute('aria-checked',String(selected===choice.id));
     b.disabled=openingPayment||(!active&&pending&&choice.provider!=='airwallex');
   });
  }
  async function checkQr(order){
   if(order!==checkoutOrder()||!directMethod(order)||order.paymentStatus==='paid'||!document.getElementById('checkout')?.classList.contains('active'))return;
   const sessionId=order.airwallexSessionId;
   if(Date.now()>=qrExpires){
    qrImage.hidden=true;
    qrStatus.textContent=msg('二維碼已過期。可更新二維碼或等待付款確認。',
      'QR code expired. Show a new code or wait for payment confirmation.');
    refresh();
   }
   try{
    if(document.visibilityState==='visible'){
     const {id,customerEmail,items}=order;
     const response=await fetch('/api/airwallex-confirm-session',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({sessionId,order:{id,customerEmail,items:items.map(({decorItems})=>({decorItems}))}})});
     const confirmation=await response.json();
     if(order.airwallexSessionId!==sessionId||order!==checkoutOrder())return;
     if(response.ok&&confirmation.paid){
      location.assign('/?recover=1&order_id='+encodeURIComponent(id));
      return;
     }
    }
   }catch{}
   if(order.airwallexSessionId===sessionId&&Date.now()<qrExpires+2*60*1000)qrTimer=setTimeout(()=>checkQr(order),10000);
  }
  async function switchFromQr(next){
   const order=checkoutOrder();
   const method=directMethod(order);
   if(!method||order.paymentStatus==='paid'||openingPayment)return;
   openingPayment=true;
   warning.textContent=msg('正在取消掃碼付款…','Cancelling QR payment…');
   refresh();
   try{
    const {id,customerEmail,items,airwallexSessionId,airwallexFpsAttempt}=order;
    const response=await fetch(qrEndpoint(method),{method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({action:'cancel',order:{id,customerEmail,airwallexSessionId,airwallexFpsAttempt,
      items:items.map(({decorItems})=>({decorItems}))}})});
    const result=await response.json();
    if(order!==checkoutOrder())return;
    if(response.ok&&result.paid&&result.id){
     clearTimeout(qrTimer);
     order.airwallexSessionId=result.id;
     updateStoredOrder(order);
     location.assign('/?recover=1&order_id='+encodeURIComponent(id));
     return;
    }
    if(!response.ok||!result.cancelled||!Number.isInteger(result.attempt))throw Error();
    clearTimeout(qrTimer);
    delete order.airwallexSessionId;
    delete order.airwallexPaymentUrl;
    delete order.airwallexFpsStarted;
    delete order.airwallexQrMethod;
    delete order.airwallexSelectedMethod;
    order.airwallexCheckoutPending=false;
    order.airwallexFpsAttempt=result.attempt;
    updateStoredOrder(order);
    history.replaceState({},document.title,'/?checkout_resume='+encodeURIComponent(id));
    qrOrder=null;
    qrImage.removeAttribute('src');
    selected=next;
    warning.textContent='';
    refresh();
    nodes.find(node=>node.choice.id===next)?.b.scrollIntoView({block:'nearest',behavior:'smooth'});
   }catch{
    warning.textContent=msg('付款服務暫未確認取消。若你已付款，請等待確認。稍後可再試更換付款方式。',
     'Cancellation is still awaiting confirmation. If you paid, wait for confirmation. Try changing methods again shortly.');
   }finally{
    openingPayment=false;
    refresh();
   }
  }
  async function openQr(order,choice){
   clearTimeout(qrTimer);
   order.airwallexQrMethod=choice.qr;order.airwallexSelectedMethod=choice.id;
   if(choice.qr==='fps')order.airwallexFpsStarted=true;
   updateStoredOrder(order);
   const response=await fetch(qrEndpoint(choice.qr),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({order})});
   const result=await response.json().catch(()=>({}));
   if(!response.ok||!result.id)throw Error(result.error||'QR payment is temporarily unavailable.');
   if(order!==checkoutOrder())return;
   order.airwallexSessionId=result.id;order.airwallexCheckoutPending=true;
   updateStoredOrder(order);
   const resume='/?recover=1&order_id='+encodeURIComponent(order.id);
   history.replaceState({},document.title,resume+(fpsTest?'&fps_direct=1':''));
   if(result.paid){location.assign('/?recover=1&order_id='+encodeURIComponent(order.id));return;}
   qrOrder=order;qrExpires=result.expiresAt||Date.now()+60000;
   qrImage.hidden=!result.qrImage;
   if(result.qrImage)qrImage.src=result.qrImage;
   qrStatus.textContent=msg('等待付款確認…','Waiting for payment confirmation…');
   refresh();
   qrBox.scrollIntoView({block:'nearest',behavior:'smooth'});
   qrTimer=setTimeout(()=>checkQr(order),10000);
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
    try{
     if(choice.qr&&!order?.airwallexSessionId&&!qrAvailability.has(choice.qr)){
      try{
       const response=await fetch(qrEndpoint(choice.qr));
       const result=await response.json();
       if(!response.ok||typeof result.enabled!=='boolean')throw Error();
       qrAvailability.set(choice.qr,result.enabled);
      }catch{
       warning.textContent=msg('暫時未能開啟掃碼付款。請稍後重試。','QR payment is temporarily unavailable. Please try again.');
       return;
      }
     }
     const direct=choice.qr&&(directMethod(order)===choice.qr||(qrAvailability.get(choice.qr)&&!order?.airwallexSessionId));
     if(choice.id==='fps'&&fpsTest&&!direct){
      warning.textContent=order?.airwallexSessionId
       ?msg('此訂單已有付款連結。請先確認該筆付款的狀態。','This order already has a payment link. Check its status first.')
       :msg('暫時未能開啟轉數快。請稍後重試。','FPS is temporarily unavailable. Please try again.');
      return;
     }
     await startAirwallexCheckout(choice.id,direct?order=>openQr(order,choice):undefined);
    }
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
