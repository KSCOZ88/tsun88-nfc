#!/usr/bin/env python3
from pathlib import Path
p=Path("index.html")
s=p.read_text(encoding="utf-8")
def once(old,new,label):
    global s
    count=s.count(old)
    if count==0 and label in s:
        return
    if count!=1:
        raise SystemExit(f"{label}: expected one anchor, found {count}")
    s=s.replace(old,new)
if 'id="stripePaymentPanel"' not in s:
    paypal='''<div class="payment-panel" id="paypalPaymentPanel" role="group" aria-label="Secure PayPal Checkout" style="margin-top:14px"><div class="payment-code-box" style="gap:12px"><b id="paypalPanelTitle" translate="no">Secure PayPal Checkout</b><small id="paypalPanelDescription" class="payment-scan-note" translate="no">Pay securely on PayPal. Your total is verified by our server. Return to enter delivery details after payment.</small><button type="button" class="primary demo-pay-btn" id="paypalPayBtn" translate="no" style="background:#ffc439;color:#173a64">Pay with PayPal</button><button type="button" class="secondary" id="paypalRecoverBtn" hidden translate="no">Check PayPal Payment Status</button><small id="paypalPaymentStatus" aria-live="polite"></small></div></div>'''
    stripe=paypal+'''\n  <div class="payment-panel" id="stripePaymentPanel" role="group" aria-label="Secure Stripe Checkout" style="margin-top:14px"><div class="payment-code-box" style="gap:12px"><b>Stripe · Secure Checkout</b><small class="payment-scan-note">Pay securely by card and supported local payment methods. Your payment is verified by Stripe.</small><button type="button" class="primary demo-pay-btn" id="stripePayBtn" style="background:#635bff;color:#fff">Pay with Stripe</button></div></div>'''
    once(paypal,stripe,"PayPal panel")
if "const STRIPE_CREATE_ENDPOINT=" not in s:
    once("const PAYPAL_EMAIL_ENDPOINT=PAYMENT_API_ORIGIN+'/api/paypal-paid-order-email';",
         "const PAYPAL_EMAIL_ENDPOINT=PAYMENT_API_ORIGIN+'/api/paypal-paid-order-email';\nconst STRIPE_CREATE_ENDPOINT=PAYMENT_API_ORIGIN+'/api/create-checkout-session';\nconst STRIPE_CONFIRM_ENDPOINT=PAYMENT_API_ORIGIN+'/api/confirm-paid-order';\nconst STRIPE_EMAIL_ENDPOINT=PAYMENT_API_ORIGIN+'/api/paid-order-email';",
         "payment API constants")
if "const isStripe=order.payMethod==='Stripe'" not in s:
    once("""  const isPaypal=order.payMethod==='PayPal';
  if(isPaypal?(!order.paypalOrderId||!order.paypalOrderToken):(!order.airwallexSessionId||!order.airwallexOrderToken))return {ok:false,customerSent:false,merchantSent:false,error:'付款尚未通过服务器核验'};
  try{
    const response=await fetch(isPaypal?PAYPAL_EMAIL_ENDPOINT:AIRWALLEX_EMAIL_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:stage,sessionId:order.airwallexSessionId,paypalOrderId:order.paypalOrderId,orderToken:isPaypal?order.paypalOrderToken:order.airwallexOrderToken,order,previews,attachments})});""",
"""  const isPaypal=order.payMethod==='PayPal',isStripe=order.payMethod==='Stripe';
  if(isPaypal?(!order.paypalOrderId||!order.paypalOrderToken):isStripe?(!order.stripeSessionId||!order.stripeOrderToken):(!order.airwallexSessionId||!order.airwallexOrderToken))return {ok:false,customerSent:false,merchantSent:false,error:'付款尚未通过服务器核验'};
  try{
    const endpoint=isPaypal?PAYPAL_EMAIL_ENDPOINT:isStripe?STRIPE_EMAIL_ENDPOINT:AIRWALLEX_EMAIL_ENDPOINT;
    const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:stage,sessionId:isStripe?order.stripeSessionId:order.airwallexSessionId,paypalOrderId:order.paypalOrderId,orderToken:isPaypal?order.paypalOrderToken:isStripe?order.stripeOrderToken:order.airwallexOrderToken,order,previews,attachments})});""",
         "payment email router")
