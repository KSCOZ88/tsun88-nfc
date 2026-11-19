'use strict';
const {createHash,createHmac,timingSafeEqual}=require('node:crypto');
const {neon}=require('@neondatabase/serverless');
const {summary}=require('./airwallex-checkout');
const {sendGmail,GMAIL_ADDRESS}=require('./gmail-mailer');
const {escape}=require('./email-template');

const fail=(message,status=422)=>Object.assign(new Error(message),{status});
let schemaPromise;

function liveConfig(requireWebhook=false){
  if(process.env.VERCEL_ENV!=='production')throw fail('Stripe Live 付款只允许在正式 Production 环境使用。',503);
  const key=process.env.STRIPE_SECRET_KEY||'';
  if(!/^sk_live_[A-Za-z0-9]+$/.test(key))throw fail('Stripe 正式 API 密钥未配置，或当前密钥不是 Live Key。',503);
  const webhookSecret=process.env.STRIPE_WEBHOOK_SECRET||'';
  if(requireWebhook&&!/^whsec_[A-Za-z0-9]+$/.test(webhookSecret))throw fail('Stripe 正式 Webhook 签名密钥尚未配置。',503);
  return {key,webhookSecret};
}

function db(){
  if(!process.env.DATABASE_URL)throw fail('订单数据库尚未连接。',503);
  return neon(process.env.DATABASE_URL);
}

async function schema(sql){
  if(!schemaPromise)schemaPromise=(async()=>{
    await sql`CREATE TABLE IF NOT EXISTS tsun_stripe_orders (
      merchant_order_id TEXT PRIMARY KEY,
      stripe_session_id TEXT UNIQUE,
      stripe_payment_intent_id TEXT UNIQUE,
      checkout_url TEXT,
      email TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      order_digest TEXT NOT NULL,
      item_count INTEGER NOT NULL,
      decor_count INTEGER NOT NULL,
      order_snapshot JSONB NOT NULL,
      payment_status TEXT NOT NULL DEFAULT 'creating',
      checkout_attempt INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      paid_at TIMESTAMPTZ,
      last_reconciled_at TIMESTAMPTZ
    )`;
    await sql`CREATE TABLE IF NOT EXISTS tsun_stripe_webhook_events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      processed_at TIMESTAMPTZ,
      processing_until TIMESTAMPTZ,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    )`;
    await sql`CREATE TABLE IF NOT EXISTS tsun_stripe_mail (
      merchant_order_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      customer_sent BOOLEAN NOT NULL DEFAULT false,
      merchant_sent BOOLEAN NOT NULL DEFAULT false,
      processing_until TIMESTAMPTZ,
      PRIMARY KEY (merchant_order_id,stage)
    )`;
  })().catch(error=>{schemaPromise=null;throw error;});
  return schemaPromise;
}

function safeSnapshot(order){
  const result=JSON.parse(JSON.stringify(order||{}));
  function strip(value,depth=0){
    if(!value||typeof value!=='object'||depth>14)return;
    for(const [key,item] of Object.entries(value)){
      if(typeof item==='string'&&(item.startsWith('data:image/')||item.length>12000))value[key]='[image not stored]';
      else if(item&&typeof item==='object')strip(item,depth+1);
    }
  }
  strip(result);
  if(Buffer.byteLength(JSON.stringify(result))>220000)throw fail('订单资料过大，请精简后重试。',413);
  return result;
}

function siteBase(req){
  const origin=String(req?.headers?.origin||'');
  try{
    const url=new URL(origin),host=url.hostname.toLowerCase();
    if(url.protocol==='https:'&&(host==='8tsun8.com'||host==='www.8tsun8.com'||/^tsun88-nfc-l86b(?:-[a-z0-9-]+)?\.vercel\.app$/.test(host)))return url.origin;
  }catch{}
  return 'https://www.8tsun8.com';
}

