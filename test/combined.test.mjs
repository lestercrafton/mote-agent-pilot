import test from 'node:test';
import A from 'node:assert/strict';
import { encodePaymentSignatureHeader,decodePaymentRequiredHeader } from '@x402/core/http';
import { fixture,input,signer,PUBLIC_FIXTURE_PAYER } from './fixtures.mjs';
import { authorize } from '../src/client.mjs';
import { installCombinedRoutes,USDC_PATH,USDC_MANIFEST } from '../src/combined.mjs';
import { startCombinedFromEnvironment } from '../src/startup.mjs';
import { startTestnetHttp } from '../legacy/src/testnet-http.mjs';
const origin='https://mote.example';
async function legacy() {
 const calls=[];
 const service={config:{origin},readiness:async()=>({ready:true,mode:'test-fixture'}),quote:async(body,key)=>{calls.push({body,key});return {body,key};}};
 const transport=await startTestnetHttp({service,port:0,host:'127.0.0.1'});
 return {service,transport,calls,base:`http://127.0.0.1:${transport.address.port}`,close:()=>{transport.server.closeAllConnections();return transport.close();}};
}
const post=(base,path,body,headers={})=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
test('combined routes preserve real legacy free utility and testnet request semantics; paid route is signed and separate',async()=>{
 const old=await legacy(),f=fixture({config:{origin,path:USDC_PATH}});let combined;
 try{
  const before=await (await post(old.base,'/v1/audit',input)).json();
  combined=installCombinedRoutes({legacy:old,usdc:f.service});
  A.deepEqual(await (await post(old.base,'/v1/audit',input)).json(),before);
  const q={payer:PUBLIC_FIXTURE_PAYER.address,input,publicSynthetic:true};
  A.deepEqual(await (await post(old.base,'/v1/quotes',q,{'idempotency-key':'legacy-id'})).json(),{body:q,key:'legacy-id'});
  A.equal(old.calls.length,1);A.equal(f.facilitator.settleCalls,0);
  const manifest=await (await fetch(old.base+USDC_MANIFEST)).json();A.equal(manifest.endpoint,origin+USDC_PATH);A.equal(manifest.productionReady,false);
  const offered=await post(old.base,USDC_PATH,input);A.equal(offered.status,402);
  const offerResponse=decodePaymentRequiredHeader(offered.headers.get('payment-required'));A.equal(offerResponse.resource.url,origin+USDC_PATH);
  const p=await authorize({config:f.c,input,offerResponse,paymentId:'combined-payment-0001',signer:signer(PUBLIC_FIXTURE_PAYER),journal:f.clientJournal,policy:f.policy,now:f.chain.now});
  const h={'payment-signature':encodePaymentSignatureHeader(p)};
  A.equal(manifest.limits.paymentHeaderBytes,12000);A.equal(old.transport.server.maxConnections,32);A.equal(old.transport.server.maxHeaderSize,16384);
  const first=await post(old.base,USDC_PATH,input,h);A.equal(first.status,200);const result=await first.json();
  A.deepEqual(await (await post(old.base,USDC_PATH,input,h)).json(),result);A.equal(f.facilitator.settleCalls,1);
  let padded={...p,padding:''};const baseSize=encodePaymentSignatureHeader(padded).length;padded.padding='x'.repeat(Math.floor((12000-baseSize)*3/4));
  while(encodePaymentSignatureHeader(padded).length>12000)padded.padding=padded.padding.slice(1);
  const boundary=encodePaymentSignatureHeader(padded);A.ok(boundary.length>=11996&&boundary.length<=12000);
  A.deepEqual(await (await post(old.base,USDC_PATH,input,{'payment-signature':boundary})).json(),result);
  padded.padding+='xxxx';const oversized=await post(old.base,USDC_PATH,input,{'payment-signature':encodePaymentSignatureHeader(padded)});A.equal(oversized.status,400);A.deepEqual(await oversized.json(),{error:'PAYMENT_SIZE'});
  A.equal((await post(old.base,USDC_PATH+'?other=1',input,h)).status,404);
  A.equal((await post(old.base,USDC_PATH+'/',input,h)).status,404);
  A.equal((await fetch(old.base+USDC_MANIFEST+'?x=1')).status,404);
  const ready=await (await fetch(old.base+'/ready')).json();A.equal(ready.usdc.newAdmissionAllowed,true);A.equal(ready.productionReady,false);
  f.journal.recoveryOnly=true;A.equal((await (await fetch(old.base+'/ready')).json()).usdc.newAdmissionAllowed,false);
  A.deepEqual(await (await post(old.base,USDC_PATH,input,h)).json(),result);
 }finally{if(combined)await combined.close();else await old.close();f.close();}
});
test('startup disabled never opens USDC secrets and preserves actual source-binding environment',async()=>{
 const env={MOTE_USDC_ENABLED:'false',RENDER_GIT_COMMIT:'actual-new-commit'};let observed,combined;
 try{combined=await startCombinedFromEnvironment(env,{legacyFactory:async e=>{observed=e;return legacy();},usdcFactory:()=>{throw Error('must not read secrets');}});
 A.equal(observed,env);A.equal(observed.RENDER_GIT_COMMIT,'actual-new-commit');
 A.equal((await post(combined.legacy.base,USDC_PATH,input)).status,503);
 A.equal((await (await fetch(combined.legacy.base+USDC_MANIFEST)).json()).enabled,false);
 A.equal((await post(combined.legacy.base,'/v1/audit',input)).status,200);
 }finally{await combined?.close();}
});
test('combined startup closes its new listener on failed USDC readiness; no legacy source spoof',async()=>{
 let old;
 await A.rejects(startCombinedFromEnvironment({MOTE_USDC_ENABLED:'true',RENDER_GIT_COMMIT:'real'},{legacyFactory:async e=>{A.equal(e.RENDER_GIT_COMMIT,'real');old=await legacy();return old;},usdcFactory:async()=>{throw Error('fixture startup unavailable');}}),/fixture startup unavailable/);
 A.equal(old.transport.server.listening,false);
 let called=false;await A.rejects(startCombinedFromEnvironment({MOTE_USDC_ENABLED:'yes'},{legacyFactory:()=>{called=true;}}),/USDC_ENABLE_FLAG/);A.equal(called,false);
});
