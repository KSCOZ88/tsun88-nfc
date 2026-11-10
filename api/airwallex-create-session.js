const {configuration,parseBody,createSession,handleError,method}=require('../server/airwallex-checkout');
module.exports=async function(req,res){if(method(req,res))return;
  try{const config=configuration(),body=parseBody(req);return res.status(200).json(await createSession(config,req,body.order));}
  catch(error){return handleError(res,error);}
};
