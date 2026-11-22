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
anchor = "if(PROFILE_PREVIEW_MODE)enableProfilePreviewMode();"
source = replace(source, anchor, anchor + """
const MERCHANT_ORDER_PREVIEW=location.pathname.replace(/\/$/,'')==='/merchant';
if(MERCHANT_ORDER_PREVIEW){
  document.documentElement.dataset.merchantPreview='locked';
  PROFILE_PREVIEW_MODE=true;
}""")
anchor = """  button.textContent=ready?TsunI18n.t(nfcEditingPaidOrder?'保存并返回配送资料':'下一步：付款'):(en?'Preview first':'先查看預覽');"""
source = replace(source, anchor, anchor + """
  if(ready&&MERCHANT_ORDER_PREVIEW)button.textContent=en?'Continue to delivery':'下一步：配送資料';""")
source = replace(source, "</body>", '<script src="/assets/tsun-merchant-preview.js" defer></script>\n</body>')
source = replace(source, "</head>", '<link rel="stylesheet" href="/assets/tsun-merchant-preview.css">\n</head>')
index.write_text(source, encoding="utf-8")

profile = Path("lucky88.html")
source = profile.read_text(encoding="utf-8")
anchor = """  const response=await fetch(SUPABASE_URL+'/rest/v1/rpc/get_pet_profile',{method:'POST',headers:{apikey:SUPABASE_PUBLISHABLE_KEY,'Content-Type':'application/json'},body:JSON.stringify({p_slug:slug})});"""
source = replace(source, anchor, """  const merchantPreview=location.pathname==='/merchant-profile';
  const response=merchantPreview
    ? await fetch('/api/order-email?merchantPreview=1&profile='+encodeURIComponent(slug))
    : await fetch(SUPABASE_URL+'/rest/v1/rpc/get_pet_profile',{method:'POST',headers:{apikey:SUPABASE_PUBLISHABLE_KEY,'Content-Type':'application/json'},body:JSON.stringify({p_slug:slug})});""")
profile.write_text(source, encoding="utf-8")
