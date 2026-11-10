const {configuration,parseBody,verifiedSession,makeToken,handleError,method}=require('../server/airwallex-checkout');
module.exports=async function(req,res){if(method(req,res))return;
  try{const config=configuration(),body=parseBody(req),{session,summary}=await verifiedSession(config,String(body.sessionId||''),body.order||{});
    return res.status(200).json({paid:true,sessionId:session.id,paymentIntentId:session.payment_intent_id,orderToken:makeToken(config,session.id,summary),amountTotal:summary.totalCents,currency:'hkd',mode:config.mode});
  }catch(error){return handleError(res,error);}
};