async function stripeRequest(config,path,method='GET',params=null,idempotencyKey=''){
  let response;
  try{
    response=await fetch('https://api.stripe.com/v1'+path,{
      method,
      headers:{
        Authorization:'Bearer '+config.key,
        ...(params?{'Content-Type':'application/x-www-form-urlencoded'}:{}),
        ...(idempotencyKey?{'Idempotency-Key':idempotencyKey}:{})
      },
      ...(params?{body:params.toString()}:{}),
      signal:AbortSignal.timeout(18000)
    });
  }catch{
    throw fail('暂时无法连接 Stripe。请稍后再试，不要重复付款。',503);
  }
  const data=await response.json().catch(()=>({}));
  if(!response.ok){
    const rawCode=String(data?.error?.code||data?.error?.type||'');
    const code=/^[a-zA-Z0-9_.-]{1,60}$/.test(rawCode)?rawCode:'unavailable';
    console.error('[Stripe API]',{status:response.status,code});
    if(response.status===401)throw fail('Stripe 正式 API 密钥未获授权，请核对 Live Key。',503);
    if(response.status===429||response.status>=500)throw fail('Stripe 暂时繁忙，请稍后重试。',503);
    throw fail('Stripe 暂时无法处理这笔付款，请核对账户设置后重试。',502);
  }
  return data;
}

async function fetchSession(config,sessionId){
  if(!/^cs_[A-Za-z0-9_]+$/.test(String(sessionId||'')))throw fail('Stripe Checkout Session 编号无效。',422);
  return stripeRequest(config,'/checkout/sessions/'+encodeURIComponent(sessionId));
}

function expectedMetadata(row){
  return {
    order_id:String(row.merchant_order_id),
    order_binding:String(row.order_digest),
    item_count:String(row.item_count),
    decor_count:String(row.decor_count),
    total_cents:String(row.amount_cents)
  };
}

function matchSession(session,row){
  if(!session||session.livemode!==true)throw fail('Stripe 交易不是正式 Live 交易。',409);
  if(session.mode!=='payment')throw fail('Stripe 付款模式不正确。',409);
  if(String(session.currency||'').toLowerCase()!=='hkd')throw fail('Stripe 付款币种不是 HKD。',409);
  if(Number(session.amount_total)!==Number(row.amount_cents))throw fail('Stripe 实收金额与订单金额不一致。',409);
  if(String(session.client_reference_id||'')!==String(row.merchant_order_id))throw fail('Stripe 订单编号不匹配。',409);
  const metadata=session.metadata||{};
  for(const [key,value] of Object.entries(expectedMetadata(row))){
    if(String(metadata[key]||'')!==value)throw fail('Stripe 订单资料或金额校验失败。',409);
  }
  const email=String(session.customer_details?.email||session.customer_email||'').trim().toLowerCase();
  if(email&&email!==String(row.email||'').toLowerCase())throw fail('Stripe 付款邮箱与订单邮箱不一致。',409);
  return {
    paymentIntentId:typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id||'',
    amountTotal:Number(session.amount_total),
    currency:'hkd'
  };
}

function verifyPaidSession(session,row){
  const matched=matchSession(session,row);
  if(session.status!=='complete'||session.payment_status!=='paid')throw fail('Stripe 尚未确认付款成功，请不要重复付款。',409);
  if(!matched.paymentIntentId)throw fail('Stripe 尚未返回有效的付款交易编号。',409);
  return matched;
}

function validCheckoutUrl(value){
  try{
    const url=new URL(String(value||''));
    return url.protocol==='https:'&&(url.hostname==='checkout.stripe.com'||url.hostname.endsWith('.stripe.com'));
  }catch{return false;}
}

