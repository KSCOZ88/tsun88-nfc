'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const stripe=require('../server/stripe-orders');
test('Stripe HKD total matches current 8TSUN8 published pricing',()=>{
 const order={items:[{decorItems:{front:[{},{}],back:[{}]}},{decorItems:{front:[{}],back:[]}}]};
 assert.deepEqual(stripe.pricing(order),{itemCount:2,decorCount:4,totalCents:61000});
});
test('Stripe Checkout locale follows the selected storefront language',()=>{
 assert.equal(stripe.checkoutLocale('zh-Hant'),'zh-HK');
 assert.equal(stripe.checkoutLocale('zh-HK'),'zh-HK');
 assert.equal(stripe.checkoutLocale('en'),'en');
 assert.equal(stripe.checkoutLocale(undefined),'en');
});

test('Stripe pricing rejects empty and excessive orders',()=>{
 assert.throws(()=>stripe.pricing({items:[]}),/订单数量无效/);
 assert.throws(()=>stripe.pricing({items:Array.from({length:21},()=>({}))}),/订单数量无效/);
});

test('order emails follow the saved checkout language',()=>{
 const {render,renderMerchant}=require('../server/email-template');
 const base={id:'TEST-ORDER',items:[{petName:'Lucky',decorItems:{front:[],back:[]},baseLabel:'Classic'}],customerEmail:'customer@example.com',payMethod:'Stripe',paidAmountCents:29900,shipName:'Alex',shipPhone:'12345678',shipAddress:'Hong Kong'};
 const zh=render({...base,language:'zh-Hant'},'payment_received',[]);
 assert.match(zh.html,/付款成功/);
 assert.match(zh.html,/實付金額/);
 assert.match(renderMerchant({...base,language:'zh-Hant'}).html,/客戶電郵/);
 const en=render({...base,language:'en'},'payment_received',[]);
 assert.match(en.html,/Payment received/);
 assert.match(en.html,/Total paid/);
 assert.match(renderMerchant({...base,language:'en'}).html,/Customer email/);
});

test('Stripe-specific checkout methods are allowlisted, not arbitrary payment identifiers',()=>{
 assert.equal(stripe.checkoutPaymentMethod('card'),'card');
 assert.equal(stripe.checkoutPaymentMethod('alipay'),'alipay');
 assert.equal(stripe.checkoutPaymentMethod('wechat_pay'),'wechat_pay');
 for(const invalid of ['',null,'paypal','apple_pay','google_pay','alipayhk','wechatpayhk','card;anything'])assert.throws(()=>stripe.checkoutPaymentMethod(invalid),/不支持所选/);
});
