import test from 'node:test';
import assert from 'node:assert/strict';
import {GET,POST} from '../api/airwallex-db-diagnostic.mjs';
const endpoint='https://example.com/api/airwallex-db-diagnostic';
test('untrusted requests never reach the database probe',async()=>{
 const old=process.env.TSUN_DIAGNOSTIC_TOKEN;
 process.env.TSUN_DIAGNOSTIC_TOKEN='unit-test-only-diagnostic-secret';
 try{
   const res=await POST(new Request(endpoint,{method:'POST'}));
   assert.equal(res.status,404);
   const wrong=await POST(new Request(endpoint,{method:'POST',headers:{authorization:'Bearer wrong'}}));
   assert.equal(wrong.status,404);
 }finally{
   if(old===undefined)delete process.env.TSUN_DIAGNOSTIC_TOKEN;
   else process.env.TSUN_DIAGNOSTIC_TOKEN=old;
 }
});
test('GET cannot invoke a write diagnostic',async()=>{
 const res=await GET();
 assert.equal(res.status,404);
});