async function markPaid(sql,row,verified){
  const updated=await sql`UPDATE tsun_stripe_orders
    SET payment_status='paid',
        stripe_payment_intent_id=${verified.paymentIntentId},
        paid_at=COALESCE(paid_at,now())
    WHERE merchant_order_id=${row.merchant_order_id}
      AND stripe_session_id=${row.stripe_session_id}
      AND order_digest=${row.order_digest}
      AND amount_cents=${row.amount_cents}
      AND (payment_status<>'paid' OR stripe_payment_intent_id=${verified.paymentIntentId})
    RETURNING *`;
  if(updated.length)return updated[0];
  const [existing]=await sql`SELECT * FROM tsun_stripe_orders WHERE merchant_order_id=${row.merchant_order_id}`;
  if(existing?.payment_status==='paid'&&existing.stripe_session_id===row.stripe_session_id&&existing.stripe_payment_intent_id===verified.paymentIntentId)return existing;
  throw fail('Stripe 付款记录与网站订单不一致，请联系客服核查。',409);
}

function orderToken(config,row){
  return createHmac('sha256',config.key)
    .update([row.merchant_order_id,row.stripe_session_id,row.order_digest,row.stripe_payment_intent_id].join('|'))
    .digest('hex');
}

function verifyToken(config,row,value){
  if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))return false;
  const expected=Buffer.from(orderToken(config,row),'hex');
  const actual=Buffer.from(value,'hex');
  return actual.length===expected.length&&timingSafeEqual(expected,actual);
}

async function enqueue(eventId,sessionId,eventType='checkout.session.completed'){
  if(!/^[A-Za-z0-9_-]{6,140}$/.test(String(eventId||''))||!/^cs_[A-Za-z0-9_]+$/.test(String(sessionId||'')))throw fail('Stripe Webhook 事件编号无效。',422);
  const sql=db();await schema(sql);
  await sql`INSERT INTO tsun_stripe_webhook_events (event_id,session_id,event_type)
    VALUES (${eventId},${sessionId},${eventType})
    ON CONFLICT(event_id) DO NOTHING`;
}

