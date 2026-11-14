const p=require('../server/paypal-orders');
module.exports=async(req,res)=>{if(!p.post(req,res))return;try{const body=p.bodyOf(req);return res.status(200).json(await p.capture(String(body.orderId||''),String(body.paypalOrderId||'')));}catch(err){p.error(res,err);}};
