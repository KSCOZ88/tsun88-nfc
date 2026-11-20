#!/usr/bin/env python3
"""Keep Stripe return and browser Back on checkout; do not reset to Home.

The legacy Home-first startup code runs after the normal Stripe return handlers.
Only suppress that reset for an actual payment return, without affecting Airwallex
or PayPal's own resume decisions.
"""
from pathlib import Path
p=Path("index.html")
s=p.read_text(encoding="utf-8")
old="""const RESUME_AIRWALLEX_ON_STARTUP=shouldResumeAirwallexOrder();"""
new="""const RESUME_AIRWALLEX_ON_STARTUP=shouldResumeAirwallexOrder();
const RESUME_STRIPE_ON_STARTUP=(()=>{const params=new URLSearchParams(location.search);return ['success','cancelled'].includes(params.get('stripe_return'))||params.has('checkout_resume');})();"""
if old in s:
    if s.count(old)!=1: raise SystemExit("Ambiguous startup return flag")
    s=s.replace(old,new)
elif new not in s: raise SystemExit("Startup return flag missing")
old="""if(PROFILE_PREVIEW_MODE||shouldResumeAirwallexOrder()){"""
new="""if(PROFILE_PREVIEW_MODE||shouldResumeAirwallexOrder()||RESUME_STRIPE_ON_STARTUP){"""
if old in s:
    if s.count(old)!=1: raise SystemExit("Ambiguous intro gate flag")
    s=s.replace(old,new)
elif new not in s: raise SystemExit("Intro gate flag missing")
old="""if(!PROFILE_PREVIEW_MODE&&!RESUME_AIRWALLEX_ON_STARTUP)go('home');
window.addEventListener('pageshow',event=>{
  if(event.persisted&&!PROFILE_PREVIEW_MODE&&!shouldResumeAirwallexOrder())go('home');
});"""
new="""// Never overwrite a returned checkout after its original order has been restored.
const paymentCheckoutVisible=()=>!!document.getElementById('checkout')?.classList.contains('active');
if(!PROFILE_PREVIEW_MODE&&!RESUME_AIRWALLEX_ON_STARTUP&&!RESUME_STRIPE_ON_STARTUP&&!paymentCheckoutVisible())go('home');
window.addEventListener('pageshow',event=>{
  if(event.persisted&&!PROFILE_PREVIEW_MODE&&!shouldResumeAirwallexOrder()&&!RESUME_STRIPE_ON_STARTUP&&!paymentCheckoutVisible())go('home');
});"""
if old in s:
    if s.count(old)!=1: raise SystemExit("Ambiguous Home-first script")
    s=s.replace(old,new)
elif new not in s: raise SystemExit("Home-first script anchor missing")
p.write_text(s,encoding="utf-8")
print("Stripe return startup conflict patched")
