const {cors,stripeSession,stripeSessionForOrder,verifyPaidSession,orderToken}=require('../server/stripe-orders');
module.exports=async function handler(req,res){
  cors(req,res);if(req.method==='OPTIONS')return res.status(204).end();if(req.method!=='POST')return res.status(405).json({error:'仅支持 POST 请求'});
  try{
    const body=typeof req.body==='string'?JSON.parse(req.body):req.body||{};if(Buffer.byteLength(JSON.stringify(body))>5*1024*1024)return res.status(413).json({error:'订单图片过大'});
    const order=body.order||{},sessionId=String(body.sessionId||'');
    const session=sessionId?await stripeSession(sessionId):await stripeSessionForOrder(order);const expected=verifyPaidSession(session,order);
    order.paymentStatus='paid';order.payMethod='Stripe';order.paymentTransactionId=String(session.payment_intent||session.id);order.paidAmountCents=session.amount_total;order.paidAt=new Date((session.created||Math.floor(Date.now()/1000))*1000).toISOString();
    // Payment verification must return immediately. Email rendering and Gmail
    // delivery run separately so they can never block the shipping/profile page.
    return res.status(200).json({paid:true,sessionId:session.id,amountTotal:expected.totalCents,currency:'hkd',paymentIntentId:order.paymentTransactionId,orderToken:orderToken(session,order),mailSent:false});
  }catch(error){return res.status(422).json({paid:false,error:error.message||'付款确认失败'});}
};
