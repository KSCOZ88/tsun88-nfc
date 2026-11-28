#!/usr/bin/env python3
"""Attach the merchant preview to the existing storefront and NFC profile renderer."""
from pathlib import Path


def replace(page, old, new):
    if new in page:
        return page
    if page.count(old) != 1:
        raise SystemExit(f"Merchant preview anchor missing or ambiguous: {old}")
    return page.replace(old, new, 1)


index = Path("index.html")
source = index.read_text(encoding="utf-8")
anchor = "let PROFILE_PREVIEW_MODE=new URLSearchParams(location.search).get('preview')==='profile';"
source = replace(source, anchor, r"""
const MERCHANT_ORDER_MODE=/^\/merchant(?:\/orders)?\/?$/.test(location.pathname);
let PROFILE_PREVIEW_MODE=!MERCHANT_ORDER_MODE&&new URLSearchParams(location.search).get('preview')==='profile';
if(MERCHANT_ORDER_MODE){
  document.documentElement.dataset.merchantPreview='locked';
  if(location.pathname.replace(/\/$/,'')==='/merchant/orders')document.documentElement.dataset.merchantOrders='1';
}""".strip())
anchor = "if(PROFILE_PREVIEW_MODE||shouldResumeAirwallexOrder()||RESUME_STRIPE_ON_STARTUP){"
source = replace(source, anchor, "if(MERCHANT_ORDER_MODE||PROFILE_PREVIEW_MODE||shouldResumeAirwallexOrder()||RESUME_STRIPE_ON_STARTUP){")
for fn in ("startPaypalCheckout", "startStripeCheckout", "startAirwallexCheckout",
           "handlePaypalReturn", "handleStripeReturn", "handleAirwallexReturn", "submitPostPaymentNfc"):
    parameters = "preferredMethod,openFps" if fn == "startAirwallexCheckout" else ""
    anchor = f"async function {fn}({parameters}){{"
    source = replace(source, anchor, anchor + "\n  if(MERCHANT_ORDER_MODE)return;")
anchor = "function handleCheckoutResume(){"
source = replace(source, anchor, anchor + "\n  if(MERCHANT_ORDER_MODE)return;")
for before, after in (
    ("function loadOrders(){if(PROFILE_PREVIEW_MODE)return [];", "function loadOrders(){if(MERCHANT_ORDER_MODE||PROFILE_PREVIEW_MODE)return [];"),
    ("function saveOrders(list){if(PROFILE_PREVIEW_MODE)return;", "function saveOrders(list){if(MERCHANT_ORDER_MODE||PROFILE_PREVIEW_MODE)return;"),
    ("if(event.persisted&&!PROFILE_PREVIEW_MODE", "if(event.persisted&&!MERCHANT_ORDER_MODE&&!PROFILE_PREVIEW_MODE"),
    ("if(!PROFILE_PREVIEW_MODE&&!RESUME_AIRWALLEX_ON_STARTUP&&!RESUME_STRIPE_ON_STARTUP&&!paymentCheckoutVisible())go('home');",
     "if(!MERCHANT_ORDER_MODE&&!PROFILE_PREVIEW_MODE&&!RESUME_AIRWALLEX_ON_STARTUP&&!RESUME_STRIPE_ON_STARTUP&&!paymentCheckoutVisible())go('home');"),
):
    source = replace(source, before, after)
anchor = """  button.textContent=ready?TsunI18n.t(nfcEditingPaidOrder?'保存并返回配送资料':'下一步：付款'):(en?'Preview first':'先查看預覽');"""
source = replace(source, anchor, anchor + """
  if(ready&&MERCHANT_ORDER_MODE)button.textContent=en?'Continue to delivery':'下一步：配送資料';""")
source = replace(source, "</body>", '<script src="/assets/tsun-merchant-order-review.js" defer></script>\n<script src="/assets/tsun-merchant-preview.js" defer></script>\n</body>')
source = replace(source, "</head>", '<link rel="stylesheet" href="/assets/tsun-merchant-preview.css">\n</head>')
index.write_text(source, encoding="utf-8")
