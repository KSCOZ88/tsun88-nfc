'use strict';

const {db,schema}=require('./airwallex-order-store');
const {summary}=require('./airwallex-checkout');
const directQr=require('./airwallex-fps');

async function verify(id,order){
 const {orderId}=summary(order);
 const sql=db();
 await schema(sql);
 // The JSON projection works before any direct FPS order has migrated this table.
 const [stored]=await sql`SELECT to_jsonb(o)->>'payment_kind' AS kind
  FROM tsun_airwallex_orders o WHERE merchant_order_id=${orderId} AND payment_link_id=${id}`;
 return directQr.supportsQr(stored?.kind)
  ? directQr.verify(id,order,stored.kind)
  : require('./airwallex-payment-links').verify(id,order);
}

module.exports={verify};
