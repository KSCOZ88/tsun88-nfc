'use strict';
const {createHash,timingSafeEqual}=require('node:crypto');
const {neon}=require('@neondatabase/serverless');

const hash=value=>createHash('sha256').update(value).digest();
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

module.exports=async function(req,res){
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('X-Robots-Tag','noindex, nofollow');
  res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
  if(req.method!=='GET')return res.status(405).end();
  const password=process.env.PRODUCTION_ADMIN_PASSWORD;
  if(!password||password.length<32||!process.env.DATABASE_URL)return res.status(503).end();
  const expected='Basic '+Buffer.from('admin:'+password,'utf8').toString('base64');
  if(!timingSafeEqual(hash(String(req.headers.authorization||'')),hash(expected))){
    res.setHeader('WWW-Authenticate','Basic realm="8TSUN8 Production", charset="UTF-8"');
    return res.status(401).end();
  }

  try{
    const sql=neon(process.env.DATABASE_URL);
    const [table]=await sql`SELECT to_regclass('tsun_production_jobs') AS name`;
    const jobs=table.name?await sql`SELECT merchant_order_id,payment_provider,status,created_at
      FROM tsun_production_jobs ORDER BY created_at DESC,merchant_order_id DESC LIMIT 100`:[];
    const rows=jobs.map(job=>{
      const time=new Date(job.created_at).toLocaleString('zh-HK',{timeZone:'Asia/Hong_Kong',hour12:false});
      const status=job.status==='awaiting_assets'?'等待生产资料':job.status;
      return '<tr>'+[job.merchant_order_id,job.payment_provider,'已付款',status,time].map(value=>'<td>'+escape(value)+'</td>').join('')+'</tr>';
    }).join('');
    res.setHeader('Content-Type','text/html; charset=utf-8');
    return res.status(200).send(`<!doctype html><html lang="zh-Hans"><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1"><title>8TSUN8 生产队列</title>
      <style>body{max-width:64rem;margin:3rem auto;padding:0 1rem;font:16px system-ui;color:#182b3c;background:#f6f8fb}main{overflow:auto}table{border-collapse:collapse;width:100%;background:white}th,td{padding:.8rem;text-align:left;border-bottom:1px solid #dce4ec}th{white-space:nowrap}</style>
      <h1>8TSUN8 生产队列</h1><p>最近 100 条已付款生产任务 · 香港时间</p><main><table>
      <thead><tr><th>订单号</th><th>付款渠道</th><th>付款状态</th><th>生产状态</th><th>入队时间</th></tr></thead>
      <tbody>${rows||'<tr><td colspan="5">暂无生产任务</td></tr>'}</tbody></table></main></html>`);
  }catch{
    return res.status(503).send('暂时无法读取生产队列');
  }
};
