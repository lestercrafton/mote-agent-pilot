import test from 'node:test';
import assert from 'node:assert/strict';
import { HDNodeWallet, verifyMessage, verifyTypedData, id } from 'ethers';
import { spawnSync } from 'node:child_process';
import { canonicalStringify } from '../src/json.mjs';
import { QUOTE_TYPES, quoteDomain } from '../src/testnet-chain.mjs';
import { createPilotQuoteSigner } from '../src/testnet-signer.mjs';
import { pilotEnvironment } from '../scripts/testnet-server.mjs';
import { startPilotSetup } from '../scripts/testnet-setup.mjs';

// Public, worthless fixture identity. No generated/persistent wallet credential.
const wallet = HDNodeWallet.fromPhrase('test test test test test test test test test test test junk',undefined,"m/44'/60'/0'/0/3");
const identity = { origin:'https://pilot.example.invalid',chainId:84532,quoteSigner:wallet.address.toLowerCase(),token:`0x${'11'.repeat(20)}`,router:`0x${'22'.repeat(20)}`,recipient:`0x${'33'.repeat(20)}`,configHash:id('runtime-fixture') };
const NOW=2_000_000_000;
const q={quoteId:id('quote'),requestHash:id('request'),payer:`0x${'44'.repeat(20)}`,amount:'1100',deadline:String(NOW+120)};
const domain=quoteDomain(84532,identity.router);
test('restricted offline signer signs only exact Base quote domain and bounded public test envelopes',async()=>{
 const signer=createPilotQuoteSigner(wallet.privateKey,identity,{now:()=>NOW});
 assert.deepEqual(Object.keys(signer).sort(),['address','signMessage','signTypedData']);
 assert.equal(signer.sendTransaction,undefined);assert.equal(signer.privateKey,undefined);
 const signature=await signer.signTypedData(domain,QUOTE_TYPES,q);
 assert.equal(verifyTypedData(domain,QUOTE_TYPES,q,signature).toLowerCase(),identity.quoteSigner);
 const envelope={protocol:'mote-base-sepolia-test-v1',quote:q,domain,signature,chainId:84532,token:identity.token,router:identity.router,recipient:identity.recipient,quoteSigner:identity.quoteSigner,decimals:6,asset:'MOTE',service:'json.audit',resultHash:id('result'),expiresAt:new Date((NOW+120)*1000).toISOString(),inputBytes:10,origin:identity.origin,configHash:identity.configHash,finality:'finalized',testOnly:true,publicSynthetic:true,localOnly:false};
 const signed=await signer.signMessage(canonicalStringify(envelope));
 assert.equal(verifyMessage(canonicalStringify(envelope),signed).toLowerCase(),identity.quoteSigner);
 for(const bad of [{...domain,chainId:1},{...domain,verifyingContract:identity.token}])await assert.rejects(signer.signTypedData(bad,QUOTE_TYPES,q));
 for(const bad of [{...q,amount:'999999999'},{...q,deadline:String(NOW-1)},{...q,deadline:String(NOW+901)}])await assert.rejects(signer.signTypedData(domain,QUOTE_TYPES,bad));
 for(const bad of [{...envelope,publicSynthetic:false},{...envelope,configHash:id('other')},{...envelope,transaction:{to:identity.token}},{...envelope,inputBytes:11}])await assert.rejects(signer.signMessage(canonicalStringify(bad)));
 await assert.rejects(signer.signMessage('sign any arbitrary command'));
});
test('restricted signer can attest finalized delivery without extending expired payment authority',async()=>{
 const signer=createPilotQuoteSigner(wallet.privateKey,identity,{now:()=>NOW+10000});
 const receipt={protocol:'mote-base-sepolia-test-v1',quoteId:q.quoteId,requestHash:q.requestHash,resultHash:id('result'),payer:q.payer,amount:q.amount,asset:'MOTE',chainId:84532,token:identity.token,router:identity.router,recipient:identity.recipient,quoteSigner:identity.quoteSigner,origin:identity.origin,configHash:identity.configHash,transactionHash:id('transaction'),blockNumber:'10',blockHash:id('block'),transactionIndex:'0',logIndex:'1',settledAt:new Date(NOW*1000).toISOString(),finalized:{blockNumber:'12',blockHash:id('finalized')},finality:'finalized',testOnly:true,publicSynthetic:true,localOnly:false};
 const signature=await signer.signMessage(canonicalStringify(receipt));assert.equal(verifyMessage(canonicalStringify(receipt),signature).toLowerCase(),identity.quoteSigner);
 await assert.rejects(signer.signTypedData(domain,QUOTE_TYPES,q));
 await assert.rejects(signer.signMessage(canonicalStringify({...receipt,finalized:{blockNumber:'9',blockHash:id('x')}})));
});
test('runtime refuses absent key/config, fixture mode and transaction-key aliases without exposing values',()=>{
 const env={MOTE_MODE:'base-sepolia-public-synthetic-test',MOTE_PUBLIC_ORIGIN:identity.origin,MOTE_CHAIN_CONFIG:'config.json',MOTE_CONFIG_HASH:identity.configHash,MOTE_BASE_SEPOLIA_QUOTE_PRIVATE_KEY:wallet.privateKey,PORT:'10000'};
 assert.equal(pilotEnvironment(env).recoveryOnly,false);
 for(const extra of [{MOTE_MODE:'local-fixture'},{MOTE_CONFIG_HASH:''},{MOTE_BASE_SEPOLIA_QUOTE_PRIVATE_KEY:''},{PRIVATE_KEY:'SENSITIVE_FIXTURE_DO_NOT_ECHO'},{DEPLOYER_PRIVATE_KEY:'SENSITIVE_FIXTURE_DO_NOT_ECHO'},{MOTE_RECOVERY_ONLY:'yes'},{PORT:'0'},{RENDER:'true',MOTE_DATABASE:'/tmp/orders.sqlite'}])assert.throws(()=>pilotEnvironment({...env,...extra}));
 const child=spawnSync(process.execPath,['scripts/testnet-server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,MOTE_MODE:'local-fixture',PRIVATE_KEY:'SENSITIVE_FIXTURE_DO_NOT_ECHO'},encoding:'utf8'});
 assert.equal(child.status,1);assert(!child.stderr.includes('SENSITIVE_FIXTURE_DO_NOT_ECHO'));
});
test('admin exposes explicit initialization and read-only reconciliation, with no send or credential options',()=>{
 const command=(args)=>spawnSync(process.execPath,['scripts/testnet-admin.mjs',...args],{cwd:new URL('..',import.meta.url),encoding:'utf8'});
 const help=command(['help']);assert.equal(help.status,0);assert.match(help.stdout,/reconcile-store/);assert.match(help.stdout,/never signs/);
 for(const args of [['broadcast'],['init-store','--private-key','SENSITIVE_FIXTURE_DO_NOT_ECHO'],['identity','--config','missing.json']]){const result=command(args);assert.equal(result.status,1);assert(!result.stderr.includes('SENSITIVE_FIXTURE_DO_NOT_ECHO'));}
});
test('temporary provider setup is maintenance-only and exposes no initialization or signing endpoint',async t=>{
 await assert.rejects(startPilotSetup({MOTE_MODE:'base-sepolia-setup',PRIVATE_KEY:'fixture'},{port:0}));
 const app=await startPilotSetup({MOTE_MODE:'base-sepolia-setup'},{host:'127.0.0.1',port:0});t.after(()=>app.close());
 const url=`http://127.0.0.1:${app.address.port}`;
 assert.equal((await fetch(url+'/ready')).status,200);
 const response=await fetch(url+'/init-store',{method:'POST',body:'{}'});assert.equal(response.status,503);assert.equal((await response.json()).adminHttp,false);
});

test('Ethereum runtime selects only its dedicated quote key and rejects cross-network key aliases', async t => {
  const ethereum = { ...identity, chainId: 11155111 };
  const signer = createPilotQuoteSigner(wallet.privateKey, ethereum, { now: () => NOW });
  const domain = quoteDomain(11155111, ethereum.router);
  const signature = await signer.signTypedData(domain, QUOTE_TYPES, q);
  assert.equal(verifyTypedData(domain, QUOTE_TYPES, q, signature).toLowerCase(), ethereum.quoteSigner);
  await signer.signTypedData(domain, QUOTE_TYPES, {...q,deadline:String(NOW+3600)});
  await assert.rejects(signer.signTypedData(domain, QUOTE_TYPES, {...q,deadline:String(NOW+7201)}));
  await assert.rejects(signer.signTypedData(quoteDomain(84532, ethereum.router), QUOTE_TYPES, q));
  const env={MOTE_MODE:'ethereum-sepolia-public-synthetic-test',MOTE_PUBLIC_ORIGIN:identity.origin,MOTE_CHAIN_CONFIG:'config.json',MOTE_CONFIG_HASH:identity.configHash,MOTE_ETHEREUM_SEPOLIA_QUOTE_PRIVATE_KEY:wallet.privateKey,PORT:'10000'};
  const settings=pilotEnvironment(env);
  assert.equal(settings.chainId,11155111);
  assert.equal(settings.quoteKeyName,'MOTE_ETHEREUM_SEPOLIA_QUOTE_PRIVATE_KEY');
  assert.equal(settings.networkSlug,'ethereum-sepolia');
  assert.throws(()=>pilotEnvironment({...env,MOTE_BASE_SEPOLIA_QUOTE_PRIVATE_KEY:wallet.privateKey}));
  assert.throws(()=>pilotEnvironment({...env,MOTE_MODE:'ethereum-mainnet-public-synthetic-test'}));
  assert.throws(()=>createPilotQuoteSigner(wallet.privateKey,{...ethereum,chainId:1}));
  const app=await startPilotSetup({MOTE_MODE:'ethereum-sepolia-setup'},{host:'127.0.0.1',port:0});t.after(()=>app.close());
  assert.equal((await fetch(`http://127.0.0.1:${app.address.port}/ready`)).status,200);
});
