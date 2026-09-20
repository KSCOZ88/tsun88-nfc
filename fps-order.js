const {createHash}=require('node:crypto');
const {escape,safeUrl}=require('../server/email-template');
const {sendGmail:sendEmail,GMAIL_ADDRESS}=require('../server/gmail-mailer');

const emailValid=value=>typeof value==='string'&&value.length<=254&&/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
const text=(value,max=300)=>String(value||'').replace(/[\r\n]+/g,' ').trim().slice(0,max);
function imageAttachment(data,name){
  const match=String(data||'').match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/);
  if(!match)throw new Error('付款截图格式无效');
  const content=match[2],bytes=Buffer.from(content,'base64');
  if(!bytes.length||bytes.length>1200*1024)throw new Error('付款截图过大');
  return {filename:name+'.'+(match[1]==='png'?'png':'jpg'),content,content_type:'image/'+match[1]};
}
function pngAttachments(list){
  if(!Array.isArray(list)||list.length>40)throw new Error('订单图片数量不正确');
  return list.map((item,index)=>{
    const data=String(item.data||''),match=data.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
    if(!match)throw new Error('订单图片必须为 PNG');
    const content=match[1],bytes=Buffer.from(content,'base64');
    if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('PNG 图片内容无效');
    return {filename:text(item.name||('狗牌-'+index+'.png'),120).replace(/[\/\\]/g,'-'),content,content_type:'image/png'};
  });
}
module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST')return res.status(405).json({error:'仅支持 POST 请求'});
  let body;try{body=typeof req.body==='string'?JSON.parse(req.body):req.body||{};}catch{return res.status(400).json({error:'订单数据格式错误'});}
  if(Buffer.byteLength(JSON.stringify(body))>4*1024*1024)return res.status(413).json({error:'订单资料过大，请压缩图片后重试'});
  const order=body.order||{};
  if(!/^[\w-]{1,100}$/.test(order.id||''))return res.status(422).json({error:'订单号无效'});
  if(!emailValid(order.customerEmail))return res.status(422).json({error:'请填写有效的订单通知邮箱'});
  if(order.payMethod!=='FPS'||!['awaiting_manual_review'].includes(order.paymentStatus))return res.status(409).json({error:'FPS 订单状态无效'});
  if(!Array.isArray(order.items)||!order.items.length||order.items.length>20)return res.status(422).json({error:'狗牌数量无效'});
  if(!text(order.shipName)||!text(order.shipPhone)||!text(order.shipAddress,600))return res.status(422).json({error:'请填写完整快递资料'});
  if(!process.env.SMTP_APP_PASSWORD)return res.status(503).json({error:'邮件服务尚未配置完整'});
  try{
    const proof=imageAttachment(body.proof,'FPS付款截图-'+order.id),previews=pngAttachments(body.previews||[]),production=pngAttachments(body.attachments||[]);
    if(!previews.length||!production.length)return res.status(422).json({error:'订单生产图片不完整'});
    const merchantEmail=process.env.MERCHANT_EMAIL||GMAIL_ADDRESS;if(!emailValid(merchantEmail))return res.status(503).json({error:'商户邮箱尚未配置'});
    const profileUrl=safeUrl(order.cloudProfile&&order.cloudProfile.publicUrl),pricing=order.pricing||{},amount=Number(pricing.total||0);
    const orderLines=order.items.map((item,index)=>`${index+1}. ${text(item.petName||'Lucky')}｜${text(item.breedName||item.selectedBreedKey||'宠物狗牌')}｜${text(item.baseLabel||item.baseVariant||'')}`).join('\n');
    const merchantHtml=`<h2>FPS 付款待人工核对</h2><p><b>请先在中银账户确认实际到账，再开始制作。</b></p><p>订单号：${escape(order.id)}<br>应付金额：HK$${amount.toFixed(2)}<br>客户邮箱：${escape(order.customerEmail)}<br>收货人：${escape(text(order.shipName))}<br>联系电话：${escape(text(order.shipPhone))}<br>地址：${escape(text(order.shipAddress,600))}</p><pre>${escape(orderLines)}</pre>${profileUrl?`<p>NFC 档案：<a href="${escape(profileUrl)}">${escape(profileUrl)}</a></p>`:''}<p>第一份附件是客户提交的付款截图，其余附件为预览图和生产文件。</p>`;
    const customerHtml=`<h2>FPS 订单已提交</h2><p>订单号：${escape(order.id)}</p><p>应付金额：HK$${amount.toFixed(2)}</p><p>我们正在核对银行实际到账。确认后才会开始制作；请保留付款记录。</p>`;
    const identity=createHash('sha256').update(order.id+'|fps|'+order.customerEmail).digest('hex');
    const shared={from:GMAIL_ADDRESS,reply_to:GMAIL_ADDRESS};
    const merchant=await sendEmail({...shared,to:[merchantEmail],subject:'FPS 待核款｜尊八八订单 '+order.id,html:merchantHtml,text:`FPS 付款待核对\n订单号：${order.id}\n应付：HK$${amount.toFixed(2)}\n客户：${order.customerEmail}\n收货人：${text(order.shipName)}\n电话：${text(order.shipPhone)}\n地址：${text(order.shipAddress,600)}\n${orderLines}`,attachments:[proof,...previews,...production]},'tsun-fps-merchant-'+identity);
    const customer=await sendEmail({...shared,to:[order.customerEmail],subject:'尊八八 FPS 订单已提交｜'+order.id,html:customerHtml,text:`FPS 订单已提交\n订单号：${order.id}\n应付金额：HK$${amount.toFixed(2)}\n正在等待商家核实银行到账。`},'tsun-fps-customer-'+identity);
    const ok=merchant.sent&&customer.sent;return res.status(ok?200:502).json({merchantSent:merchant.sent,customerSent:customer.sent,error:ok?undefined:'邮件暂未全部发送，请稍后重试'});
  }catch(error){return res.status(422).json({error:error.message||'FPS 订单资料无效'});}
};
