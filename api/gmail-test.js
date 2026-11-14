
const {randomUUID,timingSafeEqual}=require('node:crypto');
const {sendGmail}=require('../server/gmail-mailer');

module.exports=async(req,res)=>{
  res.setHeader('Cache-Control','no-store');

  if(process.env.VERCEL_ENV!=='preview'){
    return res.status(404).json({error:'Not found'});
  }

  if(req.method!=='POST'){
    return res.status(405).json({error:'POST only'});
  }

  const secret=process.env.MAIL_TEST_TOKEN;
  const supplied=req.headers['x-test-token']||'';

  if(!secret||typeof supplied!=='string'){
    return res.status(403).json({error:'Forbidden'});
  }

  const a=Buffer.from(secret);
  const b=Buffer.from(supplied);

  if(a.length!==b.length||!timingSafeEqual(a,b)){
    return res.status(403).json({error:'Forbidden'});
  }

  const result=await sendGmail({
    to:['tsunlab888@gmail.com'],
    subject:'8TSUN8 Gmail SMTP Test',
    text:'8TSUN8 Preview email test successful.',
    html:'<p>8TSUN8 Preview email test successful.</p>'
  },'smtp-test-'+randomUUID());

  return res.status(result.sent?200:502).json({
    sent:!!result.sent,
    error:result.sent?undefined:result.error
  });
};
