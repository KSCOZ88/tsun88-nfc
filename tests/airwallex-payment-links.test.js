'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {create,verify,retire} = require('../server/airwallex-payment-links');
const {summary} = require('../server/airwallex-checkout');
const {createHash} = require('node:crypto');
process.env.VERCEL_ENV = 'production';
process.env.AIRWALLEX_API_KEY = 'test-key-not-real';
process.env.AIRWALLEX_CLIENT_ID = 'test-client-not-real';
process.env.AIRWALLEX_ACCOUNT_ID = 'acct_mock_account';
const order = {
 id:'TS20261117-TEST',
 customerEmail:'example@example.com',
 items:[{decorItems:{front:[{id:'a'}],back:[]}}]
};
const amount=302;
const binding=createHash('sha256').update([order.id,order.customerEmail.toLowerCase(),1,1].join('|')).digest('hex');
const meta={order_id:order.id,order_binding:binding,item_count:'1',decor_count:'1',total_cents:'30200'};
const link={id:'plink_123456789',url:'https://pay.airwallex.com/example-123',reference:order.id,amount,currency:'HKD',reusable:false,status:'PAID',metadata:meta,successful_payment_intent_count:1,latest_successful_payment_intent_id:'int_mock123456'};
function mockFetch({status='PAID',amountOverride=302}={}){
 const calls=[];
 global.fetch=async (url,opts={})=>{
  calls.push({url,opts});
  if(url.endsWith('/api/v1/authentication/login'))return {ok:true,json:async()=>({token:'mock_access_token'})};
  if(url.endsWith('/api/v1/pa/payment_links/create'))return {ok:true,json:async()=>({id:link.id,url:link.url})};
  if(url.includes('/api/v1/pa/payment_links/'))return {ok:true,json:async()=>({...link,status,amount:amountOverride})};
  throw Error('Unexpected upstream URL: '+url);
 };
 return calls;
}
test('create fixed HKD amount from server-side tag and charm counts',async()=>{
 const calls=mockFetch();
 const out=await create(order);
 assert.equal(out.amountCents,30200);
 assert.equal(out.url,link.url);
 const request=JSON.parse(calls.find(c=>c.url.endsWith('/create')).opts.body);
 assert.equal(request.amount,302);
 assert.equal(request.currency,'HKD');
 assert.equal(request.reusable,false);
 assert.deepEqual(request.metadata,meta);
});
test('verify paid payment link bound to this order',async()=>{
 mockFetch();
 const out=await verify(link.id,order);
 assert.equal(out.paid,true);
 assert.equal(out.paymentIntentId,'int_mock123456');
});
test('do not mark unpaid links as paid',async()=>{
 mockFetch({status:'UNPAID'});
 await assert.rejects(()=>verify(link.id,order),/not confirmed/i);
});
test('reject mismatch in amount even when marked paid',async()=>{
 mockFetch({amountOverride:301});
 await assert.rejects(()=>verify(link.id,order),/mismatch/i);
});
test('verify that a one-time link is inactive before switching payment methods',async()=>{
 let deactivations=0;
 let active=true;
 global.fetch=async (url,opts)=>{
  if(url.endsWith('/api/v1/authentication/login'))return {ok:true,json:async()=>({token:'mock_access_token'})};
  if(url.endsWith('/deactivate')){
   assert.equal(opts.method,'POST');
   deactivations++;
   active=false;
  }
  return {ok:true,json:async()=>({...link,status:'UNPAID',active,successful_payment_intent_count:0,latest_successful_payment_intent_id:null})};
 };
 assert.equal(await retire(link.id,summary(order)),null);
 assert.equal(await retire(link.id,summary(order)),null);
 assert.equal(deactivations,1);
});
test('a payment completed while deactivating a link still goes to confirmation',async()=>{
 let paid=false;
 global.fetch=async url=>{
  if(url.endsWith('/api/v1/authentication/login'))return {ok:true,json:async()=>({token:'mock_access_token'})};
  if(url.endsWith('/deactivate'))paid=true;
  const result=paid?{...link,active:false}:{...link,status:'UNPAID',active:true,successful_payment_intent_count:0,latest_successful_payment_intent_id:null};
  return {ok:true,json:async()=>result};
 };
 assert.deepEqual(await retire(link.id,summary(order)),{paid:true,id:link.id});
});
