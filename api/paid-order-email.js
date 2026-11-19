// One-time protected mail QA deployment refresh.\nconst p=require('../server/stripe-orders');
const store=require('../server/stripe-order-store');
module.exports=async function(req,res){p.cors(req,res);if(req.method==='OPTIONS')return res.status(204).end();if(req.method!=='POST')return res.status(405).json({error:'仅支持 POST 请求'});try{const body=typeof req.body==='string'?JSON.parse(req.body):req.body||{};
if(body.testLanguageEmails===true){
 const crypto=require('node:crypto');
 const expected=Buffer.from(String(process.env.EMAIL_TEST_TOKEN||''));
 const supplied=Buffer.from(String(req.headers['x-mail-test-token']||''));
 if(expected.length<32||expected.length!==supplied.length||!crypto.timingSafeEqual(expected,supplied))return res.status(401).json({error:'Unauthorized'});
 const {render,renderMerchant}=require('../server/email-template');
 const {sendGmail,GMAIL_ADDRESS}=require('../server/gmail-mailer');
 const recipient='tsunlab888@gmail.com';
 const order={id:'TEST-LANGUAGE-'+new Date().toISOString().slice(0,10),customerEmail:recipient,payMethod:'Stripe',paidAmountCents:29900,shipName:'Test Recipient',shipPhone:'00000000',shipAddress:'TEST ONLY — no shipment',items:[{petName:'Lucky',baseLabel:'Classic',decorItems:{front:[],back:[]}}],cloudProfile:{}};
 const results=[];
 for(const language of ['zh-Hant','en']){
  order.language=language;
  const customer=render(order,'payment_received',[]);
  const merchant=renderMerchant(order,[]);
  const banner=language==='en'?'<p><b>[TEST]</b> No payment was made and no order was created.</p>':'<p><b>[測試郵件]</b> 此郵件僅供測試，並未收取款項或建立正式訂單。</p>';
  const c=await sendGmail({from:GMAIL_ADDRESS,to:[recipient],subject:'[TEST] '+customer.subject,html:customer.html.replace('<div style="padding:28px">','<div style="padding:28px">'+banner),text:'[TEST] No payment was made.\\n'+customer.text},'8tsun8-test-customer-'+language+'-'+order.id);
  results.push({type:'customer',language,sent:c.sent===true});
  const m=await sendGmail({from:GMAIL_ADDRESS,to:[recipient],subject:'[TEST] '+merchant.subject,html:merchant.html.replace('><h2>','>'+banner+'<h2>')},'8tsun8-test-merchant-'+language+'-'+order.id);
  results.push({type:'merchant',language,sent:m.sent===true});
 }
 return res.status(results.every(x=>x.sent)?200:502).json({recipient,results,allSent:results.every(x=>x.sent)});
}
if(Buffer.byteLength(JSON.stringify(body))>9*1024*1024)return res.status(413).json({error:'订单图片过大'});if(Buffer.byteLength(JSON.stringify(body))>9*1024*1024)return res.status(413).json({error:'订单图片过大'});if(!['payment_received','order_completed','in_production','shipped'].includes(body.type))return res.status(422).json({error:'邮件类型无效'});const order=body.order||{};const session=await p.stripeSession(String(body.sessionId||''));p.verifyPaidSession(session,order);if(!p.verifyOrderToken(String(body.orderToken||''),session,order))return res.status(401).json({error:'订单验证已失效'});order.paymentStatus='paid';order.payMethod='Stripe';order.paymentTransactionId=String(session.payment_intent||session.id);order.paidAmountCents=session.amount_total;const result=await store.deliverStage(order,session.id,body.type,body.previews||[],body.attachments||[]);return res.status(200).json(result);}catch(error){return res.status(Number(error.status)||422).json({error:error.message||'Stripe 订单邮件发送失败'});}};
