import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, chmodSync, readFileSync, writeFileSync, existsSync, linkSync, symlinkSync, renameSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Wallet } from 'ethers';
import { describeFileHandoffDestination, createReceiverSession, sealQuoteKey, hashFileHandoffChallenge, QUOTE_HANDOFF_ACTIVATION, QUOTE_HANDOFF_FIXTURE_ACK } from '../src/quote-key-envelope.mjs';
import { reserveQuoteImport, inspectQuoteImport, withQuoteFileEnvironment, QUOTE_FILE_ENVIRONMENT_KEY } from '../src/quote-key-file.mjs';

const PUBLIC_KEY='0x'+'00'.repeat(31)+'01';
const pair=n=>()=>{const privateKey=createPrivateKey({key:Buffer.from('302e020100300506032b656e04220420'+n.repeat(32),'hex'),format:'der',type:'pkcs8'});return{privateKey,publicKey:createPublicKey(privateKey)};};
const random=n=>Buffer.alloc(n,7), now=()=>2_000_000_000_000;
function fixture(t){
 const base=realpathSync(mkdtempSync(join(tmpdir(),'mote-quote-key-public-fixture-')));chmodSync(base,0o700);t.after(()=>rmSync(base,{recursive:true,force:true}));
 const destination=describeFileHandoffDestination({serviceId:'srv-dbijuvou01pc73d59c30',origin:'https://mote-testnet-pilot.onrender.com',configHash:'0x'+'11'.repeat(32),quoteSigner:new Wallet(PUBLIC_KEY).address,sourceCommit:'22'.repeat(20)});
 const env={RENDER:'true',RENDER_SERVICE_ID:destination.serviceId,RENDER_EXTERNAL_URL:destination.origin,RENDER_GIT_COMMIT:destination.sourceCommit,MOTE_MODE:'ethereum-sepolia-public-synthetic-test',MOTE_PUBLIC_ORIGIN:destination.origin,MOTE_CONFIG_HASH:destination.configHash,MOTE_CHAIN_CONFIG:'/var/data/deployment.json'};
 const fixtureConfiguration={fixtureOnly:true,chainId:11155111,origin:destination.origin,configHash:destination.configHash,roles:{quoteSigner:destination.quoteSigner,deployer:'0x'+'33'.repeat(20),initialHolder:'0x'+'33'.repeat(20),merchant:'0x'+'33'.repeat(20)}};
 return {base,destination,options:{destination,env,activation:QUOTE_HANDOFF_ACTIVATION,fixtureRoot:join(base,'quote'),fixtureAcknowledgement:QUOTE_HANDOFF_FIXTURE_ACK,fixtureConfiguration}};
}
function challenge(f){return createReceiverSession({destination:f.destination,now,keyPairFactory:pair('11'),randomBytesFactory:random,fixtureAcknowledgement:QUOTE_HANDOFF_FIXTURE_ACK});}
function complete(f,options=f.options){const store=reserveQuoteImport(options),receiver=challenge(f);try{store.bindChallenge(receiver.challenge);const capsule=sealQuoteKey(Buffer.from(PUBLIC_KEY.slice(2),'hex'),receiver.challenge,{expectedDestinationHash:f.destination.destinationHash,expectedChallengeHash:hashFileHandoffChallenge(receiver.challenge),now,keyPairFactory:pair('22'),randomBytesFactory:random,fixtureAcknowledgement:QUOTE_HANDOFF_FIXTURE_ACK});const bytes=receiver.open(capsule);const receipt=store.commit(bytes);assert(bytes.every(x=>x===0));return{receipt,store,receiver};}finally{receiver.close();}}

