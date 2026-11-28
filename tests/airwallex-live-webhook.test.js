const test=require('node:test');
const assert=require('node:assert/strict');
const {parseEventEnvelope,enqueueLiveEvent}=require('../server/airwallex-live-webhook');
const officialFixture={
 id:'evt_100_2019102201540902013102020043_8321220011893766',
 name:'payment_link.paid',
 account_id:'acct__ncI2nypPKSq2VXKxscAcg',
 version:'2025-02-14',
 data:{object:{
   id:'475dc845-bc7c-47eb-b2b0-52782b9d078d',
   amount:302,currency:'HKD',status:'PAID'
 }}
};
test('Airwallex payment_link.paid webhook shape extracts the correct IDs',()=>{
 assert.deepEqual(parseEventEnvelope(officialFixture),{
  kind:'paid',
  eventId:officialFixture.id,
  linkId:officialFixture.data.object.id
 });
});
test('malformed and irrelevant payloads do not enter the payment queue',()=>{
 assert.deepEqual(parseEventEnvelope(null),{kind:'invalid-body'});
 assert.deepEqual(parseEventEnvelope([]),{kind:'invalid-body'});
 assert.deepEqual(parseEventEnvelope({name:'payment_intent.created'}),{kind:'ignored'});
 assert.deepEqual(parseEventEnvelope({name:'payment_link.paid',data:{object:{id:'475dc845-bc7c-47eb-b2b0-52782b9d078d'}}}),{kind:'invalid-identifiers'});
});
test('successful store QR intents use the existing order payment queue',()=>{
 for(const method of ['fps','alipaycn','alipayhk','wechatpay','card','fps_probe']){
  const event={name:'payment_intent.succeeded',id:'evt_test',
   data:{object:{id:'int_test',metadata:{checkout_method:'8tsun8_'+method}}}};
  assert.deepEqual(parseEventEnvelope(event),['card','fps_probe'].includes(method)
   ?{kind:'ignored'}:{kind:'paid',eventId:'evt_test',linkId:'int_test'});
 }
});
test('a verified live event is durably queued, acknowledged, then processed',async()=>{
 const events=[];
 let background;
 const parsed=parseEventEnvelope(officialFixture);
 const response=await enqueueLiveEvent(parsed,{
  enqueue:async(id,link)=>{events.push('queued');assert.equal(id,officialFixture.id);assert.equal(link,officialFixture.data.object.id);},
  processEvent:async(id)=>{events.push('processed');assert.equal(id,officialFixture.id);},
  schedule:promise=>{events.push('scheduled');background=promise;}
 });
 assert.deepEqual(response,{received:true});
 assert.deepEqual(events.slice(0,2),['queued','scheduled']);
 await background;
 assert.deepEqual(events,['queued','scheduled','processed']);
});
test('a database failure prevents 200 acknowledgement and worker scheduling',async()=>{
 let scheduled=false;
 await assert.rejects(()=>enqueueLiveEvent(parseEventEnvelope(officialFixture),{
  enqueue:async()=>{throw new Error('database unavailable');},
  processEvent:async()=>{scheduled=true;},
  schedule:()=>{scheduled=true;}
 }),/database unavailable/);
 assert.equal(scheduled,false);
});
test('background errors can be logged without losing the already queued event',async()=>{
 let background,logged;
 const res=await enqueueLiveEvent(parseEventEnvelope(officialFixture),{
  enqueue:async()=>{},
  processEvent:async()=>{throw Object.assign(Error('SMTP failed'),{status:503});},
  schedule:promise=>{background=promise;},
  logger:{error:(message,details)=>{logged={message,details};}}
 });
 assert.deepEqual(res,{received:true});
 await background;
 assert.equal(logged.details.status,503);
});
