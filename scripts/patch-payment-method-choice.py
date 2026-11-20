#!/usr/bin/env python3
"""Idempotent customer-facing payment-method UI patch, applied after Stripe checkout patch."""
from pathlib import Path
p=Path("index.html")
s=p.read_text(encoding="utf-8")
start=s.find("async function startStripeCheckout(){")
end=s.find("async function handleStripeReturn(){",start)
if start<0 or end<0:
    raise SystemExit("Payment choices: Stripe checkout handler not found")
block=s[start:end]
if "paymentMethod:window.__tsunStripeMethod" not in block:
    needle="body:JSON.stringify({order:currentOrder,previews"
    position=block.find(needle)
    if position<0 or block.find(needle,position+1)>=0:
        raise SystemExit("Payment choices: missing or ambiguous Stripe request")
    finish=block.find("})",position)
    if finish<0:
        raise SystemExit("Payment choices: malformed Stripe request")
    old=block[position:finish+2]
    if ",locale:" not in old:
        replacement=old[:-2]+",locale:String(window.TsunI18n?.locale||document.documentElement.lang||'en').toLowerCase().startsWith('zh')?'zh-HK':'en',paymentMethod:window.__tsunStripeMethod||'card'})"
    else:
        replacement=old[:-2]+",paymentMethod:window.__tsunStripeMethod||'card'})"
    block=block[:position]+replacement+block[finish+2:]
# Keep payment method in local order to prevent reusing a different method's session.
anchor="currentOrder.customerEmail=state.customerEmail;currentOrder.payMethod='Stripe';"
updated="currentOrder.customerEmail=state.customerEmail;currentOrder.stripeSelectedMethod=window.__tsunStripeMethod||'card';currentOrder.payMethod='Stripe';"
if updated not in block:
    if block.count(anchor)!=1:
        raise SystemExit("Payment choices: Stripe order assignment changed")
    block=block.replace(anchor,updated)
# Preserve the chosen Checkout method only once the server has returned a valid session.
# Mark the previous session for server-side expiry if the customer selects a different method.
old_assignment="currentOrder.customerEmail=state.customerEmail;currentOrder.stripeSelectedMethod=window.__tsunStripeMethod||'card';currentOrder.payMethod='Stripe';"
new_assignment="const chosenStripeMethod=window.__tsunStripeMethod||'card';const switchingStripeMethod=Boolean(currentOrder.stripeSessionId&&(currentOrder.stripeSessionRetired||(currentOrder.stripeSelectedMethod||'card')!==chosenStripeMethod));currentOrder.customerEmail=state.customerEmail;currentOrder.payMethod='Stripe';"
if old_assignment in block:
    block=block.replace(old_assignment,new_assignment)
if "switchPaymentMethod:switchingStripeMethod" not in block:
    needle="paymentMethod:window.__tsunStripeMethod||'card'"
    if block.count(needle)!=1: raise SystemExit("Payment choice: cannot locate method in Stripe body")
    block=block.replace(needle,needle+",switchPaymentMethod:switchingStripeMethod")
if "currentOrder.stripeSelectedMethod=chosenStripeMethod;" not in block:
    needle="currentOrder.stripeSessionId=result.id;"
    if block.count(needle)!=1: raise SystemExit("Payment choice: session assignment missing")
    block=block.replace(needle,needle+"currentOrder.stripeSelectedMethod=chosenStripeMethod;currentOrder.stripeSessionRetired=false;")
# Preserve the pending order URL in browser history before leaving for Stripe.
# Browser Back and Stripe's cancel URL will both lead to the same order checkout.
if "checkout_resume='+encodeURIComponent(currentOrder.id)" not in block:
    needle="location.assign(result.url);"
    if block.count(needle)!=1: raise SystemExit("Payment choice: Stripe redirect missing")
    block=block.replace(needle,"history.replaceState({},document.title,location.pathname+'?checkout_resume='+encodeURIComponent(currentOrder.id));"+needle)
s=s[:start]+block+s[end:]
script='<script src="/assets/tsun-payment-method-choice.js" defer></script>'
if script not in s:
    if s.count('</body>')!=1:
        raise SystemExit("Payment choices: expected one closing body")
    s=s.replace('</body>',script+'\n</body>')
# On a browser Back navigation, the original site otherwise boots at Home.
# This runs after the site's own return handlers have been scheduled.
resume_handler="""function handleCheckoutResume(){
  const params=new URLSearchParams(location.search);
  const orderId=params.get('checkout_resume');
  if(!orderId||params.has('stripe_return'))return;
  const order=loadOrders().find(o=>o.id===orderId);
  if(!order){history.replaceState({},document.title,location.pathname);return;}
  if(order.paymentStatus==='paid'){history.replaceState({},document.title,location.pathname);return;}
  currentOrder=order;cartDesigns=order.items||[];currentCartIndex=0;
  if(order.customerEmail)state.customerEmail=order.customerEmail;
  applyTagDesign({...order.items?.[0],nfcProfile:order.nfcProfile});
  go('checkout');renderPaymentOrder(order);
  history.replaceState({},document.title,location.pathname+location.hash);
}
"""
if "function handleCheckoutResume(){" not in s:
    needle="async function startStripeCheckout(){"
    if s.count(needle)!=1:raise SystemExit("Checkout resume: handler anchor missing")
    s=s.replace(needle,resume_handler+needle)
if "  handleCheckoutResume();" not in s:
    needle="  handleStripeReturn();"
    if s.count(needle)!=1:raise SystemExit("Checkout resume: startup anchor missing")
    s=s.replace(needle,needle+"\n  handleCheckoutResume();")
# Restore the saved customer email on Stripe's own Back/cancel path too.
# The payment page reads state.customerEmail when validating the next attempt.
if "if(order.customerEmail)state.customerEmail=order.customerEmail;" not in s.split('async function handleStripeReturn(){')[1].split('async function startAirwallexCheckout(){')[0]:
    target="currentOrder=order;cartDesigns=order.items||[];currentCartIndex=0;applyTagDesign("
    replacement="currentOrder=order;cartDesigns=order.items||[];currentCartIndex=0;if(order.customerEmail)state.customerEmail=order.customerEmail;applyTagDesign("
    if s.count(target)!=1:
        raise SystemExit("Stripe return email restoration anchor changed")
    s=s.replace(target,replacement)
p.write_text(s,encoding="utf-8")
print("Payment choices patch applied")