test('durable reservation precedes challenge/key; installed receipt recovers without writing or repeating import',t=>{
 const f=fixture(t),steps=[];const {receipt}=complete(f,{...f.options,onCheckpoint:s=>steps.push(s)});
 assert.deepEqual(steps,['intent-durable','challenge-durable','key-staged','key-published','key-finalized','receipt-durable']);
 assert.equal(statSync(f.options.fixtureRoot).mode&0o777,0o700);for(const name of ['intent.json','challenge.json','quote.key','receipt.json'])assert.equal(statSync(join(f.options.fixtureRoot,name)).mode&0o777,0o600);
 assert.equal(existsSync(join(f.options.fixtureRoot,'.quote-key.pending')),false);assert.equal(statSync(join(f.options.fixtureRoot,'quote.key')).nlink,1);
 const before=readFileSync(join(f.options.fixtureRoot,'receipt.json'));const result=inspectQuoteImport(f.options);assert.equal(result.state,'installed');assert.equal(result.address,receipt.address);assert.equal(result.mayAutomaticallyImport,false);assert.deepEqual(readFileSync(join(f.options.fixtureRoot,'receipt.json')),before);
 assert.throws(()=>reserveQuoteImport(f.options),{code:'QUOTE_FILE_IMPORT_ALREADY_RESERVED'});
});
test('ephemeral environment does not modify global env, drops key after callback and redacts callback errors',async t=>{
 const f=fixture(t);complete(f);const original=process.env[QUOTE_FILE_ENVIRONMENT_KEY];let captured;
 const result=await withQuoteFileEnvironment(f.options,async env=>{captured=env;assert.equal(env[QUOTE_FILE_ENVIRONMENT_KEY],PUBLIC_KEY);assert.equal(process.env[QUOTE_FILE_ENVIRONMENT_KEY],original);return{ok:true};});assert.deepEqual(result,{ok:true});assert.equal(Object.hasOwn(captured,QUOTE_FILE_ENVIRONMENT_KEY),false);assert.equal(process.env[QUOTE_FILE_ENVIRONMENT_KEY],original);
 await assert.rejects(withQuoteFileEnvironment(f.options,env=>{throw Error(env[QUOTE_FILE_ENVIRONMENT_KEY]);}),e=>e.message==='QUOTE_FILE_STARTUP_FAILED'&&!e.cause);
});
test('native activation absent, env authority, identity/config conflicts fail before creating files',t=>{
 const f=fixture(t);for(const patch of [{activation:'not-approved'},{fixtureAcknowledgement:'wrong'},{env:{...f.options.env,RENDER_SERVICE_ID:'srv-other'}},{env:{...f.options.env,MOTE_CONFIG_HASH:'0x'+'44'.repeat(32)}},{env:{...f.options.env,[QUOTE_FILE_ENVIRONMENT_KEY]:PUBLIC_KEY}},{env:{...f.options.env,DEPLOYER_KEY:'do-not-log'}},{fixtureConfiguration:{...f.options.fixtureConfiguration,configHash:'0x'+'55'.repeat(32)}}]){assert.throws(()=>reserveQuoteImport({...f.options,...patch}));assert.equal(existsSync(f.options.fixtureRoot),false);}
 assert.throws(()=>reserveQuoteImport({destination:f.destination,activation:QUOTE_HANDOFF_ACTIVATION,env:f.options.env}));
 assert.equal(existsSync(f.options.fixtureRoot),false);
});
test('maintenance mode may import after pinned public configuration; it cannot start paid service',async t=>{
 const f=fixture(t);const options={...f.options,env:{RENDER:'true',RENDER_SERVICE_ID:f.destination.serviceId,RENDER_EXTERNAL_URL:f.destination.origin,RENDER_GIT_COMMIT:f.destination.sourceCommit,MOTE_MODE:'ethereum-sepolia-setup'}};complete(f,options);assert.equal(inspectQuoteImport(options).state,'installed');await assert.rejects(withQuoteFileEnvironment(options,()=>assert.fail('must not start')),/STARTUP_FAILED/);
});
test('existing directory without intent and staged or corrupt state never grants a fresh attempt',t=>{
 const f=fixture(t);mkdirSync(f.options.fixtureRoot,{mode:0o700});assert.equal(inspectQuoteImport(f.options).state,'uncertain-missing-intent');assert.throws(()=>reserveQuoteImport(f.options),/ALREADY_RESERVED/);
});
test('signer mismatch consumes the attempt, zeroes caller bytes and retains reservation',t=>{
 const f=fixture(t),store=reserveQuoteImport(f.options),receiver=challenge(f);t.after(()=>receiver.close());store.bindChallenge(receiver.challenge);const invalid=Buffer.alloc(32,0);assert.throws(()=>store.commit(invalid),/OUTCOME_UNKNOWN/);assert(invalid.every(x=>x===0));assert.throws(()=>store.commit(Buffer.from(PUBLIC_KEY.slice(2),'hex')),/ATTEMPT_CONSUMED/);assert.equal(inspectQuoteImport(f.options).state,'reserved-no-key');
});
test('impossible receipt-before-key state refuses publication and clears every rejected input buffer',t=>{
 const f=fixture(t),store=reserveQuoteImport(f.options),receiver=challenge(f);t.after(()=>receiver.close());store.bindChallenge(receiver.challenge);writeFileSync(join(f.options.fixtureRoot,'receipt.json'),'{}',{mode:0o600});
 assert.throws(()=>inspectQuoteImport(f.options),/CORRUPT/);const bytes=Buffer.from(PUBLIC_KEY.slice(2),'hex');assert.throws(()=>store.commit(bytes),/OUTCOME_UNKNOWN/);assert(bytes.every(x=>x===0));assert.equal(existsSync(join(f.options.fixtureRoot,'quote.key')),false);
 const repeated=Buffer.from(PUBLIC_KEY.slice(2),'hex');assert.throws(()=>store.commit(repeated),/ATTEMPT_CONSUMED/);assert(repeated.every(x=>x===0));
});
test('replacement root is rejected before challenge or key publication',t=>{
 const f=fixture(t),store=reserveQuoteImport(f.options),receiver=challenge(f);t.after(()=>receiver.close());renameSync(f.options.fixtureRoot,f.options.fixtureRoot+'-original');mkdirSync(f.options.fixtureRoot,{mode:0o700});assert.throws(()=>store.bindChallenge(receiver.challenge),/CHANGED/);assert.equal(existsSync(join(f.options.fixtureRoot,'challenge.json')),false);assert.equal(existsSync(join(f.options.fixtureRoot,'quote.key')),false);
});
test('symlink root/key, extra hardlink, wrong mode and corrupt receipt fail closed',async t=>{
 const cases=['root-symlink','key-symlink','hardlink','mode','receipt','key-short','extra'];
 for(const which of cases){const f=fixture(t);complete(f);const key=join(f.options.fixtureRoot,'quote.key');
  if(which==='root-symlink'){renameSync(f.options.fixtureRoot,f.options.fixtureRoot+'-moved');symlinkSync(f.options.fixtureRoot+'-moved',f.options.fixtureRoot);}
  if(which==='key-symlink'){renameSync(key,key+'-moved');symlinkSync(key+'-moved',key);}
  if(which==='hardlink')linkSync(key,join(f.base,'extra-key-link'));
  if(which==='mode')chmodSync(key,0o644);
  if(which==='receipt')writeFileSync(join(f.options.fixtureRoot,'receipt.json'),'{}');
  if(which==='key-short')writeFileSync(key,Buffer.alloc(5));
  if(which==='extra')writeFileSync(join(f.options.fixtureRoot,'unexpected'),'public fixture');
  assert.throws(()=>inspectQuoteImport(f.options),undefined,which);await assert.rejects(withQuoteFileEnvironment(f.options,()=>assert.fail('must not expose key')),/STARTUP_FAILED/);
 }
});

