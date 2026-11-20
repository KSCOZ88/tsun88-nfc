#!/usr/bin/env python3
"""Prevent the legacy Home-first startup script overriding Stripe return recovery.

This runs after the checkout patches so the final generated HTML sees every return handler.
"""
from pathlib import Path
p=Path("index.html")
s=p.read_text(encoding="utf-8")
old="""return ['success','cancelled'].includes(params.get('airwallex_return'))||params.get('recover')==='1'||['success','cancelled'].includes(params.get('paypal_return'));"""
new="""return ['success','cancelled'].includes(params.get('airwallex_return'))||params.get('recover')==='1'||['success','cancelled'].includes(params.get('paypal_return'))||['success','cancelled'].includes(params.get('stripe_return'))||params.has('checkout_resume');"""
if old in s:
    if s.count(old)!=1: raise SystemExit("Ambiguous return gate")
    s=s.replace(old,new)
elif new not in s:
    raise SystemExit("Return gate anchor missing")
old2="""if(!PROFILE_PREVIEW_MODE&&!RESUME_AIRWALLEX_ON_STARTUP)go('home');
window.addEventListener('pageshow',event=>{
  if(event.persisted&&!PROFILE_PREVIEW_MODE&&!shouldResumeAirwallexOrder())go('home');
});"""
new2="""// Do not discard the order restored by Stripe / PayPal / Airwallex return handlers.
const paymentCheckoutVisible=()=>!!document.getElementById('checkout')?.classList.contains('active');
if(!PROFILE_PREVIEW_MODE&&!RESUME_AIRWALLEX_ON_STARTUP&&!paymentCheckoutVisible())go('home');
window.addEventListener('pageshow',event=>{
  if(event.persisted&&!PROFILE_PREVIEW_MODE&&!shouldResumeAirwallexOrder()&&!paymentCheckoutVisible())go('home');
});"""
if old2 in s:
    if s.count(old2)!=1: raise SystemExit("Ambiguous Home-first script")
    s=s.replace(old2,new2)
elif new2 not in s:
    raise SystemExit("Home-first script anchor missing")
p.write_text(s,encoding="utf-8")
print("Stripe return startup conflict patched")
