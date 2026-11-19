'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createHmac}=require('node:crypto');
const {verifyWebhookSignature,summary,verifyPaidSession}=require('../server/stripe-orders');

test('Stripe webhook signature accepts a valid recent Live signature',()=>{
  const secret='whsec_example_for_unit_test_only';
  const raw=JSON.stringify({id:'evt_example',livemode:true});
  const timestamp=String(Math.floor(Date.now()/1000));
  const signature=createHmac('sha256',secret).update(timestamp+'.'+raw).digest('hex');
  assert.equal(verifyWebhookSignature(raw,'t='+timestamp+',v1='+signature,secret),true);
});

test('Stripe webhook signature rejects wrong secret and stale timestamp',()=>{
  const secret='whsec_example_for_unit_test_only';
  const raw='{"id":"evt_example"}';
  const timestamp=String(Math.floor(Date.now()/1000)-600);
  const signature=createHmac('sha256',secret).update(timestamp+'.'+raw).digest('hex');
  assert.equal(verifyWebhookSignature(raw,'t='+timestamp+',v1='+signature,secret),false);
  const fresh=String(Math.floor(Date.now()/1000));
  const wrong=createHmac('sha256','whsec_wrong').update(fresh+'.'+raw).digest('hex');
  assert.equal(verifyWebhookSignature(raw,'t='+fresh+',v1='+wrong,secret),false);
});

test('Stripe order summary uses the published HKD tag and charm prices',()=>{
  const order={
    id:'TS20261119-123456',
    customerEmail:'buyer@example.com',
    items:[{decorItems:{front:[{}],back:[{}]}}]
  };
  const result=summary(order);
  assert.equal(result.totalCents,30500);
  assert.equal(result.itemCount,1);
  assert.equal(result.decorCount,2);
});

test('Stripe paid-session verification requires Live mode, paid status and exact amount',()=>{
  const order={id:'TS20261119-123456',customerEmail:'buyer@example.com',items:[{decorItems:{front:[{}],back:[]}}]};
  const s=summary(order);
  const row={
    merchant_order_id:s.orderId,email:s.email,amount_cents:s.totalCents,
    order_digest:s.binding,item_count:s.itemCount,decor_count:s.decorCount,
    stripe_session_id:'cs_live_example'
  };
  const metadata={
    order_id:s.orderId,order_binding:s.binding,item_count:String(s.itemCount),
    decor_count:String(s.decorCount),total_cents:String(s.totalCents)
  };
  const session={
    id:'cs_live_example',livemode:true,mode:'payment',status:'complete',payment_status:'paid',
    currency:'hkd',amount_total:s.totalCents,client_reference_id:s.orderId,
    customer_details:{email:s.email},metadata,payment_intent:'pi_live_example'
  };
  assert.equal(verifyPaidSession(session,row).paymentIntentId,'pi_live_example');
  assert.throws(()=>verifyPaidSession({...session,livemode:false},row),/正式 Live/);
  assert.throws(()=>verifyPaidSession({...session,amount_total:s.totalCents+100},row),/金额/);
  assert.throws(()=>verifyPaidSession({...session,payment_status:'unpaid'},row),/尚未确认/);
});
