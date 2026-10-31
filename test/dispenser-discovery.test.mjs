import test from 'node:test';
import assert from 'node:assert/strict';
import { dispenserMetadata } from '../src/dispenser-discovery.mjs';
import { startTestnetHttp, testnetManifest, testnetOpenapi } from '../src/testnet-http.mjs';
import { pilotEnvironment } from '../scripts/testnet-server.mjs';

const h=n=>'0x'+n.repeat(64), a=n=>'0x'+n.repeat(40);
const base={chainId:11155111,origin:'https://mote-pilot.example',token:a('1'),router:a('2'),recipient:a('3'),quoteSigner:a('4'),configHash:h('5'),genesisHash:h('6')};
const identity={...base,baseConfigHash:base.configHash,dispenserConfigHash:h('7'),runtimeCodeHash:h('8'),dispenser:a('9'),claimAmount:'10000000',distributionCap:'10000000000',maxClaims:'1000',claimsPerAddress:1,testOnly:true,sybilResistance:false,deployment:{transactionHash:h('a'),blockHash:h('b'),blockNumber:'4'},funding:{transactionHash:h('c'),blockHash:h('d'),blockNumber:'5'},checkpoint:{blockHash:h('e'),blockNumber:'6'}};
function adapter() { return {identity:structuredClone(identity),async verifyIdentity(){return structuredClone(this.identity);}}; }

test('discovery exposes exact claim calldata and limits only for a configured matching verified identity',()=>{
  assert.equal(testnetManifest(base,{ready:true}).tokenAcquisition.configured,false);
  assert(!testnetOpenapi(base).paths['/v1/dispenser']);
  const d=adapter(), m=testnetManifest(base,{ready:true},d);
  assert.equal(m.tokenAcquisition.metadata,base.origin+'/v1/dispenser');
  assert.deepEqual(m.tokenAcquisition.transaction,{type:2,chainId:11155111,to:a('9'),value:'0',data:'0x4e71d92d'});
  assert.equal(m.tokenAcquisition.authorization.discoveryGrantsSpending,false);
  assert.equal(m.tokenAcquisition.sybilResistance,false);
  assert.equal(m.tokenAcquisition.serverSubmitsClaim,false);
  assert(testnetOpenapi(base,d).paths['/v1/dispenser'].get);
  for(const changes of [{chainId:1},{origin:'https://evil.example'},{baseConfigHash:h('f')},{token:a('a')},{genesisHash:h('f')},{distributionCap:'10000000001'},{maxClaims:'1001'},{sybilResistance:true}]) assert.throws(()=>dispenserMetadata(base,{...identity,...changes}));
});
test('HTTP revalidates dispenser evidence, exposes no claim POST and retains free audit on proof failure',async t=>{
  const d=adapter();let calls=0;d.verifyIdentity=async()=>{calls++;return structuredClone(identity);};
  const service={config:base,readiness:()=>({ready:true})};
  const app=await startTestnetHttp({service,host:'127.0.0.1',port:0,dispenser:d});t.after(()=>app.close());
  const url=`http://127.0.0.1:${app.address.port}`;
  assert.equal(calls,1);
  const response=await fetch(url+'/v1/dispenser');assert.equal(response.status,200);assert.equal((await response.json()).dispenser,a('9'));assert.equal(calls,2);
  assert.equal((await fetch(url+'/v1/dispenser',{method:'POST'})).status,404);
  d.verifyIdentity=async()=>{throw new Error('private diagnostic must not escape');};
  const failed=await fetch(url+'/v1/dispenser');assert.equal(failed.status,503);assert(!(await failed.text()).includes('private diagnostic'));
  const free=await fetch(url+'/v1/audit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({document:{synthetic:true}})});assert.equal(free.status,200);assert.equal((await free.json()).receipt.settlement,'none');
});
test('runtime requires dispenser file/hash together and rejects Base dispenser mode',()=>{
  const env={MOTE_MODE:'ethereum-sepolia-public-synthetic-test',MOTE_CHAIN_CONFIG:'/public/config.json',MOTE_CONFIG_HASH:h('5'),MOTE_ETHEREUM_SEPOLIA_QUOTE_PRIVATE_KEY:h('1'),MOTE_PUBLIC_ORIGIN:base.origin};
  for(const fields of [{MOTE_DISPENSER_CONFIG:'/public/dispenser.json'},{MOTE_DISPENSER_CONFIG_HASH:h('7')}]) assert.throws(()=>pilotEnvironment({...env,...fields}));
  assert.equal(pilotEnvironment({...env,MOTE_DISPENSER_CONFIG:'/public/dispenser.json',MOTE_DISPENSER_CONFIG_HASH:h('7')}).dispenserConfigHash,h('7'));
  const {MOTE_ETHEREUM_SEPOLIA_QUOTE_PRIVATE_KEY,...baseEnv}=env;
  assert.throws(()=>pilotEnvironment({...baseEnv,MOTE_MODE:'base-sepolia-public-synthetic-test',MOTE_BASE_SEPOLIA_QUOTE_PRIVATE_KEY:h('1'),MOTE_DISPENSER_CONFIG:'/public/dispenser.json',MOTE_DISPENSER_CONFIG_HASH:h('7')}));
});
