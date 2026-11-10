// Retired legacy payment endpoint. Only Airwallex corporate checkout is supported.
module.exports=function(req,res){res.setHeader('Cache-Control','no-store');return res.status(410).json({error:'付款方式已停用，请通过 Airwallex 企业收款页面结账。'});};
