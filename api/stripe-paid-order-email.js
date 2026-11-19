const stripe=require('../server/stripe-orders');
const {deliver}=require('../server/airwallex-order-mailer');
const STAGES=new Set(['payment_received','order_completed','in_production','shipped']);

module.exports=async function(req,res){
  if(!stripe.post(req,res))return;
  try{
    const body=stripe.parseBody(req);
    const stage=String(body.type||'');
    if(!STAGES.has(stage))return res.status(422).json({error:'邮件状态无效。'});
    const sessionId=String(body.sessionId||body.stripeSessionId||'');
    const verified=await stripe.verifiedPaid(
      String(body.order?.id||''),
      sessionId,
      String(body.orderToken||''),
      body.order||{}
    );
    const row=verified.row,order=body.order||{};
    order.paymentStatus='paid';
    order.payMethod='Stripe';
    order.paymentTransactionId=row.stripe_payment_intent_id;
    order.paidAmountCents=Number(row.amount_cents);
    if(!process.env.SMTP_APP_PASSWORD)return res.status(503).json({error:'Gmail 发信授权尚未配置。'});
    if(stage==='payment_received'){
      const receipt=await stripe.sendReceipt(verified.sql,row);
      return res.status(receipt.complete?200:502).json({
        customerSent:receipt.customerSent,merchantSent:receipt.merchantSent,
        alreadyHandled:!!receipt.alreadyHandled,
        error:receipt.complete?undefined:'付款确认邮件尚未全部发送，请稍后重试。'
      });
    }
    if(stage==='order_completed'&&!order.cloudProfile?.publicUrl)return res.status(422).json({error:'宠物档案网址尚未生成。'});
    await verified.sql`INSERT INTO tsun_stripe_mail (merchant_order_id,stage)
      VALUES (${row.merchant_order_id},${stage}) ON CONFLICT DO NOTHING`;
    const [claimed]=await verified.sql`UPDATE tsun_stripe_mail
      SET processing_until=now()+interval '4 minutes'
      WHERE merchant_order_id=${row.merchant_order_id} AND stage=${stage}
        AND (processing_until IS NULL OR processing_until<now())
        AND (customer_sent=false OR (stage='order_completed' AND merchant_sent=false))
      RETURNING customer_sent,merchant_sent`;
    if(!claimed){
      const [previous]=await verified.sql`SELECT customer_sent,merchant_sent FROM tsun_stripe_mail
        WHERE merchant_order_id=${row.merchant_order_id} AND stage=${stage}`;
      const customerSent=!!previous?.customer_sent,merchantSent=!!previous?.merchant_sent;
      return res.status(200).json({
        customerSent,merchantSent,alreadyHandled:true,
        pending:!customerSent||(stage==='order_completed'&&!merchantSent)
      });
    }
    try{
      const result=await deliver(stage,order,body.previews||[],body.attachments||[],{
        skipCustomer:!!claimed.customer_sent,skipMerchant:!!claimed.merchant_sent
      });
      const customerSent=!!(claimed.customer_sent||result.customerSent);
      const merchantSent=!!(claimed.merchant_sent||result.merchantSent||stage!=='order_completed');
      await verified.sql`UPDATE tsun_stripe_mail
        SET customer_sent=${customerSent},merchant_sent=${merchantSent},processing_until=NULL
        WHERE merchant_order_id=${row.merchant_order_id} AND stage=${stage}`;
      const complete=customerSent&&(stage!=='order_completed'||merchantSent);
      return res.status(complete?200:502).json({
        customerSent,merchantSent,
        error:complete?undefined:'邮件未全部发送，请稍后重试。'
      });
    }catch(error){
      await verified.sql`UPDATE tsun_stripe_mail SET processing_until=NULL
        WHERE merchant_order_id=${row.merchant_order_id} AND stage=${stage}`;
      throw error;
    }
  }catch(error){return stripe.handleError(res,error);}
};
