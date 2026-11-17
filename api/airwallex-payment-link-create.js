const {parseBody,method,handleError}=require('../server/airwallex-checkout');
const {create}=require('../server/airwallex-payment-links');
module.exports=async(req,res)=>{if(method(req,res))return;try{const body=parseBody(req);return res.status(200).json(await create(body.order));}catch(error){return handleError(res,error);}};
