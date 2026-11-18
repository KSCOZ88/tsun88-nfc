import {createHmac,timingSafeEqual} from 'node:crypto';
import {createRequire} from 'node:module';
import {waitUntil} from '@vercel/functions';
const require=createRequire(import.meta.url);
const {enqueue,processEvent,dailyReconciliation}=require('../server/airwallex-webhook-queue');
const json=(obj,status=200)=>Response.json(obj,{status,headers:{'Cache-Control':'no-store'}});
function verifyHmac(secret,stamp,signature,raw){
 if(!secret||!/^[0-9]{13}$/.test(stamp)||!/^[a-f0-9]{64}$/i.test(signature))return false;
 if(Math.abs(Date.now()-Number(stamp))>5*60*1000)return false;
 const expected=createHmac('sha256',secret).update(stamp+raw).digest();
 const actual=Buffer.from(signature,'hex');
 return actual.length===expected.length&&timingSafeEqual(actual,expected);
}
function authenticate(request,raw){
 const stamp=request.headers.get('x-timestamp')||'';
 const signature=request.headers.get('x-signature')||'';
 // A live event must be signed with the configured webhook's secret.
 if(verifyHmac(process.env.AIRWALLEX_WEBHOOK_SECRET||'',stamp,signature,raw))return 'live';
 // Airwallex explicitly documents a separate signature key header for test events.
 // Such requests are acknowledged for connectivity testing only; never fulfill orders.
 const testKey=request.headers.get('client-secret-key')||'';
 if(testKey&&verifyHmac(testKey,stamp,signature,raw))return 'test';
 return null;
}
export async function GET(request){
 const header=request.headers.get('authorization')||'';
 const secret=process.env.CRON_SECRET||'';
 if(secret&&header==='Bearer '+secret){
  waitUntil(dailyReconciliation().catch(error=>console.error('[Airwallex cron] failed',String(error?.status||'unknown'))));
  return json({retry:'scheduled'});
 }
 return json({webhook:'reachable',accepts:'POST'});
}
export async function POST(request){
 if(new URL(request.url).searchParams.get('dbDiagnostic')==='1'){
   return require('../server/airwallex-db-diagnostic').runDiagnostic(request);
 }
 console.info('[Airwallex webhook] request received');
 if(!process.env.AIRWALLEX_WEBHOOK_SECRET){
   console.error('[Airwallex webhook] signing secret not configured');
   return json({error:'webhook not configured'},503);
 }
 const raw=await request.text();
 if(raw.length>250000){
   console.warn('[Airwallex webhook] payload too large');
   return json({error:'payload too large'},413);
 }
 const auth=authenticate(request,raw);
 if(!auth){
   console.warn('[Airwallex webhook] invalid signature', {
     hasTimestamp:!!request.headers.get('x-timestamp'),
     hasSignature:!!request.headers.get('x-signature'),
     isTestHeaderPresent:!!request.headers.get('client-secret-key')
   });
   return json({error:'invalid signature'},401);
 }
 if(auth==='test'){
   console.info('[Airwallex webhook] verified test event, no business action');
   return json({received:true,test:true});
 }
 let event;
 try{event=JSON.parse(raw);}catch{
   console.warn('[Airwallex webhook] invalid json');
   return json({error:'invalid JSON'},400);
 }
 if(event.name!=='payment_link.paid'){
   console.info('[Airwallex webhook] unrelated event');
   return json({received:true,ignored:true});
 }
 const linkId=String(event.data?.object?.id||'');
 const eventId=String(event.id||'');
 if(!/^[A-Za-z0-9_-]{6,130}$/.test(linkId)||!/^[A-Za-z0-9_-]{6,130}$/.test(eventId)){
  console.warn('[Airwallex webhook] missing event or link id');
  return json({error:'invalid event identifiers'},422);
 }
 try{
  // Persist the authenticated event before acknowledging. Payment verification
  // and SMTP run separately, without blocking Airwallex's 200 response.
  await enqueue(eventId,linkId);
  waitUntil(processEvent(eventId).catch(error=>console.error('[Airwallex webhook] deferred processing failed',String(error?.status||'unknown'))));
  return json({received:true});
 }catch(error){
  console.error('[Airwallex webhook] queue unavailable',String(error?.status||'unknown'));
  return json({error:'temporary webhook processing error'},503);
 }
}
