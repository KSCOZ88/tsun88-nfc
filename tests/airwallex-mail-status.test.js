const test=require('node:test');
const assert=require('node:assert/strict');
const {deliveryOutcome}=require('../server/airwallex-mail-status');

test('customer payment receipt never falsely records merchant email as delivered',()=>{
 const result=deliveryOutcome('payment_received',{customer_sent:false,merchant_sent:false},{customerSent:true,merchantSent:false});
 assert.deepEqual(result,{customerSent:true,merchantSent:false,complete:true});
});
test('merchant order production notice requires real delivery',()=>{
 const result=deliveryOutcome('order_completed',{customer_sent:false,merchant_sent:false},{customerSent:true,merchantSent:false});
 assert.deepEqual(result,{customerSent:true,merchantSent:false,complete:false});
});
test('previous delivery states survive idempotent retries',()=>{
 const result=deliveryOutcome('order_completed',{customer_sent:true,merchant_sent:false},{customerSent:false,merchantSent:true});
 assert.deepEqual(result,{customerSent:true,merchantSent:true,complete:true});
});
test('simultaneous delivery only counts confirmed recipients',()=>{
 assert.deepEqual(deliveryOutcome('payment_received',{},{}),{customerSent:false,merchantSent:false,complete:false});
});

test('production attachment failure preserves the customer receipt and merchant retry sends all five files',async(t)=>{
 const {PNG}=require('pngjs');
 const gmail=require('../server/gmail-mailer');
 const label=require('../server/shipping-label');
 const delivered=[];
 const previousPassword=process.env.SMTP_APP_PASSWORD;
 const previousMerchant=process.env.MERCHANT_EMAIL;
 process.env.SMTP_APP_PASSWORD='mock';
 process.env.MERCHANT_EMAIL='merchant@example.com';
 t.after(()=>{
  if(previousPassword===undefined)delete process.env.SMTP_APP_PASSWORD;
  else process.env.SMTP_APP_PASSWORD=previousPassword;
  if(previousMerchant===undefined)delete process.env.MERCHANT_EMAIL;
  else process.env.MERCHANT_EMAIL=previousMerchant;
  delete require.cache[require.resolve('../server/airwallex-order-mailer')];
  delete require.cache[require.resolve('../server/stripe-orders')];
 });
 t.mock.method(gmail,'sendGmail',async mail=>{
  delivered.push(mail);
  return {sent:true};
 });
 const renderLabel=label.shippingLabelAttachment;
 let failLabel=true;
 t.mock.method(label,'shippingLabelAttachment',async(order,options)=>{
  assert.deepEqual(options,{threeAcross:true});
  if(failLabel)throw Object.assign(new Error('PDF file unavailable'),{code:'ENOENT'});
  return renderLabel(order,options);
 });
 const {deliver}=require('../server/airwallex-order-mailer');
 const png='data:image/png;base64,'+PNG.sync.write(new PNG({width:4,height:4})).toString('base64');
 const order={id:'TS-TEST',items:[{petName:'Lucky'}],customerEmail:'customer@example.com',paidAmountCents:29900,
  shipName:'陳小明',shipPhone:'51234567',shipAddress:'示範道8號\nCentral and Western District\nHong Kong',
  cloudProfile:{publicUrl:'https://www.8tsun8.com/p/lucky-tag-04AABBCCDDEE'}};
 const attachments=['01-front','02-dog','03-back'].map(name=>({name:name+'.png',data:png}));
 const attempted=await deliver('order_completed',order,[{data:png}],attachments);
 assert.equal(attempted.customerSent,true);
 assert.equal(attempted.merchantSent,false);
 assert.equal(delivered.length,1);

 failLabel=false;
 const retried=await deliver('order_completed',order,[],attachments,{merchantOnly:true});
 assert.equal(retried.customerSent,false);
 assert.equal(retried.merchantSent,true);
 assert.deepEqual(delivered.map(mail=>mail.to),[['customer@example.com'],['merchant@example.com']]);
 assert.deepEqual(delivered[1].attachments.map(file=>file.content_type),
  ['image/png','image/png','image/png','image/png','application/pdf']);
 assert.equal(Buffer.from(delivered[1].attachments[4].content,'base64').subarray(0,5).toString(),'%PDF-');

 const {deliver:deliverStripe}=require('../server/stripe-orders');
 const stripeOrder={...order,id:'TS-STRIPE-TEST',items:[{petName:'Lucky'},{petName:'Milo'}]};
 const stripeFiles=[...attachments,...attachments.map(file=>({...file,name:'Milo-'+file.name}))];
 const customerOnly=await deliverStripe('payment_received',stripeOrder,[{data:png}]);
 assert.equal(customerOnly.customerSent,true);
 assert.equal(customerOnly.merchantSent,false);
 const stripeResult=await deliverStripe('order_completed',stripeOrder,[],stripeFiles,{skipCustomer:true});
 assert.equal(stripeResult.merchantSent,true);
 const stripeMail=delivered.at(-1);
 assert.deepEqual(stripeMail.to,['merchant@example.com']);
 assert.deepEqual(stripeMail.attachments.map(file=>file.content_type),[
  ...Array(8).fill('image/png'),'application/pdf'
 ]);
 for(const [mail,id,tagCount] of [[delivered[1],order.id,1],[stripeMail,stripeOrder.id,2]]){
  for(const field of [id,order.customerEmail,order.shipName,order.shipPhone,'示範道8號',
   order.cloudProfile.publicUrl,`/merchant/orders?order=${id}`,`Pet tag: ${tagCount}`]){
   assert.ok(mail.html.includes(field),field);
  }
 }
});
