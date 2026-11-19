'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const stripe=require('../server/stripe-orders');
test('Stripe HKD total matches current 8TSUN8 published pricing',()=>{
 const order={items:[{decorItems:{front:[{},{}],back:[{}]}},{decorItems:{front:[{}],back:[]}}]};
 assert.deepEqual(stripe.pricing(order),{itemCount:2,decorCount:4,totalCents:61000});
});
test('Stripe Checkout locale follows the selected storefront language',()=>{\n assert.equal(stripe.checkoutLocale('zh-Hant'),'zh-HK');\n assert.equal(stripe.checkoutLocale('zh-HK'),'zh-HK');\n assert.equal(stripe.checkoutLocale('en'),'en');\n assert.equal(stripe.checkoutLocale(undefined),'en');\n});\n\ntest('Stripe pricing rejects empty and excessive orders',()=>{
 assert.throws(()=>stripe.pricing({items:[]}),/订单数量无效/);
 assert.throws(()=>stripe.pricing({items:Array.from({length:21},()=>({}))}),/订单数量无效/);
});
