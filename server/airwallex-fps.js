'use strict';

const {createHash}=require('node:crypto');
const {auth,configuration,summary}=require('./airwallex-checkout');
const {begin,complete,db,fpsSchema}=require('./airwallex-order-store');

const validity=10*60*1000;
const idPattern=/^[A-Za-z0-9_-]{6,120}$/;
const fail=(message,status=409)=>Object.assign(new Error(message),{status});
const requestId=(action,parts)=>'fps-'+action+'-'+createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0,42);

async function request(config,path,body){
 const token=await auth(config);
 const response=await fetch(config.base+'/api/v1/pa/payment_intents/'+path,{
  headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','x-api-version':'2025-02-14'},
  ...(body?{method:'POST',body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(13000)
 }).catch(()=>{throw fail('Airwallex FPS is temporarily unavailable.',503);});
 if(!response.ok){
  const error=await response.json().catch(()=>({}));
  const code=String(error.code||'');
  console.warn('[Airwallex FPS]',{status:response.status,code:/^[a-z0-9_]{1,64}$/i.test(code)?code:'unknown'});
  throw fail('Airwallex could not prepare or verify the FPS payment.',response.status===409?409:503);
 }
 return response.json();
}

function confirmBinding(intent,id,s){
 if(intent.id!==id||intent.currency!=='HKD'||Math.round(Number(intent.amount)*100)!==s.totalCents||
    intent.merchant_order_id!==s.orderId||intent.metadata?.order_binding!==s.binding||
    intent.metadata?.checkout_method!=='8tsun8_fps'){
  throw fail('FPS payment does not match this order.');
 }
}

function lookup(config,id){
 if(typeof id!=='string'||!idPattern.test(id))throw fail('Invalid FPS payment ID.',422);
 return request(config,encodeURIComponent(id));
}

async function verify(id,order){
 const config=configuration(),s=summary(order);
 const intent=await lookup(config,id);
 confirmBinding(intent,id,s);
 if(intent.status!=='SUCCEEDED')throw fail('FPS payment is not confirmed.');
 const attempt=intent.latest_payment_attempt;
 if(attempt?.payment_method?.type!=='fps'||
    Math.round(Number(attempt.captured_amount??intent.captured_amount)*100)!==s.totalCents){
  throw fail('FPS payment method or captured amount does not match this order.');
 }
 return {paid:true,paymentIntentId:id,amountCents:s.totalCents,currency:'HKD',mode:config.mode};
}

async function prepare(order){
 const config=configuration();
 if(summary(order).orderId.length>64)throw fail('Invalid FPS order number.',422);
 const lease=await begin(order,'fps');
 const {s,sql,existing,attempt}=lease;
 let id=existing?.payment_link_id;
 let intent;
 if(id){
  intent=await lookup(config,id);
 }else{
  intent=await request(config,'create',{
   request_id:requestId('create',attempt?[config.mode,s.orderId,s.binding,attempt]:[config.mode,s.orderId,s.binding]),
   amount:s.totalCents/100,currency:'HKD',merchant_order_id:s.orderId,
   metadata:{order_binding:s.binding,checkout_method:'8tsun8_fps'}
  });
  id=intent.id;
  if(typeof id!=='string'||!idPattern.test(id))throw fail('Airwallex returned an invalid FPS payment.',502);
  confirmBinding(intent,id,s);
  await complete(lease,{paymentLinkId:id,url:null});
 }
 confirmBinding(intent,id,s);
 if(intent.status==='SUCCEEDED')return {id,paid:true,totalCents:s.totalCents};
 const previous=existing?.fps_qr;
 const now=Date.now();
 if(previous?.expiresAt>now){
  return intent.status==='REQUIRES_CUSTOMER_ACTION'
   ? {id,totalCents:s.totalCents,...previous}
   : {id,totalCents:s.totalCents,pending:true};
 }
 if(!['REQUIRES_PAYMENT_METHOD','REQUIRES_CUSTOMER_ACTION'].includes(intent.status)){
  return {id,totalCents:s.totalCents,pending:true};
 }
 const key=requestId('confirm',[id,previous?.expiresAt||0]);
 const confirmation=await request(config,encodeURIComponent(id)+'/confirm',{
  request_id:key,payment_method:{type:'fps',fps:{flow:'webqr'}}
 });
 const action=confirmation.next_action;
 if(action?.type!=='render_qrcode'||typeof action.qrcode!=='string'||!action.qrcode||action.qrcode.length>2048){
  throw fail('Airwallex did not return an FPS QR code.',502);
 }
 // The same attempt ID is reused if a request is interrupted or runs concurrently.
 const attemptTime=Date.parse(confirmation.latest_payment_attempt?.created_at||confirmation.updated_at||'');
 const expiresAt=(Number.isFinite(attemptTime)?Math.min(attemptTime,now):now)+validity;
 const qr={text:action.qrcode,expiresAt};
 const [stored]=await sql`UPDATE tsun_airwallex_orders SET fps_qr=${JSON.stringify(qr)}::jsonb
  WHERE merchant_order_id=${s.orderId} AND payment_link_id=${id} AND payment_kind='fps' AND status='pending'
  AND (fps_qr IS NULL OR (fps_qr->>'expiresAt')::bigint<=${now})
  RETURNING fps_qr`;
 if(stored)return {id,totalCents:s.totalCents,...stored.fps_qr};
 const [latest]=await sql`SELECT status,fps_qr FROM tsun_airwallex_orders
  WHERE merchant_order_id=${s.orderId} AND payment_link_id=${id}`;
 return latest?.status==='pending'&&latest.fps_qr?.expiresAt>now
  ? {id,totalCents:s.totalCents,...latest.fps_qr}
  : {id,totalCents:s.totalCents,pending:true};
}

async function cancel(order){
 const s=summary(order), sql=db();
 await fpsSchema(sql);
 const attempt=order.airwallexFpsAttempt??0;
 if(!Number.isInteger(attempt)||attempt<0)throw fail('Invalid FPS checkout.',422);
 // Fence a start request that has been sent but has not written its first row.
 await sql`INSERT INTO tsun_airwallex_orders
  (merchant_order_id,email,amount_cents,order_binding,order_snapshot,payment_kind,status,fps_attempt)
  SELECT ${s.orderId},${s.email},${s.totalCents},${s.binding},'{}'::jsonb,'fps','cancelled',1
  WHERE ${attempt}=0 AND ${order.airwallexSessionId??null}::text IS NULL
  ON CONFLICT DO NOTHING`;
 const [row]=await sql`SELECT order_binding,status,payment_kind,payment_link_id,fps_attempt
  FROM tsun_airwallex_orders WHERE merchant_order_id=${s.orderId}`;
 if(!row||row.order_binding!==s.binding||row.payment_kind!=='fps'||
    (order.airwallexSessionId&&order.airwallexSessionId!==row.payment_link_id)){
  throw fail('FPS checkout does not match this order.');
 }
 if(row.status==='cancelled'&&row.fps_attempt===attempt+1)return {cancelled:true,attempt:row.fps_attempt};
 if(row.fps_attempt!==attempt)throw fail('This checkout has changed. Reopen the current order.');
 const id=row.payment_link_id;
 if(row.status==='paid')return {paid:true,id};
 if(id){
  const config=configuration();
  let intent=await lookup(config,id);
  confirmBinding(intent,id,s);
  if(intent.status==='SUCCEEDED')return {paid:true,id};
  if(['REQUIRES_PAYMENT_METHOD','REQUIRES_CUSTOMER_ACTION','REQUIRES_CAPTURE'].includes(intent.status)){
   try{
    intent=await request(config,encodeURIComponent(id)+'/cancel',{request_id:requestId('cancel',[id])});
   }catch(error){
    // The bank can finish the transfer while the cancellation is in flight.
    intent=await lookup(config,id);
    if(!['SUCCEEDED','CANCELLED'].includes(intent.status))throw error;
   }
   confirmBinding(intent,id,s);
  }
  if(intent.status==='SUCCEEDED')return {paid:true,id};
  if(intent.status!=='CANCELLED')return {pending:true,id};
 }
 const [cancelled]=await sql`UPDATE tsun_airwallex_orders SET status='cancelled',fps_qr=NULL,fps_attempt=fps_attempt+1
  WHERE merchant_order_id=${s.orderId} AND fps_attempt=${attempt} AND payment_kind='fps'
  AND status IN ('creating','pending') AND payment_link_id IS NOT DISTINCT FROM ${id}
  RETURNING fps_attempt`;
 if(cancelled)return {cancelled:true,attempt:cancelled.fps_attempt};
 const [latest]=await sql`SELECT status,fps_attempt,payment_link_id FROM tsun_airwallex_orders
  WHERE merchant_order_id=${s.orderId}`;
 if(latest?.status==='cancelled'&&latest.fps_attempt===attempt+1)return {cancelled:true,attempt:latest.fps_attempt};
 if(latest?.status==='paid'&&latest.payment_link_id===id)return {paid:true,id};
 return {pending:true};
}

module.exports={prepare,verify,cancel};
