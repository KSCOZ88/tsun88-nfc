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
original="body:JSON.stringify({order:currentOrder,previews})"
replacement="body:JSON.stringify({order:currentOrder,previews,locale:String(window.TsunI18n?.locale||document.documentElement.lang||'en').toLowerCase().startsWith('zh')?'zh-HK':'en',paymentMethod:window.__tsunStripeMethod||'card'})"
if replacement not in block:
    if block.count(original)!=1:
        raise SystemExit("Payment choices: expected one Stripe request body")
    block=block.replace(original,replacement)
# Keep payment method in local order to prevent reusing a different method's session.
anchor="currentOrder.customerEmail=state.customerEmail;currentOrder.payMethod='Stripe';"
updated="currentOrder.customerEmail=state.customerEmail;currentOrder.stripeSelectedMethod=window.__tsunStripeMethod||'card';currentOrder.payMethod='Stripe';"
if updated not in block:
    if block.count(anchor)!=1:
        raise SystemExit("Payment choices: Stripe order assignment changed")
    block=block.replace(anchor,updated)
s=s[:start]+block+s[end:]
script='<script src="/assets/tsun-payment-method-choice.js" defer></script>'
if script not in s:
    if s.count('</body>')!=1:
        raise SystemExit("Payment choices: expected one closing body")
    s=s.replace('</body>',script+'\n</body>')
p.write_text(s,encoding="utf-8")
print("Payment choices patch applied")
