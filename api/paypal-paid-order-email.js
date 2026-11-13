const p=require('../server/paypal-orders');
const {deliver}=require('../server/airwallex-order-mailer');
const STAGES=new Set(['payment_received','order_completed','in_production','shipped']);
module.exports=async(req,res)=>{
  if(!p.post(req,res))return;
  try{
    const body=p.bodyOf(req),stage=String(body.type||'');
    if(!STAGES.has(stage))return res.status(422).json({error:'通知类型不正确'});
    const order=body.order||{},id=String(order.id||'');
    const {row,sql}=await p.verifiedPaid(id,String(body.paypalOrderId||''),String(body.orderToken||''),order);
    if(!process.env.SMTP_APP_PASSWORD)return res.status(503).json({error:'邮件服务尚未设置'});
    await sql`INSERT INTO tsun_paypal_mail(merchant_order_id,stage) VALUES (${id},${stage}) ON CONFLICT DO NOTHING`;
    const claimed=await sql`UPDATE tsun_paypal_mail SET processing_until=now()+interval '4 minutes'
      WHERE merchant_order_id=${id} AND stage=${stage}
      AND (processing_until IS NULL OR processing_until<now())
      AND (customer_sent=false OR (stage='order_completed' AND merchant_sent=false))
      RETURNING customer_sent,merchant_sent`;
    if(!claimed.length){
      const [previous]=await sql`SELECT customer_sent,merchant_sent,processing_until FROM tsun_paypal_mail WHERE merchant_order_id=${id} AND stage=${stage}`;
      return res.status(200).json({customerSent:!!previous?.customer_sent,merchantSent:!!previous?.merchant_sent,alreadyHandled:true});
    }
    const state=claimed[0];
    try{
      const mailOrder={...order,payMethod:'PayPal',paymentStatus:'paid',paymentTransactionId:row.capture_id,paidAmountCents:row.amount_cents};
      const result=await deliver(stage,mailOrder,body.previews||[],body.attachments||[],{skipCustomer:state.customer_sent,skipMerchant:state.merchant_sent});
      const customerDone=!!(state.customer_sent||result.customerSent);
      const merchantDone=!!(state.merchant_sent||result.merchantSent||stage!=='order_completed');
      await sql`UPDATE tsun_paypal_mail SET customer_sent=${customerDone}, merchant_sent=${merchantDone}, processing_until=NULL WHERE merchant_order_id=${id} AND stage=${stage}`;
      return res.status(customerDone&&merchantDone?200:502).json({customerSent:customerDone,merchantSent:merchantDone,error:customerDone&&merchantDone?undefined:'邮件未全部发送，可稍后重试'});
    }catch(err){await sql`UPDATE tsun_paypal_mail SET processing_until=NULL WHERE merchant_order_id=${id} AND stage=${stage}`;throw err;}
  }catch(err){p.error(res,err);}
};