async function create(req,order){
  const config=liveConfig(true),s=summary(order),sql=db();
  await schema(sql);
  const snapshot=safeSnapshot(order);
  await sql`INSERT INTO tsun_stripe_orders
    (merchant_order_id,email,amount_cents,order_digest,item_count,decor_count,order_snapshot)
    VALUES (${s.orderId},${s.email},${s.totalCents},${s.binding},${s.itemCount},${s.decorCount},${JSON.stringify(snapshot)}::jsonb)
    ON CONFLICT(merchant_order_id) DO NOTHING`;
  let [row]=await sql`SELECT * FROM tsun_stripe_orders WHERE merchant_order_id=${s.orderId}`;
  if(!row||row.order_digest!==s.binding||Number(row.amount_cents)!==s.totalCents||String(row.email).toLowerCase()!==s.email.toLowerCase())throw fail('订单金额或邮箱已改变，请创建新订单。',409);
  if(row.payment_status==='paid')throw fail('这笔订单已经付款，请勿重复支付。',409);

  if(row.stripe_session_id){
    const previous=await fetchSession(config,row.stripe_session_id);
    matchSession(previous,row);
    if(previous.status==='open'&&validCheckoutUrl(previous.url)){
      return {id:previous.id,url:previous.url,totalCents:s.totalCents,mode:'live',kind:'stripe_checkout'};
    }
    if(previous.status==='complete'&&previous.payment_status==='paid'){
      const verified=verifyPaidSession(previous,row);
      row=await markPaid(sql,row,verified);
      const eventId='recover_'+createHash('sha256').update(previous.id).digest('hex');
      await enqueue(eventId,previous.id);
      return {id:previous.id,totalCents:s.totalCents,mode:'live',kind:'stripe_checkout',alreadyPaid:true};
    }
    if(previous.status==='expired'){
      const reset=await sql`UPDATE tsun_stripe_orders
        SET stripe_session_id=NULL,checkout_url=NULL,payment_status='expired',checkout_attempt=checkout_attempt+1
        WHERE merchant_order_id=${s.orderId} AND payment_status<>'paid'
        RETURNING checkout_attempt`;
      if(!reset.length)throw fail('订单状态已改变，请先核对付款结果。',409);
      row.checkout_attempt=reset[0].checkout_attempt;
      row.stripe_session_id=null;
    }else{
      throw fail('这笔订单已有付款流程正在处理。请先检查付款状态，不要重复付款。',409);
    }
  }

  const attempt=Number(row.checkout_attempt||0);
  const origin=siteBase(req);
  const successUrl=origin+'/?stripe_return=success&order_id='+encodeURIComponent(s.orderId)+'&session_id={CHECKOUT_SESSION_ID}';
  const cancelUrl=origin+'/?stripe_return=cancelled&order_id='+encodeURIComponent(s.orderId);
  const params=new URLSearchParams();
  params.set('mode','payment');
  params.set('success_url',successUrl);
  params.set('cancel_url',cancelUrl);
  params.set('client_reference_id',s.orderId);
  params.set('customer_email',s.email);
  params.set('payment_method_types[0]','card');
  params.set('line_items[0][price_data][currency]','hkd');
  params.set('line_items[0][price_data][product_data][name]','8TSUN8 NFC Pet Tag');
  params.set('line_items[0][price_data][unit_amount]','29900');
  params.set('line_items[0][quantity]',String(s.itemCount));
  if(s.decorCount){
    params.set('line_items[1][price_data][currency]','hkd');
    params.set('line_items[1][price_data][product_data][name]','8TSUN8 Tag Charms');
    params.set('line_items[1][price_data][unit_amount]','300');
    params.set('line_items[1][quantity]',String(s.decorCount));
  }
  for(const [key,value] of Object.entries(expectedMetadata({
    merchant_order_id:s.orderId,order_digest:s.binding,item_count:s.itemCount,decor_count:s.decorCount,amount_cents:s.totalCents
  }))){
    params.set('metadata['+key+']',value);
    params.set('payment_intent_data[metadata]['+key+']',value);
  }
  const idem='tsun88-'+createHash('sha256').update(s.orderId+'|'+attempt).digest('hex');
  const session=await stripeRequest(config,'/checkout/sessions','POST',params,idem);
  if(!/^cs_[A-Za-z0-9_]+$/.test(session.id||'')||!validCheckoutUrl(session.url))throw fail('Stripe 没有返回有效的正式付款页面。',502);
  matchSession(session,{...row,merchant_order_id:s.orderId,order_digest:s.binding,email:s.email,amount_cents:s.totalCents,item_count:s.itemCount,decor_count:s.decorCount});
  const saved=await sql`UPDATE tsun_stripe_orders
    SET stripe_session_id=${session.id},checkout_url=${session.url},payment_status='pending'
    WHERE merchant_order_id=${s.orderId}
      AND order_digest=${s.binding}
      AND amount_cents=${s.totalCents}
      AND payment_status<>'paid'
      AND (stripe_session_id IS NULL OR stripe_session_id=${session.id})
    RETURNING merchant_order_id`;
  if(!saved.length){
    const [latest]=await sql`SELECT stripe_session_id,payment_status FROM tsun_stripe_orders WHERE merchant_order_id=${s.orderId}`;
    if(latest?.payment_status==='paid')return {id:session.id,totalCents:s.totalCents,mode:'live',kind:'stripe_checkout',alreadyPaid:true};
    if(latest?.stripe_session_id!==session.id)throw fail('付款会话保存失败，请勿重复付款，联系客服核查。',503);
  }
  return {id:session.id,url:session.url,totalCents:s.totalCents,mode:'live',kind:'stripe_checkout'};
}

async function confirm(sessionId,order){
  const config=liveConfig(false),s=summary(order),sql=db();
  await schema(sql);
  const [row]=await sql`SELECT * FROM tsun_stripe_orders
    WHERE merchant_order_id=${s.orderId} AND stripe_session_id=${sessionId}`;
  if(!row)throw fail('找不到与这笔 Stripe 付款匹配的订单。',404);
  if(row.order_digest!==s.binding||Number(row.amount_cents)!==s.totalCents||String(row.email).toLowerCase()!==s.email.toLowerCase())throw fail('Stripe 付款与订单资料不匹配。',409);
  const session=await fetchSession(config,sessionId);
  const verified=verifyPaidSession(session,row);
  const paid=await markPaid(sql,row,verified);
  const eventId='confirm_'+createHash('sha256').update(sessionId).digest('hex');
  await enqueue(eventId,sessionId);
  return {
    paid:true,sessionId,paymentIntentId:verified.paymentIntentId,
    amountTotal:verified.amountTotal,currency:'hkd',mode:'live',
    orderToken:orderToken(config,paid),eventId
  };
}

