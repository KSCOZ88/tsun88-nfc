'use strict';
const fs=require('node:fs');
const file='index.html';
let html=fs.readFileSync(file,'utf8');
function replaceOnce(from,to,label){
 const a=html.indexOf(from),b=html.lastIndexOf(from);
 if(a<0||a!==b)throw new Error('Payment Links UI: missing or ambiguous '+label);
 html=html.slice(0,a)+to+html.slice(a+from.length);
}
const panel=["  <div class=\"payment-panel\" id=\"airwallexPaymentPanel\" role=\"group\" aria-label=\"Airwallex secure payment\" style=\"margin-top:14px\">",
"    <div class=\"payment-code-box\" style=\"gap:12px\">",
"      <b style=\"font-size:21px\">Airwallex Secure Payment / Airwallex 安全付款</b>",
"      <small class=\"payment-scan-note\">Payment opens in another tab. After paying, return here to confirm and enter delivery details. / 付款後請返回本頁核對，再填寫配送資料。</small>",
"      <button type=\"button\" class=\"primary demo-pay-btn\" id=\"airwallexPayBtn\" style=\"background:#163449;color:white\">Pay with Airwallex / 使用 Airwallex 付款</button>",
"      <a id=\"airwallexOpenLink\" href=\"#\" target=\"_blank\" rel=\"noopener noreferrer\" hidden style=\"text-align:center;font-size:14px\">Open Airwallex payment link / 開啟付款連結</a>",
"      <button type=\"button\" class=\"secondary\" id=\"airwallexRecoverBtn\" hidden>Already paid? Check payment / 已付款？檢查結果</button>",
"      <small id=\"airwallexPaymentStatus\" aria-live=\"polite\"></small>",
"    </div>",
"  </div>"].join('\n')+'\n';
const anchor='  <div class="action-row"><button type="button" class="secondary" data-go="petProfile">返回宠物档案</button>';
replaceOnce(anchor,panel+anchor,'checkout panel');
const start='async function startAirwallexCheckout(){';
const end='\nfunction preparePaidOrderScreen(order){';
const a=html.indexOf(start),b=html.indexOf(end,a);
if(a<0||b<0||html.indexOf(start,a+start.length)>=0)throw new Error('Payment Links UI: expected one checkout handler');
const handler=["async function startAirwallexCheckout(){",
"  if(!ensureCheckoutProfiles())return;",
"  if(currentOrder&&!validateOrderPhoneConfirmations(currentOrder.items||[captureTagDesign()]))return;",
"  if(LOCAL_FILE_REVIEW){openLocalPostPaymentPreview();return;}",
"  if(PROFILE_PREVIEW_MODE){openOriginalProfilePreview();return;}",
"  if(!currentOrder||!validateCustomerEmail())return;",
"  if(currentOrder.airwallexSessionId){",
"    const link=currentOrder.airwallexPaymentUrl||\"\";",
"    if(/^https:\\/\\/([a-z0-9-]+\\.)*airwallex\\.com\\//i.test(link))window.open(link,\"_blank\",\"noopener,noreferrer\");",
"    else toast(\"此订单已有待核实的付款。请先点击检查结果，不要重复付款。\",9000);",
"    return;",
"  }",
"  const payTab=window.open(\"about:blank\",\"_blank\");",
"  if(payTab){try{payTab.opener=null;payTab.document.title=\"Airwallex\";payTab.document.body.textContent=\"Preparing secure payment…\";}catch{}}",
"  const button=document.getElementById(\"airwallexPayBtn\");",
"  if(button){button.disabled=true;button.textContent=\"Opening Airwallex…\";}",
"  try{",
"    currentOrder.customerEmail=state.customerEmail;",
"    currentOrder.payMethod=\"Airwallex\";currentOrder.status=\"等待付款\";",
"    currentOrder.pricing=calculateOrderPricing(currentOrder.items||[]);updateStoredOrder(currentOrder);",
"    const response=await fetch(AIRWALLEX_CREATE_ENDPOINT,{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({order:currentOrder})});",
"    const result=await response.json().catch(()=>({}));",
"    if(!response.ok||result.kind!==\"payment_link\"||!result.url||!result.id)throw new Error(result.error||\"Airwallex Payment Links are not available yet.\");",
"    const link=new URL(result.url);",
"    if(link.protocol!==\"https:\"||!(link.hostname===\"airwallex.com\"||link.hostname.endsWith(\".airwallex.com\")))throw new Error(\"Invalid Airwallex payment link\");",
"    if(result.totalCents!==Math.round(currentOrder.pricing.total*100))throw new Error(\"Payment amount mismatch\");",
"    currentOrder.airwallexSessionId=result.id;",
"    currentOrder.airwallexPaymentUrl=result.url;",
"    currentOrder.airwallexCheckoutPending=true;",
"    currentOrder.airwallexCheckoutStartedAt=new Date().toISOString();",
"    updateStoredOrder(currentOrder);",
"    if(payTab&&!payTab.closed)payTab.location.replace(result.url);",
"    renderPaymentOrder(currentOrder);",
"    const status=document.getElementById(\"airwallexPaymentStatus\");",
"    if(status)status.textContent=\"Pay in the other tab, then return here and click Check Payment Status. / 付款後返回此頁，點擊檢查結果。\";",
"  }catch(error){",
"    if(payTab&&!payTab.closed)payTab.close();",
"    toast(error.message||\"Airwallex 暂时不可用，请稍后再试。\",9000);",
"    if(button){button.disabled=false;renderPaymentOrder(currentOrder);}",
"  }",
"}"].join('\n');
html=html.slice(0,a)+handler+html.slice(b);
const recoverLine="  const recoverButton=document.getElementById('airwallexRecoverBtn');if(recoverButton)recoverButton.hidden=!order.airwallexSessionId||order.paymentStatus==='paid';";
const recoverPlus=recoverLine+"\n  const openLink=document.getElementById('airwallexOpenLink');if(openLink){const link=order.airwallexPaymentUrl||'';const safe=/^https:\\/\\/([a-z0-9-]+\\.)*airwallex\\.com\\//i.test(link);openLink.hidden=!safe||order.paymentStatus==='paid';if(safe)openLink.href=link;}";
replaceOnce(recoverLine,recoverPlus,'recovery link');
if(html.length<15000000||!html.includes('id="airwallexPayBtn"')||!html.includes('id="paypalPayBtn"'))throw new Error('Payment Links UI validation failed');
fs.writeFileSync(file,html,'utf8');
console.log('Payment Links UI injected into index.html; PayPal preserved.');
