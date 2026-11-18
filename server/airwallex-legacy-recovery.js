'use strict';
const {listPaidLinks}=require('./airwallex-payment-links');
const {sendVerifiedHistoricalReceipt}=require('./airwallex-webhook-queue');
const fail=(message)=>Object.assign(new Error(message),{status:409});
async function recoverHistoricalOrder(){
 const ref=String(process.env.AIRWALLEX_RECOVERY_ORDER||'');
 const address=String(process.env.AIRWALLEX_RECOVERY_EMAIL||'').trim();
 const url=String(process.env.AIRWALLEX_RECOVERY_LINK_URL||'').trim().replace(/\/$/,'');
 const intent=String(process.env.AIRWALLEX_RECOVERY_INTENT||'').trim();
 const amountCents=Number(process.env.AIRWALLEX_RECOVERY_CENTS);
 if(!/^TS[0-9-]{10,40}$/.test(ref)||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)||!/^https:\/\/pay\.airwallex\.com\/[a-zA-Z0-9]+$/.test(url)||!/^int_[a-zA-Z0-9_-]{12,120}$/.test(intent)||!Number.isSafeInteger(amountCents)||amountCents<=0)throw fail('Historical recovery not configured');
 const paid=await listPaidLinks('2026-11-16T00:00:00Z','2026-11-19T00:00:00Z',6);
 const sameReference=paid.filter(p=>p.reference===ref);
 // All identifiers must match independently, including the customer's actual link
 // and PaymentIntent ID. An ambiguous or incomplete result must never send mail.
 const matches=sameReference.filter(p=>p.status==='PAID'&&String(p.currency).toUpperCase()==='HKD'&&Math.round(Number(p.amount)*100)===amountCents&&p.reusable===false&&String(p.url||'').replace(/\/$/,'')===url&&p.latest_successful_payment_intent_id===intent&&Number(p.successful_payment_intent_count)>=1&&/^[A-Za-z0-9_-]{6,130}$/.test(p.id));
 if(matches.length!==1||sameReference.length!==1)return {status:'not-uniquely-matched',references:sameReference.length};
 const link=matches[0];
 const delivery=await sendVerifiedHistoricalReceipt({merchant_order_id:ref,payment_link_id:link.id,amount_cents:amountCents,email:address});
 return {status:delivery.customerSent&&delivery.merchantSent?'receipts-sent':'partial-delivery',...delivery};
}
module.exports={recoverHistoricalOrder};
