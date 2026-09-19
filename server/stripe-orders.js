const {createHmac,timingSafeEqual,createHash}=require('node:crypto');
const {render,escape,safeUrl}=require('./email-template');
const {sendGmail,GMAIL_ADDRESS}=require('./gmail-mailer');

const emailValid=value=>typeof value==='string'&&value.length<=254&&/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
function cors(req,res){res.setHeader('Access-Control-Allow-Origin',req.headers.origin||'*');res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Headers','Content-Type');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.setHeader('Cache-Control','no-store');}
function pricing(order){
  const items=Array.isArray(order.items)?order.items:[];
  const decorCount=items.reduce((total,item)=>total+['front','back'].reduce((sum,side)=>sum+(Array.isArray(item?.decorItems?.[side])?item.decorItems[side].length:0),0),0);
  return {itemCount:items.length,decorCount,totalCents:(items.length*299+decorCount*3)*100};
}
async function stripeSession(sessionId){
  const key=process.env.STRIPE_SECRET_KEY||'';
  if(!/^sk_(test|live)_/.test(key))throw new Error('Stripe 密钥尚未配置');
  if(!/^cs_(test|live)_[A-Za-z0-9_]+$/.test(sessionId||''))throw new Error('Stripe 付款编号无效');
  const response=await fetch('https://api.stripe.com/v1/checkout/sessions/'+encodeURIComponent(sessionId),{headers:{Authorization:'Bearer '+key}});
  const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.error?.message||'无法向 Stripe 核对付款');return result;
}
async function stripeSessionForOrder(order){
  const key=process.env.STRIPE_SECRET_KEY||'';
  if(!/^sk_(test|live)_/.test(key))throw new Error('Stripe 密钥尚未配置');
  if(!/^[\w-]{1,100}$/.test(order?.id||'')||!emailValid(order?.customerEmail))throw new Error('订单资料无效，无法恢复付款');
  const now=Math.floor(Date.now()/1000),created=Math.floor(Date.parse(order.createdAt||'')/1000);
  const createdAfter=Math.max(now-30*24*60*60,Number.isFinite(created)?created-60*60:now-2*24*60*60);
  let startingAfter='';
  for(let page=0;page<3;page+=1){
    const params=new URLSearchParams({limit:'100',status:'complete','created[gte]':String(createdAfter)});
    if(startingAfter)params.set('starting_after',startingAfter);
    const response=await fetch('https://api.stripe.com/v1/checkout/sessions?'+params.toString(),{headers:{Authorization:'Bearer '+key}});
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(result.error?.message||'无法向 Stripe 恢复付款记录');
    const sessions=Array.isArray(result.data)?result.data:[];
    const match=sessions.find(item=>item.client_reference_id===order.id||item.metadata?.order_id===order.id);
    if(match)return match;
    if(!result.has_more||!sessions.length)break;
    startingAfter=String(sessions[sessions.length-1].id||'');
    if(!startingAfter)break;
  }
  throw new Error('暂时没有找到这笔已完成付款');
}
function verifyPaidSession(session,order){
  if(session.payment_status!=='paid')throw new Error('Stripe 尚未确认付款');
  if(!/^[\w-]{1,100}$/.test(order?.id||'')||session.client_reference_id!==order.id)throw new Error('付款与订单号不一致');
  if(!emailValid(order.customerEmail))throw new Error('订单邮箱无效');
  const stripeEmail=String(session.customer_details?.email||session.customer_email||'').toLowerCase();
  if(stripeEmail&&stripeEmail!==String(order.customerEmail).toLowerCase())throw new Error('付款邮箱与订单邮箱不一致');
  const expected=pricing(order);
  if(expected.itemCount<1||expected.itemCount>20||expected.decorCount>240)throw new Error('订单数量无效');
  if(String(session.currency).toLowerCase()!=='hkd'||session.amount_total!==expected.totalCents)throw new Error('Stripe 实收金额与订单金额不一致');
  if(String(session.metadata?.item_count||'')!==String(expected.itemCount)||String(session.metadata?.decor_count||'')!==String(expected.decorCount))throw new Error('付款商品数量与订单不一致');
  return expected;
}
function orderToken(session,order){return createHmac('sha256',process.env.STRIPE_SECRET_KEY).update(session.id+'|'+order.id+'|'+String(order.customerEmail).toLowerCase()).digest('hex');}
function verifyOrderToken(token,session,order){
  if(!/^[a-f0-9]{64}$/.test(token||''))return false;const expected=Buffer.from(orderToken(session,order),'hex'),actual=Buffer.from(token,'hex');return actual.length===expected.length&&timingSafeEqual(actual,expected);
}
function pngAttachments(list,inline=false){
  if(!Array.isArray(list)||list.length>60)throw new Error('订单图片数量不正确');
  return list.map((item,index)=>{const data=String(item.data||'');if(!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data))throw new Error('订单图片必须为 PNG');const content=data.slice(data.indexOf(',')+1);if(!Buffer.from(content,'base64').subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('PNG 图片内容无效');const filename=String(item.name||('狗牌-'+index+'.png')).replace(/[\r\n/\\]/g,'-').slice(0,120);return {filename,content,content_type:'image/png',...(inline?{content_id:'tag-preview-'+index}:{})};});
}
async function deliver(stage,order,previews,attachments=[]){
  if(!process.env.SMTP_APP_PASSWORD)return {customerSent:false,merchantSent:false,error:'Gmail 发信授权尚未配置'};
  if(stage==='order_completed'&&!safeUrl(order.cloudProfile?.publicUrl))throw new Error('宠物档案网址尚未生成');
  const previewFiles=pngAttachments(previews,true);if(!previewFiles.length)throw new Error('订单缺少狗牌效果图');
  const message=render(order,stage,previewFiles.map((file,index)=>({src:'cid:'+file.content_id,label:previews[index].label})));
  const identity=createHash('sha256').update(order.id+'|'+stage+'|'+order.customerEmail).digest('hex');
  const shared={from:GMAIL_ADDRESS,reply_to:GMAIL_ADDRESS};
  const customer=await sendGmail({...shared,to:[order.customerEmail],subject:message.subject,html:message.html,text:message.text,attachments:previewFiles},'tsun-customer-'+identity);
  let merchant={sent:false,skipped:true};
  if(stage==='order_completed'){
    const files=pngAttachments(attachments);const merchantEmail=process.env.MERCHANT_EMAIL||GMAIL_ADDRESS;if(!files.length)throw new Error('生产文件不完整');
    merchant=await sendGmail({...shared,to:[merchantEmail],subject:'尊八八制作订单｜'+order.id,html:`<h2>已付款，资料已收齐</h2><p>订单号：${escape(order.id)}<br>客户邮箱：${escape(order.customerEmail)}<br>金额：HK$${(order.paidAmountCents/100).toFixed(2)}<br>收货人：${escape(order.shipName)}<br>联系电话：${escape(order.shipPhone)}<br>地址：${escape(order.shipAddress)}</p><p>NFC 档案：<a href="${escape(safeUrl(order.cloudProfile?.publicUrl))}">${escape(safeUrl(order.cloudProfile?.publicUrl))}</a></p><p>请将档案网址写入 NFC；生产图片见附件。</p>`,attachments:files},'tsun-merchant-'+identity);
  }
  return {customerSent:customer.sent,merchantSent:merchant.sent,customer,merchant};
}
module.exports={cors,pricing,stripeSession,stripeSessionForOrder,verifyPaidSession,orderToken,verifyOrderToken,deliver};
