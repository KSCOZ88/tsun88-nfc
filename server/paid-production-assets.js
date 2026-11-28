'use strict';

const {db}=require('./airwallex-order-store');
const {mailDatabase,productionPayload}=require('./airwallex-production-mail');
const {combinePrintSides}=require('./print-layout');

const paymentSources={
  airwallex:{table:'tsun_airwallex_orders',status:'status'},
  stripe:{table:'tsun_stripe_orders',status:'status'},
  paypal:{table:'tsun_paypal_orders',status:'payment_status'}
};
const layerIndex={print_front:0,print_dog:1,print_back:2};
const designFields=['petName','ownerName','ownerPhone','ownerCountry','ownerPhoneInput','contactFont',
  'baseVariant','faceKey','selectedBreedKey','selectedBreedColor','decorItems'];
const fail=(code,status=422)=>Object.assign(new Error(code),{status,code});
let schema;
async function assetsDb(){
  const sql=db();
  schema||=sql`CREATE TABLE IF NOT EXISTS tsun_paid_production_assets (
    merchant_order_id TEXT NOT NULL,
    payment_provider TEXT NOT NULL CHECK (payment_provider IN ('stripe','paypal')),
    production_payload JSONB NOT NULL,
    PRIMARY KEY(merchant_order_id,payment_provider)
  )`.catch(error=>{schema=null;throw error;});
  await schema;
  return sql;
}

function deliveryFields(order={}){
  const {customerEmail,shipName,shipPhone,shipAddress}=order;
  return {customerEmail,shipName,shipPhone,shipAddress};
}

async function savePaidProduction(provider,order,attachments,airwallexId){
  const payload=productionPayload(order,attachments);
  if(!payload)throw fail('invalid_production_assets');
  if(provider==='airwallex'){
    const sql=await mailDatabase();
    const [saved]=await sql`INSERT INTO tsun_airwallex_mail (merchant_order_id,payment_link_id,stage,production_payload)
      VALUES (${order.id},${airwallexId},'order_completed',${JSON.stringify(payload)}::jsonb)
      ON CONFLICT (merchant_order_id,stage) DO UPDATE
        SET production_payload=coalesce(tsun_airwallex_mail.production_payload,excluded.production_payload)
      WHERE tsun_airwallex_mail.payment_link_id=excluded.payment_link_id
      RETURNING merchant_order_id`;
    if(!saved)throw fail('invalid_production_order',409);
    return;
  }
  if(provider!=='stripe'&&provider!=='paypal')throw fail('invalid_production_order');
  const sql=await assetsDb();
  await sql`INSERT INTO tsun_paid_production_assets (merchant_order_id,payment_provider,production_payload)
    VALUES (${order.id},${provider},${JSON.stringify(payload)}::jsonb) ON CONFLICT DO NOTHING`;
}

async function assetRow(provider,id,first=null,second=null){
  if(!Object.hasOwn(paymentSources,provider))throw fail('order_missing',404);
  const airwallex=provider==='airwallex';
  const sql=airwallex?await mailDatabase():await assetsDb();
  const table=airwallex?'tsun_airwallex_mail':'tsun_paid_production_assets';
  const condition=airwallex?"stage = 'order_completed'":'payment_provider = $4';
  const params=airwallex?[id,first,second]:[id,first,second,provider];
  const [row]=await sql.query(
    `SELECT production_payload->'order' AS details,
      jsonb_array_length(production_payload->'attachments') AS layers,
      production_payload->'attachments'->$2::integer AS first,
      production_payload->'attachments'->$3::integer AS second
     FROM ${table} WHERE merchant_order_id = $1 AND ${condition}`,params);
  return row;
}

async function loadPaidProduction(provider,id,{includeDesigns=false}={}){
  const assets=await assetRow(provider,id);
  if(assets?.details){
    return {delivery:deliveryFields(assets.details),quantity:assets.details.items?.length,
      printCount:Math.floor((assets.layers||0)/3)};
  }
  const {table,status}=paymentSources[provider];
  const [paid]=await db().query(
    `SELECT email, jsonb_array_length(order_snapshot->'items') AS quantity,
       CASE WHEN $2::boolean THEN order_snapshot->'items' END AS designs
     FROM ${table} WHERE merchant_order_id=$1 AND ${status}='paid'`,[id,includeDesigns]);
  const designs=Array.isArray(paid?.designs)?paid.designs.map(item=>{
    if(!item?.petName||!item.baseVariant||!item.faceKey||!item.ownerPhone||
       !Array.isArray(item.decorItems?.front)||!Array.isArray(item.decorItems?.back))return null;
    return Object.fromEntries(designFields.filter(key=>Object.hasOwn(item,key)).map(key=>[key,item[key]]));
  }):[];
  return {delivery:{customerEmail:paid?.email},quantity:paid?.quantity,printCount:0,designs};
}

async function loadPaidProductionImage(provider,id,tag,side){
  if(!/^(?:[1-9]|1[0-9]|20)$/.test(tag))throw fail('image_missing',404);
  const offset=(Number(tag)-1)*3;
  const combined=side==='print_combined';
  if(!combined&&!Object.hasOwn(layerIndex,side))throw fail('image_missing',404);
  const row=await assetRow(provider,id,offset+(combined?0:layerIndex[side]),combined?offset+2:null);
  if(!row?.first?.data||(combined&&!row.second?.data))throw fail('image_missing',404);
  const decode=file=>Buffer.from(file.data.slice('data:image/png;base64,'.length),'base64');
  return combined?combinePrintSides(decode(row.first),decode(row.second)):decode(row.first);
}

async function recoverPaidProduction(provider,order,attachments,profileUrl){
  if(!profileUrl)throw fail('invalid_production_order');
  if(provider==='airwallex'){
    const {configuration,summary,verifyToken}=require('./airwallex-checkout');
    const {verify}=require('./airwallex-payment-verification');
    const details=summary(order),id=order.airwallexSessionId;
    if(!verifyToken(configuration(),order.airwallexOrderToken,id,details))throw fail('invalid_production_order');
    await verify(id,order);
    await savePaidProduction(provider,{...order,paidAmountCents:details.totalCents,cloudProfile:{publicUrl:profileUrl}},attachments,id);
    return;
  }
  let paidAmountCents;
  if(provider==='stripe'){
    const p=require('./stripe-orders');
    const session=await p.stripeSession(order.stripeSessionId);
    p.verifyPaidSession(session,order);
    if(!p.verifyOrderToken(order.stripeOrderToken,session,order))throw fail('invalid_production_order');
    paidAmountCents=session.amount_total;
  }else if(provider==='paypal'){
    const {verifiedPaid}=require('./paypal-orders');
    const {row}=await verifiedPaid(order.id,order.paypalOrderId,order.paypalOrderToken,order);
    paidAmountCents=row.amount_cents;
  }else throw fail('invalid_production_order');
  await savePaidProduction(provider,{...order,paidAmountCents,cloudProfile:{publicUrl:profileUrl}},attachments);
}

module.exports={deliveryFields,savePaidProduction,loadPaidProduction,loadPaidProductionImage,recoverPaidProduction};