const crashProgram=`import {reserveQuoteImport} from './src/quote-key-file.mjs';import {createReceiverSession,describeFileHandoffDestination,QUOTE_HANDOFF_ACTIVATION,QUOTE_HANDOFF_FIXTURE_ACK}from'./src/quote-key-envelope.mjs';import{createPrivateKey,createPublicKey}from'node:crypto';import{Wallet}from'ethers';const key=Buffer.from('00'.repeat(31)+'01','hex'),destination=describeFileHandoffDestination({serviceId:'srv-dbijuvou01pc73d59c30',origin:'https://mote-testnet-pilot.onrender.com',configHash:'0x'+'11'.repeat(32),quoteSigner:new Wallet('0x'+key.toString('hex')).address,sourceCommit:'22'.repeat(20)});const env={RENDER:'true',RENDER_SERVICE_ID:destination.serviceId,RENDER_EXTERNAL_URL:destination.origin,RENDER_GIT_COMMIT:destination.sourceCommit,MOTE_MODE:'ethereum-sepolia-public-synthetic-test',MOTE_PUBLIC_ORIGIN:destination.origin,MOTE_CONFIG_HASH:destination.configHash,MOTE_CHAIN_CONFIG:'/var/data/deployment.json'};const store=reserveQuoteImport({destination,env,activation:QUOTE_HANDOFF_ACTIVATION,fixtureAcknowledgement:QUOTE_HANDOFF_FIXTURE_ACK,fixtureRoot:process.argv[1],fixtureConfiguration:{fixtureOnly:true,chainId:11155111,origin:destination.origin,configHash:destination.configHash,roles:{quoteSigner:destination.quoteSigner,deployer:'0x'+'33'.repeat(20),initialHolder:'0x'+'33'.repeat(20),merchant:'0x'+'33'.repeat(20)}},onCheckpoint:point=>{if(point===process.argv[2]){process.send({point});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}});const receiver=createReceiverSession({destination,fixtureAcknowledgement:QUOTE_HANDOFF_FIXTURE_ACK,keyPairFactory:()=>{const privateKey=createPrivateKey({key:Buffer.from('302e020100300506032b656e04220420'+'11'.repeat(32),'hex'),format:'der',type:'pkcs8'});return{privateKey,publicKey:createPublicKey(privateKey)};},randomBytesFactory:n=>Buffer.alloc(n,7)});store.bindChallenge(receiver.challenge);store.commit(key);receiver.close();`;
for(const point of ['intent-durable','challenge-durable','key-staged','key-published','key-finalized','receipt-durable'])test(`SIGKILL at ${point} retains authority and recovery never resubmits`,async t=>{
 const f=fixture(t);const child=spawn(process.execPath,['--input-type=module','-e',crashProgram,f.options.fixtureRoot,point],{cwd:new URL('../',import.meta.url),env:{PATH:process.env.PATH??'',TMPDIR:tmpdir(),NODE_NO_WARNINGS:'1'},stdio:['ignore','pipe','pipe','ipc']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);t.after(()=>child.kill('SIGKILL'));const exit=once(child,'exit');const timer=setTimeout(()=>child.kill('SIGKILL'),10000);t.after(()=>clearTimeout(timer));const msg=await Promise.race([once(child,'message'),exit.then(()=>{throw Error('fixture child exited before checkpoint: '+output);})]);assert.equal(msg[0].point,point);child.kill('SIGKILL');const [code,signal]=await exit;assert.equal(code,null);assert.equal(signal,'SIGKILL');assert.equal(output.includes(PUBLIC_KEY),false);assert.equal(output.includes(PUBLIC_KEY.slice(2)),false);assert.throws(()=>reserveQuoteImport(f.options),/ALREADY_RESERVED/);
 const status=inspectQuoteImport(f.options);const expected={'intent-durable':'reserved-no-challenge','challenge-durable':'reserved-no-key','key-staged':'uncertain-staged-key','key-published':'uncertain-publication-link','key-finalized':'installed-receipt-missing','receipt-durable':'installed'}[point];assert.equal(status.state,expected);assert.equal(status.mayAutomaticallyImport,false);if(['key-published','key-finalized'].includes(point))assert.equal(status.address,new Wallet(PUBLIC_KEY).address);
});