if "async function startStripeCheckout()" not in s:
    stripe_handlers="""async function startStripeCheckout(){
  if(!ensureCheckoutProfiles())return;
  if(currentOrder&&!validateOrderPhoneConfirmations(currentOrder.items||[captureTagDesign()]))return;
  if(LOCAL_FILE_REVIEW||PROFILE_PREVIEW_MODE){toast('本地预览不能发起真实付款');return;}
  if(!currentOrder||!validateCustomerEmail())return;
  const button=document.getElementById('stripePayBtn');
  if(button){button.disabled=true;button.textContent='正在打开 Stripe…';}
  try{
    currentOrder.customerEmail=state.customerEmail;currentOrder.payMethod='Stripe';currentOrder.status='等待付款';currentOrder.pricing=calculateOrderPricing(currentOrder.items||[]);updateStoredOrder(currentOrder);
    const response=await fetch(STRIPE_CREATE_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({order:currentOrder})});
    const result=await response.json().catch(()=>({}));if(!response.ok||!result.url||!result.id)throw new Error(result.error||'Stripe 暂时无法打开付款页面');
    currentOrder.stripeSessionId=result.id;currentOrder.stripeCheckoutPending=true;updateStoredOrder(currentOrder);
    location.assign(result.url);
  }catch(error){toast(error.message||'Stripe 暂时不可用，请稍后再试。',9000);if(button){button.disabled=false;renderPaymentOrder(currentOrder);}}
}
async function handleStripeReturn(){
  if(PROFILE_PREVIEW_MODE)return;
  const params=new URLSearchParams(location.search),result=params.get('stripe_return');
  if(!['success','cancelled'].includes(result))return;
  document.getElementById('tsunEnterGate')?.remove();
  const orderId=params.get('order_id'),order=orderId?loadOrders().find(o=>o.id===orderId):null;
  if(!order){toast('本浏览器找不到该订单，请使用发起付款的设备或联系客服核实。',9000);return;}
  currentOrder=order;cartDesigns=order.items||[];currentCartIndex=0;applyTagDesign({...order.items?.[0],nfcProfile:order.nfcProfile});go('checkout');renderPaymentOrder(order);
  if(result==='cancelled'){history.replaceState({},document.title,location.pathname+location.hash);toast('已返回网站，尚未确认付款。你可以重新选择付款方式。');return;}
  const sessionId=params.get('session_id');
  if(!sessionId||!/^cs_live_/.test(sessionId)||sessionId!==order.stripeSessionId){toast('Stripe 付款编号与订单不匹配，请联系客服核实。',9000);return;}
  if(order.paymentStatus==='paid'&&order.stripeOrderToken){preparePaidOrderScreen(order);go('orderSuccess');history.replaceState({},document.title,location.pathname+location.hash);return;}
  try{
    toast('正在核实 Stripe 付款状态…',7000);
    const response=await fetch(STRIPE_CONFIRM_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId,order})});
    const confirmation=await response.json().catch(()=>({}));if(!response.ok||!confirmation.paid||!confirmation.orderToken)throw new Error(confirmation.error||'Stripe 尚未确认付款');
    order.status='已付款';order.paymentStatus='paid';order.payMethod='Stripe';order.stripeOrderToken=confirmation.orderToken;order.stripeCheckoutPending=false;order.paymentTransactionId=confirmation.paymentIntentId;order.paidAmountCents=confirmation.amountTotal;order.paidAt=new Date().toISOString();order.nfcStatus='等待客户填写';
    updateStoredOrder(order);currentOrder=order;preparePaidOrderScreen(order);if(!state.nfcProfile.breed)syncNfcBreedFromSelection();go('orderSuccess');
    history.replaceState({},document.title,location.pathname+location.hash);openPaymentSuccess();startPaymentEmail(order);
  }catch(error){go('checkout');renderPaymentOrder(order);toast((error.message||'付款核验失败')+'。如果已经扣款，请不要重复支付，先联系客服核对。',10000);}
}
"""
    once("async function startAirwallexCheckout(){",stripe_handlers+"async function startAirwallexCheckout(){","Stripe checkout handlers")
if "const stripeButton=document.getElementById('stripePayBtn')" not in s:
    once("  const paypalButton=document.getElementById('paypalPayBtn');if(paypalButton&&!paypalButton.dataset.bound){paypalButton.dataset.bound='1';paypalButton.addEventListener('click',startPaypalCheckout);}",
         "  const paypalButton=document.getElementById('paypalPayBtn');if(paypalButton&&!paypalButton.dataset.bound){paypalButton.dataset.bound='1';paypalButton.addEventListener('click',startPaypalCheckout);}\n  const stripeButton=document.getElementById('stripePayBtn');if(stripeButton&&!stripeButton.dataset.bound){stripeButton.dataset.bound='1';stripeButton.addEventListener('click',startStripeCheckout);}",
         "Stripe button binding")
if "handleStripeReturn();" not in s:
    once("  handleAirwallexReturn();\n  handlePaypalReturn();","  handleAirwallexReturn();\n  handlePaypalReturn();\n  handleStripeReturn();","Stripe return recovery")
p.write_text(s,encoding="utf-8")
print("Stripe checkout patch applied")
