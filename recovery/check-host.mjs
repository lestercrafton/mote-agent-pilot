import{canonicalStringify,parseJson}from'../src/json.mjs';
import{dispenserMetadata}from'../src/dispenser-discovery.mjs';
import pins from'./pins.json'with{type:'json'};
const fail=()=>{throw Object.assign(new Error('LAUNCH_HOST_NOT_READY'),{code:'LAUNCH_HOST_NOT_READY'});};
export async function checkPaidHost({identity,dispenserIdentity,fetchImpl=globalThis.fetch}){
 try{
  const read=async path=>{const url=pins.origin+path,r=await fetchImpl(url,{method:'GET',redirect:'error',credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(10000)});if(!r.ok||r.redirected||(r.url&&r.url!==url))fail();const stream=r.body?.getReader();if(!stream)fail();let length=0;const chunks=[];try{for(;;){const{done,value}=await stream.read();if(done)break;length+=value.length;if(length>1048576){await stream.cancel();fail();}chunks.push(value);}}finally{stream.releaseLock();}return parseJson(Buffer.concat(chunks).toString('utf8'));};
  const ready=await read('/ready'),manifest=await read('/.well-known/mote.json');
  if(ready.ready!==true||ready.newQuotesAllowed!==true||ready.mode!=='normal'||ready.publicSyntheticOnly!==true||ready.testOnly!==true||manifest.testOnly!==true||manifest.publicSyntheticOnly!==true||manifest.baseUrl!==pins.origin||manifest.environment!=='ethereum-sepolia-public-synthetic-test'||manifest.serviceReadiness?.newQuotesAllowed!==true||manifest.serviceReadiness?.mode!=='normal')fail();
  const s=manifest.settlement;if(s?.chainId!==11155111||s.configHash!==identity.configHash||s.realMoney!==false||s.testAssetsOnly!==true)fail();
  for(const k of ['token','router','recipient','quoteSigner'])if(s[k]!==identity[k])fail();
  const expected=dispenserMetadata(identity,dispenserIdentity),actual=manifest.tokenAcquisition;
  if(actual?.method!=='onchain-claim'||actual.metadata!==pins.origin+'/v1/dispenser')fail();
  const{method,metadata,...body}=actual;if(canonicalStringify(body)!==canonicalStringify(expected))fail();
  const fresh=await read('/v1/dispenser');if(canonicalStringify(fresh)!==canonicalStringify(expected))fail();
  return{ready:true,configHash:identity.configHash,dispenserConfigHash:dispenserIdentity.dispenserConfigHash};
 }catch{fail();}
}
