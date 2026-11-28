#!/usr/bin/env python3
from pathlib import Path
p=Path("index.html")
s=p.read_text(encoding="utf-8")
test_checkout="""const AIRWALLEX_TEST_CHECKOUT=!PROFILE_PREVIEW_MODE && location.protocol==='https:'
  && location.hostname==='www.8tsun8.com' && location.pathname==='/'
  && new URLSearchParams(location.search).get('airwallex_test')==='1';"""
if test_checkout not in s:
    anchor='function shouldResumeAirwallexOrder(){'
    if s.count(anchor)!=1: raise SystemExit("Airwallex startup anchor changed")
    s=s.replace(anchor,test_checkout+'\n'+anchor)
anchor='<div class="action-row"><button type="button" class="secondary" data-go="petProfile">'
if 'id="airwallexPaymentPanel"' not in s:
    if s.count(anchor)!=1: raise SystemExit("Checkout anchor changed")
    panel='''<div class="payment-panel" id="airwallexPaymentPanel" role="group" aria-label="Airwallex secure payment" style="margin-top:14px"><div class="payment-code-box" style="gap:12px"><b style="font-size:20px">Airwallex · Secure Checkout</b><small class="payment-scan-note" id="airwallexPaymentHelp">Payment opens in another tab. Return here to check payment status and enter delivery details.</small><button type="button" class="primary demo-pay-btn" id="airwallexPayBtn" style="background:#153e52;color:#fff">Pay with Airwallex</button><button type="button" class="secondary" id="airwallexRecoverBtn" hidden>Check Airwallex Payment Status</button></div></div>'''
    s=s.replace(anchor,panel+anchor)
start=s.find('async function startAirwallexCheckout(')
end=s.find('\nfunction setPostPaymentCompletion(',start)
if end<0: end=s.find('\nfunction preparePaidOrderScreen(',start)
if start<0 or end<0: raise SystemExit("Checkout handler changed")
replacement='''async function startAirwallexCheckout(preferredMethod){
 if(!ensureCheckoutProfiles())return;
 if(currentOrder&&!validateOrderPhoneConfirmations(currentOrder.items||[captureTagDesign()]))return;
 if(LOCAL_FILE_REVIEW){openLocalPostPaymentPreview();return;}
 if(PROFILE_PREVIEW_MODE){openOriginalProfilePreview();return;}
 if(!currentOrder||!validateCustomerEmail())return;
 const button=document.getElementById('airwallexPayBtn');
 if(button?.disabled)return;
 if(currentOrder.paymentStatus==='paid'||currentOrder.paypalOrderId){
  const zh=window.TsunI18n?.locale==='zh-Hant';
  toast(zh?'請先核對此訂單原有的付款狀態。':'Check the payment status of this order before continuing.',9000);
  return;
 }
 const paymentTab=window.open('about:blank','_blank');
 if(paymentTab)paymentTab.opener=null;
 if(button){button.disabled=true;button.textContent='Opening Airwallex…';}
 try{
  if(currentOrder.stripeSessionId&&!currentOrder.stripeSessionRetired){
   const response=await fetch('/api/create-checkout-session',{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({action:'retireStripeSession',order:currentOrder,sessionId:currentOrder.stripeSessionId})});
   const result=await response.json().catch(()=>({}));
   if(!response.ok||!result.retired){
    const zh=window.TsunI18n?.locale==='zh-Hant';
    throw new Error(zh?'請先核對原 Stripe 付款的狀態。':'Check the earlier Stripe payment status before continuing.');
   }
   currentOrder.stripeSessionRetired=true;currentOrder.stripeCheckoutPending=false;
   updateStoredOrder(currentOrder);
  }
  currentOrder.customerEmail=state.customerEmail;currentOrder.payMethod='Airwallex';
  currentOrder.status='等待付款';currentOrder.pricing=calculateOrderPricing(currentOrder.items||[]);
  updateStoredOrder(currentOrder);
  let url=currentOrder.airwallexPaymentUrl;
  if(!currentOrder.airwallexSessionId||!url){
   const response=await fetch(AIRWALLEX_CREATE_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({order:currentOrder})});
   const result=await response.json().catch(()=>({}));
   if(!response.ok||!result.url||!result.id||result.kind!=='payment_link')throw new Error(result.error||'Airwallex payment is not available');
   if(!/^https:\\/\\/([a-z0-9-]+\\.)*airwallex\\.com\\//i.test(result.url))throw new Error('Invalid Airwallex payment URL');
   currentOrder.airwallexSessionId=result.id;currentOrder.airwallexPaymentUrl=result.url;
   currentOrder.airwallexCheckoutPending=true;currentOrder.airwallexCheckoutStartedAt=new Date().toISOString();
   if(typeof preferredMethod==='string')currentOrder.airwallexSelectedMethod=preferredMethod;
   updateStoredOrder(currentOrder);url=result.url;
  }
  const recover=document.getElementById('airwallexRecoverBtn');if(recover)recover.hidden=false;
  toast('After payment, return to this tab and check Airwallex payment status.',9000);
  if(paymentTab&&!paymentTab.closed){paymentTab.location.replace(url);paymentTab.focus();}else location.assign(url);
 }catch(error){if(paymentTab&&!paymentTab.closed)paymentTab.close();toast(error.message||'Airwallex is temporarily unavailable',9000);}
 finally{if(button){button.disabled=false;renderPaymentOrder(currentOrder);}}
}
'''
s=s[:start]+replacement+s[end:]
old_start="const paidButton=document.getElementById('airwallexPayBtn');"
pos=s.find(old_start)
if pos<0: raise SystemExit("Airwallex price renderer changed")
line_end=s.find("\n",pos)
s=s[:pos]+"""const paidButton=document.getElementById('airwallexPayBtn');if(paidButton&&!paidButton.disabled){const zh=window.TsunI18n?.locale==='zh-Hant';paidButton.textContent=(PROFILE_PREVIEW_MODE||LOCAL_FILE_REVIEW)?(zh?'預覽模式，不會付款':'Preview only · No payment'):(zh?'使用 Airwallex 付款 · ':'Pay with Airwallex · ')+money(pricing.total);}
  const awxHelp=document.getElementById('airwallexPaymentHelp');if(awxHelp)awxHelp.textContent=window.TsunI18n?.locale==='zh-Hant'?'付款在新分頁開啟。付款後返回此分頁，檢查付款狀態並填寫配送資料。':'Payment opens in another tab. After paying, return here, check payment status, and fill in delivery details.';"""+s[line_end:]