async function verifiedPaid(orderId,sessionId,token,order){
  const config=liveConfig(false),s=summary(order),sql=db();
  await schema(sql);
  const [row]=await sql`SELECT * FROM tsun_stripe_orders
    WHERE merchant_order_id=${orderId} AND stripe_session_id=${sessionId} AND payment_status='paid'`;
  if(!row||!verifyToken(config,row,token))throw fail('没有有效的 Stripe 已付款记录。',401);
  if(s.orderId!==row.merchant_order_id||s.binding!==row.order_digest||s.totalCents!==Number(row.amount_cents)||s.email.toLowerCase()!==String(row.email).toLowerCase())throw fail('提交订单与已付款商品不一致。',409);
  const session=await fetchSession(config,sessionId);
  const verified=verifyPaidSession(session,row);
  return {row,sql,summary:s,verified};
}

async function sendReceipt(sql,row){
  await schema(sql);
  if(!process.env.SMTP_APP_PASSWORD)throw fail('Gmail 发信授权尚未配置。',503);
  await sql`INSERT INTO tsun_stripe_mail (merchant_order_id,stage)
    VALUES (${row.merchant_order_id},'payment_received') ON CONFLICT DO NOTHING`;
  const [claim]=await sql`UPDATE tsun_stripe_mail
    SET processing_until=now()+interval '4 minutes'
    WHERE merchant_order_id=${row.merchant_order_id} AND stage='payment_received'
      AND (processing_until IS NULL OR processing_until<now())
      AND (customer_sent=false OR merchant_sent=false)
    RETURNING customer_sent,merchant_sent`;
  if(!claim){
    const [previous]=await sql`SELECT customer_sent,merchant_sent FROM tsun_stripe_mail
      WHERE merchant_order_id=${row.merchant_order_id} AND stage='payment_received'`;
    return {customerSent:!!previous?.customer_sent,merchantSent:!!previous?.merchant_sent,alreadyHandled:true,complete:!!previous?.customer_sent&&!!previous?.merchant_sent};
  }
  const amount='HK$'+(Number(row.amount_cents)/100).toFixed(2);
  const id=String(row.merchant_order_id);
  const transaction=String(row.stripe_payment_intent_id||'');
  try{
    if(!claim.customer_sent){
      const customer=await sendGmail({
        to:[row.email],
        subject:'8TSUN8 付款确认 / Payment received – '+id,
        html:'<h2>8TSUN8 已收到付款</h2><p>订单编号：'+escape(id)+'</p><p>付款方式：Stripe</p><p>实付金额：'+amount+'</p><p>请继续返回网站填写配送资料并完成宠物 NFC 档案，资料齐全后我们会安排制作。</p>',
        text:'8TSUN8 已收到付款。订单：'+id+'；付款方式：Stripe；金额：'+amount+'。请继续填写配送资料和宠物 NFC 档案。'
      },'tsun-stripe-customer-'+createHash('sha256').update(id).digest('hex'));
      if(!customer.sent)throw fail('客户付款确认邮件未被 Gmail 接受。',503);
      await sql`UPDATE tsun_stripe_mail SET customer_sent=true
        WHERE merchant_order_id=${id} AND stage='payment_received'`;
    }
    if(!claim.merchant_sent){
      const merchantEmail=process.env.MERCHANT_EMAIL||GMAIL_ADDRESS;
      const merchant=await sendGmail({
        to:[merchantEmail],
        subject:'8TSUN8 新付款订单｜'+id,
        html:'<h2>Stripe 正式付款已确认</h2><p>订单编号：'+escape(id)+'</p><p>客户邮箱：'+escape(row.email)+'</p><p>实付金额：'+amount+'</p><p>Stripe Payment Intent：'+escape(transaction)+'</p><p>请等待客户补齐宠物档案和配送资料后再安排生产。</p>',
        text:'Stripe 正式付款已确认。订单：'+id+'；客户：'+row.email+'；金额：'+amount+'；Payment Intent：'+transaction+'。等待客户补齐档案和配送资料。'
      },'tsun-stripe-merchant-'+createHash('sha256').update(id).digest('hex'));
      if(!merchant.sent)throw fail('商户新订单通知邮件未被 Gmail 接受。',503);
      await sql`UPDATE tsun_stripe_mail SET merchant_sent=true
        WHERE merchant_order_id=${id} AND stage='payment_received'`;
    }
  }finally{
    await sql`UPDATE tsun_stripe_mail SET processing_until=NULL
      WHERE merchant_order_id=${id} AND stage='payment_received'`;
  }
  const [done]=await sql`SELECT customer_sent,merchant_sent FROM tsun_stripe_mail
    WHERE merchant_order_id=${id} AND stage='payment_received'`;
  return {customerSent:!!done?.customer_sent,merchantSent:!!done?.merchant_sent,complete:!!done?.customer_sent&&!!done?.merchant_sent};
}

