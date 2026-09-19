const {cors}=require('../server/stripe-orders');
const emailValid=value=>typeof value==='string'&&value.length<=254&&/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
function returnBase(req){
  for(const value of [process.env.TSUN88_SITE_URL,req.headers.origin]){try{const url=new URL(value);if(url.protocol==='https:'||url.hostname==='localhost')return url.href.replace(/\/$/,'');}catch{}}
  return 'https://tsun88-nfc-l86b.vercel.app';
}
module.exports=async function handler(req,res){
  cors(req,res);if(req.method==='OPTIONS')return res.status(204).end();if(req.method!=='POST')return res.status(405).json({error:'仅支持 POST 请求'});
  try{
    const key=process.env.STRIPE_SECRET_KEY||'';if(!/^sk_(test|live)_/.test(key))return res.status(503).json({error:'Stripe 密钥尚未配置'});
    const body=typeof req.body==='string'?JSON.parse(req.body):req.body||{},orderId=String(body.orderId||''),customerEmail=String(body.customerEmail||'').trim();
    const itemCount=Number(body.itemCount),decorCount=Number(body.decorCount);
    if(!/^[\w-]{1,100}$/.test(orderId))return res.status(422).json({error:'订单号无效'});if(!emailValid(customerEmail))return res.status(422).json({error:'请填写有效邮箱'});
    if(!Number.isInteger(itemCount)||itemCount<1||itemCount>20||!Number.isInteger(decorCount)||decorCount<0||decorCount>240)return res.status(422).json({error:'商品数量无效'});
    const base=returnBase(req),success=base+'/?payment=success&session_id={CHECKOUT_SESSION_ID}&order_id='+encodeURIComponent(orderId),cancel=base+'/?payment=cancelled&order_id='+encodeURIComponent(orderId);
    const form=new URLSearchParams({mode:'payment',success_url:success,cancel_url:cancel,customer_email:customerEmail,client_reference_id:orderId,locale:'auto','metadata[order_id]':orderId,'metadata[item_count]':String(itemCount),'metadata[decor_count]':String(decorCount)});
    form.set('line_items[0][quantity]',String(itemCount));form.set('line_items[0][price_data][currency]','hkd');form.set('line_items[0][price_data][unit_amount]','29900');form.set('line_items[0][price_data][product_data][name]','尊八八 NFC 宠物狗牌');
    if(decorCount){form.set('line_items[1][quantity]',String(decorCount));form.set('line_items[1][price_data][currency]','hkd');form.set('line_items[1][price_data][unit_amount]','300');form.set('line_items[1][price_data][product_data][name]','狗牌小装饰');}
    const response=await fetch('https://api.stripe.com/v1/checkout/sessions',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/x-www-form-urlencoded'},body:form});
    const session=await response.json().catch(()=>({}));if(!response.ok)return res.status(502).json({error:session.error?.message||'Stripe 暂时无法创建付款'});return res.status(200).json({id:session.id,url:session.url});
  }catch(error){return res.status(500).json({error:error.message||'创建付款失败'});}
};
