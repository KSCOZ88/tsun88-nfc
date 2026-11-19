const stripe=require('../server/stripe-orders');
module.exports=async function(req,res){
  if(!stripe.post(req,res))return;
  try{
    const body=stripe.parseBody(req);
    const result=await stripe.create(req,body.order);
    return res.status(200).json(result);
  }catch(error){return stripe.handleError(res,error);}
};
