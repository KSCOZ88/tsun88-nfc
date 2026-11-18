const test=require('node:test');
const assert=require('node:assert/strict');
const {confirmationEventId,queueConfirmedReceipt}=require('../server/airwallex-confirmation-notifier');

test('confirmed payment and repeat confirmations derive one stable notification ID',()=>{
 const id=confirmationEventId('plink_confirmed_abc123');
 assert.match(id,/^confirmed_[a-f0-9]{64}$/);
 assert.equal(id,confirmationEventId('plink_confirmed_abc123'));
 assert.notEqual(id,confirmationEventId('plink_confirmed_different'));
});
test('no persisted legacy order means no email is scheduled',async()=>{
 const result=await queueConfirmedReceipt('plink_confirmed_abc123',false,{
   enqueue(){throw Error('legacy must not enqueue');},
   processEvent(){throw Error('legacy must not process');},
   waitUntil(){throw Error('legacy must not schedule');}
 });
 assert.equal(result.status,'legacy-unrecoverable');
});
test('confirmed order is queued durably before deferred worker is scheduled',async()=>{
 const actions=[];
 let background;
 const result=await queueConfirmedReceipt('plink_confirmed_abc123',true,{
   async enqueue(id,link){actions.push('enqueue:'+link);assert.match(id,/^confirmed_/);},
   async processEvent(id){actions.push('process:'+id);return {status:'processed'};},
   waitUntil(promise){actions.push('waitUntil');background=promise;}
 });
 assert.equal(result.status,'queued');
 assert.deepEqual(actions.slice(0,2),['enqueue:plink_confirmed_abc123','waitUntil']);
 await background;
 assert.match(actions[2],/^process:confirmed_/);
});
test('queue errors surface so caller can log and rely on scheduled retry',async()=>{
 let invoked=false;
 await assert.rejects(()=>queueConfirmedReceipt('plink_confirmed_abc123',true,{
   async enqueue(){throw Object.assign(Error('database unavailable'),{status:503});},
   async processEvent(){invoked=true;},
   waitUntil(){invoked=true;}
 }),/database unavailable/);
 assert.equal(invoked,false);
});