async function processEvent(eventId){
  const sql=db();await schema(sql);
  const [event]=await sql`UPDATE tsun_stripe_webhook_events
    SET processing_until=now()+interval '2 minutes',attempts=attempts+1
    WHERE event_id=${eventId} AND processed_at IS NULL
      AND (processing_until IS NULL OR processing_until<now())
    RETURNING session_id,event_type`;
  if(!event)return {status:'handled-or-busy'};
  try{
    const [row]=await sql`SELECT * FROM tsun_stripe_orders WHERE stripe_session_id=${event.session_id}`;
    if(!row){
      await sql`UPDATE tsun_stripe_webhook_events SET processed_at=now(),processing_until=NULL,last_error='unmatched order'
        WHERE event_id=${eventId}`;
      return {status:'unmatched'};
    }
    const config=liveConfig(false);
    const session=await fetchSession(config,event.session_id);
    if(session.payment_status!=='paid'){
      if(event.event_type==='checkout.session.expired'||event.event_type==='checkout.session.async_payment_failed'){
        const nextStatus=event.event_type==='checkout.session.expired'?'expired':'failed';
        await sql`UPDATE tsun_stripe_orders SET payment_status=${nextStatus}
          WHERE merchant_order_id=${row.merchant_order_id} AND stripe_session_id=${event.session_id} AND payment_status<>'paid'`;
        await sql`UPDATE tsun_stripe_webhook_events SET processed_at=now(),processing_until=NULL,last_error=NULL
          WHERE event_id=${eventId}`;
        return {status:nextStatus};
      }
      await sql`UPDATE tsun_stripe_webhook_events SET processing_until=NULL,last_error='payment_not_paid'
        WHERE event_id=${eventId}`;
      return {status:'not-paid'};
    }
    const verified=verifyPaidSession(session,row);
    const paid=await markPaid(sql,row,verified);
    const mail=await sendReceipt(sql,paid);
    if(!mail.complete)throw fail('付款确认邮件尚未全部发送。',503);
    await sql`UPDATE tsun_stripe_webhook_events SET processed_at=now(),processing_until=NULL,last_error=NULL
      WHERE event_id=${eventId}`;
    return {status:'processed',customerSent:mail.customerSent,merchantSent:mail.merchantSent};
  }catch(error){
    console.error('[Stripe webhook worker] failed',{status:Number(error?.status)||500});
    await sql`UPDATE tsun_stripe_webhook_events SET processing_until=NULL,last_error=${String(error?.status||'processing_failed')}
      WHERE event_id=${eventId}`.catch(()=>{});
    return {status:'retryable-error'};
  }
}

