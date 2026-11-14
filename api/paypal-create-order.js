const p=require('../server/paypal-orders');
module.exports=async(req,res)=>{if(!p.post(req,res))return;try{const body=p.bodyOf(req);return res.status(200).json(await p.create(req,body.order));}catch(err){p.error(res,err);}};
