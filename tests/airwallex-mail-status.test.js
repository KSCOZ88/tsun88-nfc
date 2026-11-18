const test=require('node:test');
const assert=require('node:assert/strict');
const {deliveryOutcome}=require('../server/airwallex-mail-status');

test('customer payment receipt never falsely records merchant email as delivered',()=>{
 const result=deliveryOutcome('payment_received',{customer_sent:false,merchant_sent:false},{customerSent:true,merchantSent:false});
 assert.deepEqual(result,{customerSent:true,merchantSent:false,complete:true});
});
test('merchant order production notice requires real delivery',()=>{
 const result=deliveryOutcome('order_completed',{customer_sent:false,merchant_sent:false},{customerSent:true,merchantSent:false});
 assert.deepEqual(result,{customerSent:true,merchantSent:false,complete:false});
});
test('previous delivery states survive idempotent retries',()=>{
 const result=deliveryOutcome('order_completed',{customer_sent:true,merchant_sent:false},{customerSent:false,merchantSent:true});
 assert.deepEqual(result,{customerSent:true,merchantSent:true,complete:true});
});
test('simultaneous delivery only counts confirmed recipients',()=>{
 assert.deepEqual(deliveryOutcome('payment_received',{},{}),{customerSent:false,merchantSent:false,complete:false});
});
