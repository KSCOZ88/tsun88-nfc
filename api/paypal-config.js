const {configuration,methods}=require('../server/paypal-orders');
module.exports=async function handler(req,res){
  if(methods(req,res,'GET'))return;
  const config=configuration();if(!config)return res.status(503).json({available:false});
  return res.status(200).json({available:true,mode:config.mode,clientId:config.clientId,currency:'HKD'});
};
