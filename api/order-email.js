const {createHmac,timingSafeEqual,createHash}=require('node:crypto');
const {render,escape,safeUrl}=require('../server/email-template');
const {sendGmail:sendEmail,GMAIL_ADDRESS}=require('../server/gmail-mailer');
const STAGES=new Set(['payment_received','order_completed','in_production','shipped']);
const emailValid=value=>typeof value==='string'&&value.length<=254&&/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
function verifiedServerRequest(req,body){
  const secret=process.env.ORDER_EVENT_SECRET||'';
  const stamp=String(req.headers['x-tsun-timestamp']||'');
  const signature=String(req.headers['x-tsun-signature']||'');
  if(!secret||!/^\d+$/.test(stamp)||Math.abs(Date.now()-Number(stamp))>300000||!/^[a-f0-9]{64}$/.test(signature))return false;
  const expected=createHmac('sha256',secret).update(stamp+'.'+JSON.stringify(body)).digest();
  return timingSafeEqual(expected,Buffer.from(signature,'hex'));
}
function pngAttachments(list,inline=false){
  if(!Array.isArray(list)||list.length>40)throw new Error('订单图片数量不正确');
  return list.map((item,index)=>{
    const data=String(item.data||'');
    if(!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data))throw new Error('订单图片必须为 PNG');
    const content=data.slice(data.indexOf(',')+1);
    if(!Buffer.from(content,'base64').subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('PNG 图片内容无效');
    const filename=String(item.name||('狗牌-'+index+'.png')).replace(/[\r\n/\\]/g,'-').slice(0,120);
    return {filename,content,content_type:'image/png',...(inline?{content_id:'tag-preview-'+index}:{})};
  });
}
module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST')return res.status(405).json({error:'仅支持 POST 请求'});
  let body;
  try{body=typeof req.body==='string'?JSON.parse(req.body):req.body||{};}catch{return res.status(400).json({error:'订单数据格式错误'});}
  if(!body||typeof body!=='object'||Array.isArray(body))return res.status(400).json({error:'订单数据格式错误'});
  if(Buffer.byteLength(JSON.stringify(body))>4*1024*1024)return res.status(413).json({error:'订单图片过大，请压缩后重试'});
  if(!STAGES.has(body.type))return res.status(400).json({error:'未知订单通知类型'});
  const order=body.order||{};
  if(!emailValid(order.customerEmail))return res.status(422).json({error:'请填写有效的订单通知邮箱'});
  // A browser demo action must never send a paid receipt.
  if(body.demo===true)return res.status(200).json({demo:true,customerSent:false,merchantSent:false,message:'演示订单未发送邮件'});
  if(!verifiedServerRequest(req,body))return res.status(401).json({error:'发送邮件需要经后台验证的订单事件'});
  if(order.paymentStatus!=='paid'||!order.paymentTransactionId||!order.paidAt)return res.status(409).json({error:'订单付款尚未由支付平台确认'});
  if(!/^[\w-]{1,100}$/.test(order.id||''))return res.status(422).json({error:'订单号无效'});
  if(!Array.isArray(order.items)||!order.items.length||order.items.length>20)return res.status(422).json({error:'狗牌数量无效'});
  if(order.items.some(item=>!item||['front','back'].some(side=>!Array.isArray(item.decorItems?.[side])||item.decorItems[side].length>6)))return res.status(422).json({error:'配饰数量无效'});
  if(!process.env.SMTP_APP_PASSWORD)return res.status(503).json({error:'邮件服务尚未配置完整'});
  if(body.type==='order_completed'&&!safeUrl(order.cloudProfile?.publicUrl))return res.status(422).json({error:'宠物档案网址尚未生成'});
  if(body.type==='shipped'&&(!order.shippingCarrier||!order.trackingNumber))return res.status(422).json({error:'寄出通知需要快递公司和单号'});
  try{
    const previewFiles=pngAttachments(body.previews||[],true);
    if(!previewFiles.length)return res.status(422).json({error:'订单缺少狗牌效果图'});
    const merchantEmail=process.env.MERCHANT_EMAIL||GMAIL_ADDRESS;
    const files=body.type==='order_completed'?pngAttachments(body.attachments||[]):[];
    if(body.type==='order_completed'&&(!files.length||!emailValid(merchantEmail)))return res.status(422).json({error:'商户邮箱或生产文件不完整'});
    const message=render(order,body.type,previewFiles.map((file,index)=>({src:'cid:'+file.content_id,label:body.previews[index].label})));
    if(order.paidAmountCents!==Math.round(message.total*100))return res.status(409).json({error:'支付平台实收金额与订单不一致'});
    const identity=createHash('sha256').update(order.id+'|'+body.type+'|'+order.customerEmail).digest('hex');
    const shared={from:GMAIL_ADDRESS,reply_to:GMAIL_ADDRESS};
    const customer=await sendEmail({...shared,to:[order.customerEmail],subject:message.subject,html:message.html,text:message.text,attachments:previewFiles},'tsun-customer-'+identity);
    let merchant={sent:false,skipped:true};
    if(body.type==='order_completed'){
      merchant=await sendEmail({...shared,to:[merchantEmail],subject:'尊八八制作订单｜'+order.id,
        html:`<h2>已付款，资料已收齐</h2><p>订单号：${escape(order.id)}<br>客户邮箱：${escape(order.customerEmail)}<br>金额：HK$${message.total.toFixed(2)}<br>收货人：${escape(order.shipName)}<br>联系电话：${escape(order.shipPhone)}<br>地址：${escape(order.shipAddress)}</p><p>NFC 档案：<a href="${escape(safeUrl(order.cloudProfile?.publicUrl))}">${escape(safeUrl(order.cloudProfile?.publicUrl))}</a></p><p>请将档案网址写入 NFC；生产图片见附件。</p>`,attachments:files},'tsun-merchant-'+identity);
    }
    const ok=customer.sent&&(merchant.skipped||merchant.sent);
    return res.status(ok?200:502).json({customerSent:customer.sent,merchantSent:merchant.sent,customer,merchant,error:ok?undefined:'邮件暂未全部发送，请由后台重试'});
  }catch(error){return res.status(502).json({error:'订单邮件暂未发送，请由后台重试'});}
};
