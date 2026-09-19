// Call only from a trusted backend after checking the payment provider's
// signature and the order's paid amount. Never import this into browser code.
const {createHmac}=require('node:crypto');
module.exports=async function notifyOrder(event){
  const secret=process.env.ORDER_EVENT_SECRET;
  const origin=new URL(process.env.ORDER_SITE_ORIGIN||'https://invalid.example');
  if(!secret||origin.protocol!=='https:'||origin.hostname==='invalid.example')throw new Error('订单邮件回调配置不完整');
  const timestamp=String(Date.now()),body=JSON.stringify(event);
  const signature=createHmac('sha256',secret).update(timestamp+'.'+body).digest('hex');
  const response=await fetch(new URL('/api/order-email',origin),{
    method:'POST',headers:{'Content-Type':'application/json','X-Tsun-Timestamp':timestamp,'X-Tsun-Signature':signature},body,signal:AbortSignal.timeout(50000)
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(result.error||'订单邮件发送失败，需要重试');
  return result;
};
