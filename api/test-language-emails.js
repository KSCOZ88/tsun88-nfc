'use strict';
const {timingSafeEqual}=require('node:crypto');
const {render,renderMerchant}=require('../server/email-template');
const {sendGmail,GMAIL_ADDRESS}=require('../server/gmail-mailer');
const RECIPIENT='tsunlab888@gmail.com';
function authorized(req){
  const expected=Buffer.from(String(process.env.EMAIL_TEST_TOKEN||''));
  const supplied=Buffer.from(String(req.headers.authorization||'').replace(/^Bearer\\s+/i,''));
  return expected.length>=32&&expected.length===supplied.length&&timingSafeEqual(expected,supplied);
}
module.exports=async function(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  if(!authorized(req))return res.status(401).json({error:'Unauthorized'});
  if(!process.env.SMTP_APP_PASSWORD)return res.status(503).json({error:'Mail transport is not configured'});
  const order={
    id:'TEST-LANGUAGE-'+new Date().toISOString().slice(0,10),
    language:'en',
    customerEmail:RECIPIENT,
    payMethod:'Stripe',
    paidAmountCents:29900,
    shipName:'Test Recipient',
    shipPhone:'00000000',
    shipAddress:'TEST ONLY — no shipment',
    items:[{petName:'Lucky',baseLabel:'Classic',decorItems:{front:[],back:[]}}],
    cloudProfile:{}
  };
  const sends=[];
  for(const language of ['zh-Hant','en']){
    order.language=language;
    const customer=render(order,'payment_received',[]);
    const merchant=renderMerchant(order,[]);
    const banner=language==='en'
      ? '<p style="padding:12px;background:#fff4cc;border:1px solid #e5c76b"><b>[TEST]</b> This is a test email only. No payment was made and no order was created.</p>'
      : '<p style="padding:12px;background:#fff4cc;border:1px solid #e5c76b"><b>[測試郵件]</b> 此郵件僅供測試，並未收取款項或建立正式訂單。</p>';
    const label=language==='en'?'English':'繁體中文';
    const customerResult=await sendGmail({
      from:GMAIL_ADDRESS,to:[RECIPIENT],subject:'[TEST] '+customer.subject,
      html:customer.html.replace('<div style="padding:28px">','<div style="padding:28px">'+banner),
      text:'[TEST] No payment was made.\\n'+customer.text
    },'8tsun8-test-customer-'+language+'-'+order.id);
    sends.push({type:'customer',language:label,sent:customerResult.sent===true,error:customerResult.sent?undefined:customerResult.error});
    const merchantResult=await sendGmail({
      from:GMAIL_ADDRESS,to:[RECIPIENT],subject:'[TEST] '+merchant.subject,
      html:merchant.html.replace('<body style=','<body style=').replace('><h2>','>'+banner+'<h2>')
    },'8tsun8-test-merchant-'+language+'-'+order.id);
    sends.push({type:'merchant',language:label,sent:merchantResult.sent===true,error:merchantResult.sent?undefined:merchantResult.error});
  }
  const ok=sends.every(item=>item.sent);
  return res.status(ok?200:502).json({recipient:RECIPIENT,results:sends,allSent:ok});
};
