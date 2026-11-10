const {createHash}=require('node:crypto');
const {render,escape,safeUrl}=require('./email-template');
const {sendGmail,GMAIL_ADDRESS}=require('./gmail-mailer');
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

module.exports={deliver};
