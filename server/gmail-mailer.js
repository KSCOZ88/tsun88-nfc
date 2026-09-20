const nodemailer=require('nodemailer');
const GMAIL_ADDRESS='tsunlab888@gmail.com';
let transport;
async function sendGmail(mail,eventId){
  const password=(process.env.SMTP_APP_PASSWORD||'').replace(/\s/g,'');
  if(!password)return {sent:false,error:'Gmail 发信授权尚未配置'};
  if(!transport)transport=nodemailer.createTransport({
    host:'smtp.gmail.com',port:465,secure:true,
    auth:{user:GMAIL_ADDRESS,pass:password},
    connectionTimeout:10000,greetingTimeout:10000,socketTimeout:20000
  });
  try{
    const result=await transport.sendMail({
      from:{name:'尊八八 TSUN88',address:GMAIL_ADDRESS},
      to:mail.to,replyTo:GMAIL_ADDRESS,subject:mail.subject,html:mail.html,text:mail.text,
      // Stable Message-ID is useful for tracing. SMTP has no idempotency API;
      // the trusted order backend must persist delivery IDs before retrying.
      messageId:'<'+eventId+'@gmail.com>',
      attachments:(mail.attachments||[]).map(file=>({
        filename:file.filename,content:Buffer.from(file.content,'base64'),
        contentType:file.content_type||'image/png',...(file.content_id?{cid:file.content_id}:{})
      }))
    });
    const accepted=(result.accepted||[]).map(address=>String(address).toLowerCase());
    if(!mail.to.every(address=>accepted.includes(address.toLowerCase())))return {sent:false,error:'部分收件地址未被邮件服务接受'};
    return {sent:true,id:result.messageId};
  }catch{return {sent:false,error:'Gmail 暂未接受邮件，请由后台重试'};}
}
module.exports={sendGmail,GMAIL_ADDRESS};