# Recover a paid Payment Link when the buyer returns to the checkout tab.
# Does not create a new link or charge the buyer; the existing server API verifies payment first.
recovery = r'''<script id="tsun-airwallex-return-check">
(function(){
 let lastAttempt=0;
 let pendingTimer=null;
 function check(){
   // The live test leaves confirmation to the tester after checking Webhook delivery.
   if(AIRWALLEX_TEST_CHECKOUT||new URLSearchParams(location.search).get('recover')==='1')return;
   if(document.visibilityState!=='visible')return;
   const button=document.getElementById('airwallexRecoverBtn');
   if(!button||button.hidden||button.disabled)return;
   if(Date.now()-lastAttempt<15000)return;
   lastAttempt=Date.now();
   button.click();
 }
 function soon(){
   if(pendingTimer)clearTimeout(pendingTimer);
   pendingTimer=setTimeout(check,1200);
 }
 window.addEventListener('focus',soon);
 document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')soon();});
 window.addEventListener('pageshow',soon);
 document.addEventListener('DOMContentLoaded',soon);
 // While the checkout tab remains open, recheck pending links without another payment attempt.
 setInterval(function(){if(document.visibilityState==='visible')check();},30000);
})();
</script>'''
if 'id="tsun-airwallex-return-check"' not in s:
    if s.count('</body>')!=1: raise SystemExit("Checkout body marker changed")
    s=s.replace('</body>',recovery+'</body>')

def replace_once(old, new):
    global s
    if new in s: return
    if s.count(old)!=1: raise SystemExit("Airwallex completion anchor changed")
    s=s.replace(old,new)

replace_once(
    "function preparePaidOrderScreen(order){",
    """function setPostPaymentCompletion(completed){
  document.getElementById('paidNfcSummary').hidden=completed;
  document.getElementById('submitPostPaymentNfc').parentNode.style.display=completed?'none':'';
  document.getElementById('customerOrderStatus').hidden=completed;
  document.getElementById('completeOrderBtn').hidden=!completed;
  if(completed){
    const subtitle=document.getElementById('orderSuccessSubtitle');
    subtitle.textContent=window.TsunI18n?.locale==='zh-Hant'
      ?'配送資料及寵物檔案已保存。':'Shipping details and pet profile have been saved.';
  }
}
function preparePaidOrderScreen(order){
  setPostPaymentCompletion(false);""",
)
replace_once(
    'id="editNfcProfileBtn">回去完善宠物档案</button>',
    'id="editNfcProfileBtn">查看或修改宠物资料</button>',
)
replace_once(
    "if(shippingForm)shippingForm.hidden=true;if(complete)complete.hidden=false;",
    "if(shippingForm)shippingForm.hidden=true;setPostPaymentCompletion(true);",
)
replace_once(
    "  if(order.status==='已付款'&&order.paymentStatus==='paid'&&order.airwallexOrderToken){",
    """  if(order.status==='资料已完善'&&order.paymentStatus==='paid'&&order.airwallexOrderToken&&order.cloudProfile){
    preparePaidOrderScreen(order);
    for(const name of ['shipName','shipPhone','shipAddress']){
      state[name]=order[name]||'';
      document.getElementById(name).value=state[name];
    }
    go('orderSuccess');showNfcLinks(order.cloudProfile);
    document.getElementById('postPaymentShippingForm').hidden=true;
    document.getElementById('postPaymentNfcForm').hidden=true;
    setPostPaymentCompletion(true);
    history.replaceState({},document.title,location.pathname+location.hash);
    return;
  }
  if(order.status==='已付款'&&order.paymentStatus==='paid'&&order.airwallexOrderToken){""",
)
p.write_text(s,encoding="utf-8")
print("Patched",len(s),"characters")
