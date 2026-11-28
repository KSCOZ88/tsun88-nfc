'use strict';

const {randomUUID}=require('node:crypto');
const {db}=require('./airwallex-order-store');
const {configuration,summary,verifyToken}=require('./airwallex-checkout');
const {verify}=require('./airwallex-payment-verification');
const {deliver}=require('./airwallex-order-mailer');
let schemaPromise;

function failure(status,code){
 return Object.assign(new Error(code),{status,code});
}

async function mailDatabase(){
 const sql=db();
 schemaPromise||=sql.transaction([
  sql`CREATE TABLE IF NOT EXISTS tsun_airwallex_mail (
   merchant_order_id TEXT NOT NULL, payment_link_id TEXT NOT NULL, stage TEXT NOT NULL,
   customer_sent BOOLEAN NOT NULL DEFAULT false, merchant_sent BOOLEAN NOT NULL DEFAULT false,
   processing_until TIMESTAMPTZ, PRIMARY KEY (merchant_order_id,stage)
  )`,
  sql`ALTER TABLE tsun_airwallex_mail ADD COLUMN IF NOT EXISTS production_payload JSONB`
 ]).catch(error=>{schemaPromise=null;throw error;});
 await schemaPromise;
 return sql;
}

function productionPayload(order,attachments){
 if(!Array.isArray(order?.items)||!order.items.length||!Array.isArray(attachments)||attachments.length!==order.items.length*3||
    !attachments.every(file=>typeof file?.data==='string'&&/^data:image\/png;base64,iVBORw0KGg[A-Za-z0-9+/]+={0,2}$/.test(file.data))||
    ![order.shipName,order.shipPhone,order.shipAddress,order.cloudProfile?.publicUrl].every(value=>typeof value==='string'&&value.trim())){
  return null;
 }
 const {id,customerEmail,paidAmountCents,language,shipName,shipPhone,shipAddress}=order;
 return {
  order:{id,customerEmail,paidAmountCents,language,shipName,shipPhone,shipAddress,
   items:order.items.map(({petName})=>({petName})),
   cloudProfile:{publicUrl:order.cloudProfile.publicUrl}},
  attachments:attachments.map(({name,data})=>({name,data}))
 };
}

async function resendProductionMail(id,legacy,profileUrl){
 const sql=await mailDatabase();
 const [row]=await sql`SELECT payment_link_id, production_payload IS NOT NULL AS ready
  FROM tsun_airwallex_mail WHERE merchant_order_id=${id} AND stage='order_completed'`;
 let recovered=null;
 if(!row?.ready){
  if(!legacy)throw failure(409,'production_assets_missing');
  const {order,attachments}=legacy;
  const link=order?.airwallexSessionId;
  if(order?.id!==id||!profileUrl||(row&&row.payment_link_id!==link))
   throw failure(422,'invalid_production_order');
  const config=configuration();
  const details=summary(order);
  if(!verifyToken(config,order.airwallexOrderToken||'',link,details))
   throw failure(422,'invalid_production_order');
  await verify(link,order);
  recovered=productionPayload({...order,paidAmountCents:details.totalCents,cloudProfile:{publicUrl:profileUrl}},attachments);
  if(!recovered||Buffer.byteLength(JSON.stringify(recovered))>4*1024*1024)
   throw failure(422,'invalid_production_assets');
  await sql`INSERT INTO tsun_airwallex_mail (merchant_order_id,payment_link_id,stage,production_payload)
   VALUES (${id},${link},'order_completed',${JSON.stringify(recovered)}::jsonb) ON CONFLICT DO NOTHING`;
 }
 const [claim]=await sql`UPDATE tsun_airwallex_mail
  SET processing_until=now()+interval '4 minutes',
      production_payload=coalesce(production_payload,${recovered?JSON.stringify(recovered):null}::jsonb)
  WHERE merchant_order_id=${id} AND stage='order_completed'
  AND (${recovered===null} OR payment_link_id=${legacy?.order?.airwallexSessionId||''})
  AND (processing_until IS NULL OR processing_until<now())
  RETURNING production_payload,processing_until::text AS lease,merchant_sent`;
 if(!claim)throw failure(409,'production_mail_busy');
 let sent=false;
 try{
  const {order,attachments}=claim.production_payload;
  const result=await deliver('order_completed',order,[],attachments,{
   merchantOnly:true, merchantAttempt:claim.merchant_sent?randomUUID():undefined
  });
  sent=result.merchantSent;
 }finally{
  await sql`UPDATE tsun_airwallex_mail SET merchant_sent=merchant_sent OR ${sent},processing_until=NULL
   WHERE merchant_order_id=${id} AND stage='order_completed' AND processing_until=${claim.lease}::timestamptz`;
 }
 return {notificationStatus:sent?'sent':'pending'};
}

module.exports={mailDatabase,productionPayload,resendProductionMail};
