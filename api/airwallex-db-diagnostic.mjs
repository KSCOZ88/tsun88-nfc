import {randomBytes,timingSafeEqual} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const respond=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});

function authenticated(request){
 const expected=process.env.TSUN_DIAGNOSTIC_TOKEN||'';
 const authorization=request.headers.get('authorization')||'';
 const supplied=authorization.startsWith('Bearer ')?authorization.slice(7):'';
 const a=Buffer.from(expected),b=Buffer.from(supplied);
 return !!expected&&a.length===b.length&&timingSafeEqual(a,b);
}
export async function GET(){return respond({error:'not found'},404);}
export async function POST(request){
 if(!authenticated(request))return respond({error:'not found'},404);
 if(process.env.VERCEL_ENV!=='production')return respond({error:'production required'},503);
 const {db}=require('../server/airwallex-order-store');
 const {enqueue,processEvent}=require('../server/airwallex-webhook-queue');
 const sql=db();
 const suffix=randomBytes(12).toString('hex');
 const eventId='probe_'+suffix;
 const linkId='probe_unpayable_'+suffix;
 const orderId='PROBE-NOT-ORDER-'+suffix;
 let eventCreated=false,mailCreated=false;
 try{
  // This never calls Airwallex, never creates an order/payment link and never
  // invokes Gmail. The fake link cannot match a real payment link.
  await enqueue(eventId,linkId);
  eventCreated=true;
  await enqueue(eventId,linkId);
  const [queued]=await sql`SELECT COUNT(*)::int AS count
   FROM tsun_airwallex_webhook_events WHERE event_id=${eventId} AND payment_link_id=${linkId}`;
  const processed=await processEvent(eventId);
  const [event]=await sql`SELECT attempts,processed_at IS NOT NULL AS acknowledged,
    last_error FROM tsun_airwallex_webhook_events WHERE event_id=${eventId}`;

  await sql`INSERT INTO tsun_airwallex_mail
   (merchant_order_id,payment_link_id,stage)
   VALUES (${orderId},${linkId},'diagnostic_no_mail')`;
  mailCreated=true;
  const [mailBefore]=await sql`SELECT customer_sent,merchant_sent FROM tsun_airwallex_mail
    WHERE merchant_order_id=${orderId} AND stage='diagnostic_no_mail'`;
  const [mailAfter]=await sql`UPDATE tsun_airwallex_mail SET customer_sent=true
    WHERE merchant_order_id=${orderId} AND stage='diagnostic_no_mail'
    RETURNING customer_sent,merchant_sent`;

  const [orders]=await sql`SELECT COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE status='pending')::int AS pending,
    COUNT(*) FILTER (WHERE status='paid')::int AS paid FROM tsun_airwallex_orders`;
  const [unfinished]=await sql`SELECT COUNT(*)::int AS count FROM tsun_airwallex_webhook_events
    WHERE processed_at IS NULL AND event_id<>${eventId}`;
  const [mailPending]=await sql`SELECT COUNT(*)::int AS count FROM tsun_airwallex_mail
    WHERE stage='payment_received' AND (customer_sent=false OR merchant_sent=false)`;
  const healthy=queued?.count===1&&processed?.status==='unmatched'&&event?.attempts===1&&
    event?.acknowledged===true&&event?.last_error==='unmatched historical order'&&
    mailBefore?.customer_sent===false&&mailBefore?.merchant_sent===false&&
    mailAfter?.customer_sent===true&&mailAfter?.merchant_sent===false;
  console.info('[8TSUN8 DB probe]',{healthy,orderCount:orders?.total,unfinishedEvents:unfinished?.count});
  return respond({database:healthy?'read_write_ok':'verification_failed',
    eventQueue:healthy?'idempotent_insert_claim_processed':'verification_failed',
    mailLedger:healthy?'insert_read_update':'verification_failed',
    orderStats:{total:orders?.total||0,pending:orders?.pending||0,paid:orders?.paid||0},
    pendingWebhookEvents:unfinished?.count||0,unfinishedPaymentEmails:mailPending?.count||0
  },healthy?200:500);
 }catch(error){
  console.error('[8TSUN8 DB probe] error',{code:Number(error?.status)||500});
  return respond({database:'error',code:Number(error?.status)||500},503);
 }finally{
  if(mailCreated)await sql`DELETE FROM tsun_airwallex_mail
    WHERE merchant_order_id=${orderId} AND stage='diagnostic_no_mail'`.catch(()=>{});
  if(eventCreated)await sql`DELETE FROM tsun_airwallex_webhook_events
    WHERE event_id=${eventId} AND payment_link_id=${linkId}`.catch(()=>{});
 }
}
