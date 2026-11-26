#!/usr/bin/env python3
"""Carry the storefront language through checkout into each NFC profile."""
from pathlib import Path

index = Path("index.html")
source = index.read_text(encoding="utf-8")


def replace(old, new):
    global source
    if new in source:
        return
    if source.count(old) != 1:
        raise SystemExit(f"Profile language anchor missing or ambiguous: {old}")
    source = source.replace(old, new, 1)


replace(
    "function petProfilePayload(order){",
    """function profileLanguage(order){
  return order.language==='en'||order.language==='zh-Hant'?order.language:TsunI18n.locale;
}
function rememberCheckoutLanguage(order){
  const hasSession=order.stripeSessionId||order.paypalOrderId||order.airwallexSessionId;
  order.language=profileLanguage(hasSession?order:{});
}
function petProfilePayload(order){
  const language=profileLanguage(order);
  const breed=breedByKey(order.selectedBreedKey||order.breedKey);
  const catalogueBreed=breed&&(!order.nfcProfile?.breed||
    ['en','zh-Hant'].some(locale=>TsunI18n.t(breed.name,locale)===order.nfcProfile.breed));""",
)
replace(
    "return {base_variant:TsunProfileTheme.forOrder(order)||'',order_id:order.id,",
    "return {profile_language:language,base_variant:TsunProfileTheme.forOrder(order)||'',order_id:order.id,",
)
replace(
    "breed:p.breed||order.breedName||'',birth_date:",
    "breed:catalogueBreed?TsunI18n.t(breed.name,language):p.breed||order.breedName||'',birth_date:",
)
for provider in ("PayPal", "Stripe", "Airwallex"):
    anchor = f"currentOrder.customerEmail=state.customerEmail;currentOrder.payMethod='{provider}';"
    replace(anchor, "rememberCheckoutLanguage(currentOrder);" + anchor)
replace(
    "locale:window.TsunI18n?.locale==='zh-Hant'?'zh-HK':'en-HK'",
    "locale:currentOrder.language==='zh-Hant'?'zh-HK':'en-HK'",
)
replace(
    "locale:String(window.TsunI18n?.locale||document.documentElement.lang||'en').toLowerCase().startsWith('zh')?'zh-HK':'en',paymentMethod:",
    "locale:currentOrder.language==='zh-Hant'?'zh-HK':'en',paymentMethod:",
)
# The saved profile link opens the same page that an NFC scan opens.
link_handler = "  const profileLink=document.getElementById('nfcPublicLink');if(profileLink&&!profileLink.dataset.bound){profileLink.dataset.bound='1';profileLink.addEventListener('click',event=>{if(currentOrder?.cloudProfile){event.preventDefault();openChineseProfile();}});}\n"
if link_handler in source:
    source = source.replace(link_handler, "", 1)
index.write_text(source, encoding="utf-8")
