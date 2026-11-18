import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {POST,GET} from '../api/airwallex-webhook.mjs';
const previous=process.env.AIRWALLEX_WEBHOOK_SECRET;
process.env.AIRWALLEX_WEBHOOK_SECRET='unit-test-only-webhook-secret';
const signedRequest=(body,signatureOverride)=>{
 const timestamp=String(Date.now());
 const signature=signatureOverride??createHmac('sha256',process.env.AIRWALLEX_WEBHOOK_SECRET).update(timestamp+body).digest('hex');
 return new Request('https://example.com/api/airwallex-webhook',{method:'POST',headers:{'content-type':'application/json','x-timestamp':timestamp,'x-signature':signature},body});
};
test('signed irrelevant event is ignored without accessing payment API',async()=>{
 const response=await POST(signedRequest(JSON.stringify({name:'payment_link.created'})));
 assert.equal(response.status,200);
 assert.equal((await response.json()).ignored,true);
});
test('rejects tampered webhook signature',async()=>{
 const response=await POST(signedRequest(JSON.stringify({name:'payment_link.created'}),'0'.repeat(64)));
 assert.equal(response.status,401);
});
test('rejects signed body if payload was altered',async()=>{
 const original=JSON.stringify({name:'payment_link.created'});
 const stamp=String(Date.now());
 const sig=createHmac('sha256',process.env.AIRWALLEX_WEBHOOK_SECRET).update(stamp+original).digest('hex');
 const request=new Request('https://example.com/api/airwallex-webhook',{method:'POST',headers:{'x-timestamp':stamp,'x-signature':sig},body:JSON.stringify({name:'payment_link.paid'})});
 const response=await POST(request);
 assert.equal(response.status,401);
});
test('Airwallex test event accepts a signed client-secret-key without sending mail',async()=>{
 const body=JSON.stringify({name:'payment_link.paid',data:{object:{id:'plink_test_fixture'}}});
 const stamp=String(Date.now()),testSecret='airwallex-test-fixture-key';
 const sig=createHmac('sha256',testSecret).update(stamp+body).digest('hex');
 const request=new Request('https://example.com/api/airwallex-webhook',{method:'POST',headers:{'x-timestamp':stamp,'x-signature':sig,'client-secret-key':testSecret},body});
 const response=await POST(request);
 assert.equal(response.status,200);
 assert.equal((await response.json()).test,true);
});
test('invalid test signature is rejected',async()=>{
 const body=JSON.stringify({name:'payment_link.paid'});
 const request=new Request('https://example.com/api/airwallex-webhook',{method:'POST',headers:{'x-timestamp':String(Date.now()),'x-signature':'0'.repeat(64),'client-secret-key':'fake-test-key'},body});
 const response=await POST(request);
 assert.equal(response.status,401);
});
test('GET health check stays public and does not trigger retry',async()=>{
 const res=await GET(new Request('https://example.com/api/airwallex-webhook'));
 assert.equal(res.status,200);
 assert.deepEqual(await res.json(),{webhook:'reachable',accepts:'POST'});
});
test('signed test event acknowledges before touching order or SMTP',async()=>{
 const body=JSON.stringify({name:'payment_link.paid',data:{object:{id:'plink_synthetic_123'}}});
 const timestamp=String(Date.now()),key='synthetic-test-secret';
 const signature=createHmac('sha256',key).update(timestamp+body).digest('hex');
 const request=new Request('https://example.com/api/airwallex-webhook',{method:'POST',headers:{'x-timestamp':timestamp,'x-signature':signature,'client-secret-key':key},body});
 const res=await POST(request,{waitUntil(){throw Error('test events must not schedule background work')}});
 assert.equal(res.status,200);
 assert.equal((await res.json()).test,true);
});
test('unauthorized database probe cannot run',async()=>{
 const r=await POST(new Request('https://example.com/api/airwallex-webhook?dbDiagnostic=1',{method:'POST'}));
 assert.equal(r.status,404);
});
test.after(()=>{if(previous===undefined)delete process.env.AIRWALLEX_WEBHOOK_SECRET;else process.env.AIRWALLEX_WEBHOOK_SECRET=previous;});
