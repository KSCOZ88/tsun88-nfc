'use strict';
const {createHash}=require('node:crypto');

// Confirmations can arrive before the Airwallex webhook. Use the same durable
// queue and mail ledger so an on-site confirmation and a webhook never send
// duplicate receipts.
function confirmationEventId(linkId){
 if(typeof linkId!=='string'||!/^[A-Za-z0-9_-]{6,120}$/.test(linkId))throw new Error('Invalid confirmed payment link');
 return 'confirmed_'+createHash('sha256').update(linkId).digest('hex');
}
async function queueConfirmedReceipt(linkId,stored,{enqueue,processEvent,waitUntil,logger=console}){
 if(!stored)return {status:'legacy-unrecoverable'};
 const eventId=confirmationEventId(linkId);
 await enqueue(eventId,linkId);
 waitUntil(Promise.resolve().then(()=>processEvent(eventId)).catch(error=>{
   logger.error('[Airwallex confirm receipt] background processing failed',{status:Number(error?.status)||500});
 }));
 return {status:'queued'};
}
module.exports={confirmationEventId,queueConfirmedReceipt};
