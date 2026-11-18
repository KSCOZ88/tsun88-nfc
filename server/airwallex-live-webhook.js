'use strict';
// The event envelope is documented by Airwallex. Payment status is never
// trusted from the webhook alone: the queued worker re-fetches the link and
// matches it to the immutable server-side order snapshot before sending mail.
const ID=/^[A-Za-z0-9_-]{6,130}$/;
function parseEventEnvelope(event){
 if(!event||typeof event!=='object'||Array.isArray(event))return {kind:'invalid-body'};
 if(event.name!=='payment_link.paid')return {kind:'ignored'};
 const eventId=typeof event.id==='string'?event.id:'';
 const linkId=typeof event.data?.object?.id==='string'?event.data.object.id:'';
 if(!ID.test(eventId)||!ID.test(linkId))return {kind:'invalid-identifiers'};
 return {kind:'paid',eventId,linkId};
}
async function enqueueLiveEvent(parsed,{enqueue,processEvent,schedule,logger=console}){
 if(parsed.kind!=='paid')throw Error('Not a validated paid event');
 await enqueue(parsed.eventId,parsed.linkId);
 // The response must not wait for Airwallex lookups or Gmail SMTP.
 // Any payment failure remains retryable through the durable queue.
 schedule(Promise.resolve().then(()=>processEvent(parsed.eventId)).catch(error=>{
  logger.error('[Airwallex webhook] deferred processing failed',{status:Number(error?.status)||500});
 }));
 return {received:true};
}
module.exports={parseEventEnvelope,enqueueLiveEvent};