async function retryPending(limit=3){
  const sql=db();await schema(sql);
  const capped=Math.min(10,Math.max(1,Number(limit)||3));
  const waiting=await sql`SELECT event_id FROM tsun_stripe_webhook_events
    WHERE processed_at IS NULL AND (processing_until IS NULL OR processing_until<now())
    ORDER BY received_at ASC LIMIT ${capped}`;
  return Promise.all(waiting.map(row=>processEvent(row.event_id)));
}

async function reconcilePending(limit=3){
  const sql=db();await schema(sql);
  const capped=Math.min(10,Math.max(1,Number(limit)||3));
  const pending=await sql`SELECT merchant_order_id,stripe_session_id
    FROM tsun_stripe_orders
    WHERE stripe_session_id IS NOT NULL
      AND payment_status IN ('pending','paid')
      AND (last_reconciled_at IS NULL OR last_reconciled_at<now()-interval '20 hours')
    ORDER BY last_reconciled_at ASC NULLS FIRST,created_at ASC
    LIMIT ${capped}`;
  const results=[];
  const config=liveConfig(false);
  for(const row of pending){
    await sql`UPDATE tsun_stripe_orders SET last_reconciled_at=now()
      WHERE merchant_order_id=${row.merchant_order_id}`;
    try{
      const session=await fetchSession(config,row.stripe_session_id);
      if(session.payment_status==='paid'){
        const eventId='reconcile_'+createHash('sha256').update(row.stripe_session_id).digest('hex');
        await enqueue(eventId,row.stripe_session_id);
        results.push(await processEvent(eventId));
      }else results.push({status:'not-paid'});
    }catch(error){
      results.push({status:'verification-unavailable'});
      console.warn('[Stripe reconcile] lookup unavailable',{status:Number(error?.status)||500});
    }
  }
  return results;
}

async function dailyReconciliation(){
  const queued=await retryPending(5);
  const reconciled=await reconcilePending(5);
  console.info('[Stripe reconcile] sweep complete',{queued:queued.length,reconciled:reconciled.length});
  return {queued:queued.length,reconciled:reconciled.length};
}

function verifyWebhookSignature(rawBody,header,secret,now=Date.now()){
  if(typeof rawBody!=='string'||!secret||typeof header!=='string')return false;
  const fields=header.split(',').map(part=>part.trim().split('=',2));
  const timestamp=fields.find(([key])=>key==='t')?.[1]||'';
  const signatures=fields.filter(([key])=>key==='v1').map(([,value])=>value||'');
  if(!/^\d{10}$/.test(timestamp)||!signatures.length)return false;
  if(Math.abs(Math.floor(now/1000)-Number(timestamp))>300)return false;
  const expected=createHmac('sha256',secret).update(timestamp+'.'+rawBody).digest();
  return signatures.some(value=>{
    if(!/^[a-f0-9]{64}$/i.test(value))return false;
    const actual=Buffer.from(value,'hex');
    return actual.length===expected.length&&timingSafeEqual(actual,expected);
  });
}

function parseBody(req){
  const body=typeof req.body==='string'?JSON.parse(req.body):req.body||{};
  if(!body||typeof body!=='object'||Array.isArray(body)||Buffer.byteLength(JSON.stringify(body))>9*1024*1024)throw fail('订单资料无效或过大。',413);
  return body;
}

function post(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method==='OPTIONS'){res.status(204).end();return false;}
  if(req.method!=='POST'){res.status(405).json({error:'仅支持 POST 请求。'});return false;}
  return true;
}

function handleError(res,error){
  const status=Number(error?.status)||502;
  console.error('[Stripe handler]',{status});
  return res.status(status).json({error:status<500?String(error.message||'请求无效'):'Stripe 正式付款暂时无法处理，请稍后重试。'});
}

module.exports={
  liveConfig,db,schema,summary,create,confirm,verifiedPaid,sendReceipt,
  enqueue,processEvent,retryPending,dailyReconciliation,
  verifyWebhookSignature,parseBody,post,handleError
};
