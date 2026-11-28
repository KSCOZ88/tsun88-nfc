const {createHash}=require('node:crypto');
const {render,renderMerchant,safeUrl}=require('./email-template');
const {sendGmail,GMAIL_ADDRESS}=require('./gmail-mailer');
const {shippingLabelAttachment,shippingLabelPrintTip}=require('./shipping-label');
const {combinePrintSides}=require('./print-layout');
function pngAttachments(list,inline=false){
  if(!Array.isArray(list)||list.length>60)throw new Error('订单图片数量不正确');
  return list.map((item,index)=>{const data=String(item.data||'');if(!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data))throw new Error('订单图片必须为 PNG');const content=data.slice(data.indexOf(',')+1);if(!Buffer.from(content,'base64').subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('PNG 图片内容无效');const filename=String(item.name||('狗牌-'+index+'.png')).replace(/[\r\n/\\]/g,'-').slice(0,120);return {filename,content,content_type:'image/png',...(inline?{content_id:'tag-preview-'+index}:{})};});
}
async function sendMerchantProduction(order,attachments,eventId){
  let step='print images';
  try{
    const layers=pngAttachments(attachments);
    if(!order.items?.length||layers.length!==order.items.length*3)throw new Error('生产文件不完整');
    const files=[];
    for(let i=0;i<layers.length;i+=3){
      // Each tag is uploaded as front plate, portrait, then back plate.
      const [front,dog,back]=layers.slice(i,i+3);
      const combined=combinePrintSides(Buffer.from(front.content,'base64'),Buffer.from(back.content,'base64'));
      files.push(front,back,dog,{
        filename:front.filename.replace(/(?:-01-[^.]+)?\.png$/i,'')+'-04-正反面並排.png',
        content:combined.toString('base64'),content_type:'image/png'
      });
    }
    step='shipping label';
    if(![order.shipName,order.shipPhone,order.shipAddress,safeUrl(order.cloudProfile?.publicUrl)]
      .every(value=>typeof value==='string'&&value.trim()))throw new Error('配送资料或宠物档案不完整');
    const addressLabel=await shippingLabelAttachment(order,{threeAcross:true});
    if(!addressLabel)throw new Error('配送资料不完整');
    step='SMTP';
    const message=renderMerchant(order);
    return await sendGmail({
      to:[process.env.MERCHANT_EMAIL||GMAIL_ADDRESS],
      subject:message.subject,html:message.html+shippingLabelPrintTip,attachments:[...files,addressLabel]
    },eventId);
  }catch(error){
    const code=String(error?.code||'');
    console.error('[Merchant production email] preparation failed',{step,code:/^[a-z0-9_-]{1,40}$/i.test(code)?code:'unknown'});
    return {sent:false};
  }
}
async function deliver(stage,order,previews,attachments=[],options={}){
  if(!process.env.SMTP_APP_PASSWORD)return {customerSent:false,merchantSent:false,error:'Gmail 发信授权尚未配置'};
  if(stage==='order_completed'&&!safeUrl(order.cloudProfile?.publicUrl))throw new Error('宠物档案网址尚未生成');
  const identity=createHash('sha256').update(order.id+'|'+stage+'|'+order.customerEmail).digest('hex');
  const shared={from:GMAIL_ADDRESS,reply_to:GMAIL_ADDRESS};
  let customer={sent:Boolean(options.skipCustomer),skipped:true};
  if(!options.skipCustomer&&!options.merchantOnly){
    const previewFiles=pngAttachments(previews,true);
    if(!previewFiles.length)throw new Error('订单缺少狗牌效果图');
    const message=render(order,stage,previewFiles.map((file,index)=>({src:'cid:'+file.content_id,label:previews[index].label})));
    customer=await sendGmail({...shared,to:[order.customerEmail],subject:message.subject,html:message.html,text:message.text,attachments:previewFiles},'tsun-customer-'+identity);
  }
  let merchant={sent:false,skipped:true};
  if(stage==='order_completed'&&options.skipMerchant){merchant={sent:true,skipped:true};}
  else if(stage==='order_completed'){
    merchant=await sendMerchantProduction(order,attachments,'tsun-merchant-'+identity+(options.merchantAttempt?'-'+options.merchantAttempt:''));
  }
  return {customerSent:customer.sent,merchantSent:merchant.sent,customer,merchant};
}

module.exports={deliver,sendMerchantProduction};
