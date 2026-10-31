import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { Wallet } from 'ethers';
import { describeFileHandoffDestination, QUOTE_HANDOFF_ACTIVATION, QUOTE_HANDOFF_FIXTURE_ACK } from '../src/quote-key-envelope.mjs';
import { createFixtureCustody } from '../src/keychain-custody.mjs';
import { inspectQuoteImport, reserveQuoteImport, withQuoteFileEnvironment, QUOTE_FILE_ENVIRONMENT_KEY } from '../src/quote-key-file.mjs';
import { runQuoteImport } from '../scripts/quote-key-import.mjs';
import { startFilePilotFromEnvironment } from '../scripts/testnet-file-server.mjs';

const PUBLIC_KEY='0x'+'00'.repeat(31)+'01',NOW=2_000_000_000_000;
const pair=n=>()=>{const privateKey=createPrivateKey({key:Buffer.from('302e020100300506032b656e04220420'+n.repeat(32),'hex'),format:'der',type:'pkcs8'});return{privateKey,publicKey:createPublicKey(privateKey)};};
function fixture(t){
 const base=realpathSync(mkdtempSync(join(tmpdir(),'mote-import-public-fixture-')));chmodSync(base,0o700);t.after(()=>rmSync(base,{recursive:true,force:true}));
 const destination=describeFileHandoffDestination({serviceId:'srv-dbijuvou01pc73d59c30',origin:'https://mote-testnet-pilot.onrender.com',configHash:'0x'+'11'.repeat(32),quoteSigner:new Wallet(PUBLIC_KEY).address,sourceCommit:'22'.repeat(20)});
 const env={RENDER:'true',RENDER_SERVICE_ID:destination.serviceId,RENDER_EXTERNAL_URL:destination.origin,RENDER_GIT_COMMIT:destination.sourceCommit,MOTE_MODE:'ethereum-sepolia-public-synthetic-test',MOTE_PUBLIC_ORIGIN:destination.origin,MOTE_CONFIG_HASH:destination.configHash,MOTE_CHAIN_CONFIG:'/var/data/deployment.json'};
 const fixtureConfiguration={fixtureOnly:true,chainId:11155111,origin:destination.origin,configHash:destination.configHash,roles:{quoteSigner:destination.quoteSigner,deployer:'0x'+'33'.repeat(20),initialHolder:'0x'+'33'.repeat(20),merchant:'0x'+'33'.repeat(20)}};
 const injected={fixtureRoot:join(base,'quote'),fixtureAcknowledgement:QUOTE_HANDOFF_FIXTURE_ACK,fixtureConfiguration,keyPairFactory:pair('11'),randomBytesFactory:n=>Buffer.alloc(n,7),now:()=>NOW};
 const options={destination,env,activation:QUOTE_HANDOFF_ACTIVATION,fixtureRoot:injected.fixtureRoot,fixtureAcknowledgement:QUOTE_HANDOFF_FIXTURE_ACK,fixtureConfiguration};
 const custody=createFixtureCustody({acknowledgement:'PUBLIC_FIXTURE_BYTES_ONLY_NO_KEYCHAIN',role:'quote-backup'});custody.provision();t.after(()=>custody.destroy());
 return {base,destination,env,injected,options,custody};
}
async function capsule(f,message){return f.custody.sealQuoteForImport({challenge:message.challenge,expectedDestinationHash:f.destination.destinationHash,expectedChallengeHash:message.challengeHash,now:()=>NOW,keyPairFactory:pair('22'),randomBytesFactory:n=>Buffer.alloc(n,9)});}
function session(f,{respond,operation='receive',destinationHash=f.destination.destinationHash,first=JSON.stringify(f.destination),failOutputAt=0,fixturePatch={},env=f.env}={}){
 const input=new PassThrough();let outputText='',writes=0,responseTask=Promise.resolve();
 const output=new Writable({write(chunk,_encoding,callback){writes++;if(writes===failOutputAt){callback(Error('PRIVATE_OUTPUT_DIAGNOSTIC'));return;}outputText+=chunk;const message=JSON.parse(chunk.toString());callback();if(message.status==='challenge')responseTask=Promise.resolve().then(()=>respond?respond(message,input):capsule(f,message).then(c=>input.end(JSON.stringify(c)+'\n')));}});
 const result=runQuoteImport({operation,destinationHash,activation:QUOTE_HANDOFF_ACTIVATION,env,input,output,fixture:{...f.injected,...fixturePatch}});input.write(first+'\n');
 return {result,input,output:()=>outputText,response:()=>responseTask};
}
function noLeaks(text){assert(!text.includes(PUBLIC_KEY));assert(!text.includes(PUBLIC_KEY.slice(2)));assert(!text.includes(Buffer.from(PUBLIC_KEY.slice(2),'hex').toString('base64')));assert(!text.includes('PRIVATE_OUTPUT_DIAGNOSTIC'));assert(!text.includes('PRIVATE_ARGUMENT_CANARY'));assert(!text.includes('PRIVATE_INPUT_CANARY'));assert(!/\n\s+at .*\.mjs/.test(text));}

test('complete mocked custody helper to encrypted capsule to disk to ephemeral file loader',async t=>{
 const f=fixture(t),s=session(f);const receipt=await s.result;await s.response();
 assert.equal(f.custody.readCount,1);assert.equal(receipt.address,new Wallet(PUBLIC_KEY).address);assert.equal(inspectQuoteImport(f.options).state,'installed');
 const messages=s.output().trim().split('\n').map(JSON.parse);assert.deepEqual(messages.map(m=>m.status),['challenge','installed']);noLeaks(s.output());
 let ephemeral;const before=process.env[QUOTE_FILE_ENVIRONMENT_KEY];const publicAddress=await withQuoteFileEnvironment(f.options,env=>{ephemeral=env;assert.equal(process.env[QUOTE_FILE_ENVIRONMENT_KEY],before);return new Wallet(env[QUOTE_FILE_ENVIRONMENT_KEY]).address;});assert.equal(publicAddress,receipt.address);assert.equal(Object.hasOwn(ephemeral,QUOTE_FILE_ENVIRONMENT_KEY),false);
 assert.throws(()=>reserveQuoteImport(f.options),/ALREADY_RESERVED/);
});
test('inspect emits only public recovery receipt and leaves files unchanged',async t=>{
 const f=fixture(t);await session(f).result;const before=readFileSync(join(f.injected.fixtureRoot,'receipt.json'));const s=session(f,{operation:'inspect'});const result=await s.result;s.input.end();assert.equal(result.state,'installed');assert.equal(result.mayAutomaticallyImport,false);assert.deepEqual(readFileSync(join(f.injected.fixtureRoot,'receipt.json')),before);assert.equal(f.custody.readCount,1);noLeaks(s.output());
});
test('wrong independent pin, unexpected descriptor field and oversized first line create no reservation',async t=>{
 for(const which of ['pin','extra-field','oversized','duplicate-key']){const f=fixture(t);const patch=which==='pin'?{destinationHash:'ff'.repeat(32)}:which==='extra-field'?{first:JSON.stringify({...f.destination,privateKey:'PRIVATE_INPUT_CANARY'})}:which==='oversized'?{first:'x'.repeat(8193)}:{first:'{"protocol":"a","protocol":"b"}'};const s=session(f,patch);await assert.rejects(s.result,e=>e.message==='QUOTE_IMPORT_FAILED_CLOSED'&&!e.cause);s.input.end();assert.equal(s.output(),'');assert.equal(existsSync(f.injected.fixtureRoot),false);assert.equal(f.custody.readCount,0);}
});
test('malformed, duplicate, oversized and extra-line capsule input retains reservation without reimport',async t=>{
 for(const data of ['PRIVATE_INPUT_CANARY','{"a":1,"a":2}','x'.repeat(8193),'{}\n{}']){const f=fixture(t);const s=session(f,{respond:(_message,input)=>input.end(data+'\n')});await assert.rejects(s.result,{code:'QUOTE_IMPORT_FAILED_CLOSED'});await s.response();assert.equal(inspectQuoteImport(f.options).state,'reserved-no-key');assert.throws(()=>reserveQuoteImport(f.options),/ALREADY_RESERVED/);assert.equal(f.custody.readCount,0);noLeaks(s.output());}
});
test('tampered encrypted capsule never writes plaintext and cannot be retried',async t=>{
 const f=fixture(t);const s=session(f,{respond:async(message,input)=>{const c=await capsule(f,message);input.end(JSON.stringify({...c,tag:Buffer.alloc(16).toString('base64')})+'\n');}});await assert.rejects(s.result,{code:'QUOTE_IMPORT_FAILED_CLOSED'});await s.response();assert.equal(inspectQuoteImport(f.options).state,'reserved-no-key');assert.equal(existsSync(join(f.injected.fixtureRoot,'quote.key')),false);assert.throws(()=>reserveQuoteImport(f.options),/ALREADY_RESERVED/);noLeaks(s.output());
});
test('receiver preparation failure reserves before challenge and never uses native fallback',async t=>{
 const f=fixture(t);const s=session(f,{fixturePatch:{keyPairFactory:()=>{throw Error('PRIVATE_OUTPUT_DIAGNOSTIC');}}});await assert.rejects(s.result,{code:'QUOTE_IMPORT_FAILED_CLOSED'});s.input.end();assert.equal(s.output(),'');assert.equal(inspectQuoteImport(f.options).state,'reserved-no-challenge');assert.throws(()=>reserveQuoteImport(f.options),/ALREADY_RESERVED/);assert.equal(f.custody.readCount,0);
});
test('challenge output failure retains attempt without a ciphertext read',async t=>{
 const f=fixture(t);const s=session(f,{failOutputAt:1});await assert.rejects(s.result,{code:'QUOTE_IMPORT_FAILED_CLOSED'});s.input.end();assert.equal(inspectQuoteImport(f.options).state,'reserved-no-key');assert.equal(f.custody.readCount,0);assert.equal(s.output(),'');
});
test('lost receipt output is recoverable read-only and never causes reimport',async t=>{
 const f=fixture(t);const s=session(f,{failOutputAt:2});await assert.rejects(s.result,{code:'QUOTE_IMPORT_FAILED_CLOSED'});await s.response();assert.equal(inspectQuoteImport(f.options).state,'installed');assert.equal(f.custody.readCount,1);assert.throws(()=>reserveQuoteImport(f.options),/ALREADY_RESERVED/);noLeaks(s.output());
});
test('env authority, source mismatch and fixture factories without ACK fail closed',async t=>{
 for(const patch of [{env:{...fixture(t).env,[QUOTE_FILE_ENVIRONMENT_KEY]:'PRIVATE_INPUT_CANARY'}},{fixturePatch:{fixtureAcknowledgement:undefined}},{env:{...fixture(t).env,RENDER_GIT_COMMIT:'66'.repeat(20)}}]){const f=fixture(t),s=session(f,patch);await assert.rejects(s.result,{code:'QUOTE_IMPORT_FAILED_CLOSED'});s.input.end();assert.equal(s.output(),'');assert.equal(existsSync(f.injected.fixtureRoot),false);}
});
test('production import and file-server CLI refuse unauthorized activation with fixed redacted stdout/stderr',async()=>{
 const cwd=new URL('../',import.meta.url),env={PATH:process.env.PATH,TMPDIR:tmpdir(),NODE_TEST_CONTEXT:'public-fixture-native-forbidden',NODE_NO_WARNINGS:'1'};
 for(const args of [['scripts/quote-key-import.mjs'],['scripts/quote-key-import.mjs','receive','PRIVATE_ARGUMENT_CANARY','00'.repeat(32)],['scripts/quote-key-import.mjs','receive',QUOTE_HANDOFF_ACTIVATION,'00'.repeat(32),'--fixture'],['scripts/testnet-file-server.mjs']]){const result=spawnSync(process.execPath,args,{cwd,env,input:'PRIVATE_INPUT_CANARY',encoding:'utf8'});assert.equal(result.status,1);assert.equal(result.stdout,'');assert.match(result.stderr,/^\{"error":"QUOTE_(?:IMPORT_FAILED_CLOSED","doNotAutomaticallyRetry":true|FILE_STARTUP_FAILED")\}\n$/);noLeaks(result.stdout+result.stderr);}
 await assert.rejects(startFilePilotFromEnvironment({MOTE_QUOTE_FILE_ACTIVATION:'wrong',MOTE_CHAIN_CONFIG:'/must-not-be-read'}),{code:'QUOTE_FILE_STARTUP_FAILED'});
});

// A separate process proves the actual stdin/stdout framing and fixed failure
// wrapper. The only key bytes in the child are public scalar1; no native CLI flag.
const childProgram=`import{runQuoteImport}from'./scripts/quote-key-import.mjs';import{QUOTE_HANDOFF_ACTIVATION,QUOTE_HANDOFF_FIXTURE_ACK}from'./src/quote-key-envelope.mjs';import{createPrivateKey,createPublicKey}from'node:crypto';const env={RENDER:'true',RENDER_SERVICE_ID:'srv-dbijuvou01pc73d59c30',RENDER_EXTERNAL_URL:'https://mote-testnet-pilot.onrender.com',RENDER_GIT_COMMIT:'22'.repeat(20),MOTE_MODE:'ethereum-sepolia-public-synthetic-test',MOTE_PUBLIC_ORIGIN:'https://mote-testnet-pilot.onrender.com',MOTE_CONFIG_HASH:'0x'+'11'.repeat(32),MOTE_CHAIN_CONFIG:'/var/data/deployment.json'};try{await runQuoteImport({operation:'receive',destinationHash:process.argv[2],activation:QUOTE_HANDOFF_ACTIVATION,env,input:process.stdin,output:process.stdout,fixture:{fixtureRoot:process.argv[1],fixtureAcknowledgement:QUOTE_HANDOFF_FIXTURE_ACK,fixtureConfiguration:{fixtureOnly:true,chainId:11155111,origin:env.MOTE_PUBLIC_ORIGIN,configHash:env.MOTE_CONFIG_HASH,roles:{quoteSigner:'0x7e5f4552091a69125d5dfcb7b8c2659029395bdf',deployer:'0x'+'33'.repeat(20),initialHolder:'0x'+'33'.repeat(20),merchant:'0x'+'33'.repeat(20)}},keyPairFactory:()=>{const privateKey=createPrivateKey({key:Buffer.from('302e020100300506032b656e04220420'+'11'.repeat(32),'hex'),format:'der',type:'pkcs8'});return{privateKey,publicKey:createPublicKey(privateKey)};},randomBytesFactory:n=>Buffer.alloc(n,7),now:()=>2000000000000}});}catch{process.stderr.write('{"error":"QUOTE_IMPORT_FAILED_CLOSED"}\\n');process.exitCode=1;}`;
test('subprocess fixture importer transcript contains only challenge, ciphertext-independent receipt and no key bytes',async t=>{
 const f=fixture(t),child=spawn(process.execPath,['--input-type=module','-e',childProgram,f.injected.fixtureRoot,f.destination.destinationHash],{cwd:new URL('../',import.meta.url),env:{PATH:process.env.PATH,TMPDIR:tmpdir(),NODE_NO_WARNINGS:'1'},stdio:['pipe','pipe','pipe']});t.after(()=>child.kill('SIGKILL'));let stdout='',stderr='',pending='',reply=Promise.resolve();
 child.stdout.on('data',chunk=>{stdout+=chunk;pending+=chunk;let index;while((index=pending.indexOf('\n'))>=0){const line=pending.slice(0,index);pending=pending.slice(index+1);const message=JSON.parse(line);if(message.status==='challenge')reply=capsule(f,message).then(c=>child.stdin.end(JSON.stringify(c)+'\n'));}});child.stderr.on('data',b=>stderr+=b);const timer=setTimeout(()=>child.kill('SIGKILL'),10000);t.after(()=>clearTimeout(timer));const exited=once(child,'exit');child.stdin.write(JSON.stringify(f.destination)+'\n');const[code,signal]=await exited;await reply;assert.equal(code,0,stderr);assert.equal(signal,null);assert.equal(stderr,'');assert.equal(stdout.trim().split('\n').length,2);noLeaks(stdout+stderr);assert.equal(inspectQuoteImport(f.options).state,'installed');assert.equal(f.custody.readCount,1);
});
test('two importer processes share exactly one durable reservation and never regenerate after failure',async t=>{
 const f=fixture(t);const children=Array.from({length:2},()=>spawn(process.execPath,['--input-type=module','-e',childProgram,f.injected.fixtureRoot,f.destination.destinationHash],{cwd:new URL('../',import.meta.url),env:{PATH:process.env.PATH,TMPDIR:tmpdir(),NODE_NO_WARNINGS:'1'},stdio:['pipe','pipe','pipe']}));
 const runs=children.map(child=>{let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);t.after(()=>child.kill('SIGKILL'));const timer=setTimeout(()=>child.kill('SIGKILL'),10000);t.after(()=>clearTimeout(timer));const done=once(child,'exit').then(([code,signal])=>({code,signal,stdout,stderr}));child.stdin.end(JSON.stringify(f.destination)+'\n');return done;});
 const results=await Promise.all(runs);assert.equal(results.filter(r=>r.stdout.includes('"status":"challenge"')).length,1);
 for(const result of results){assert.equal(result.code,1);assert.equal(result.signal,null);assert.equal(result.stderr,'{"error":"QUOTE_IMPORT_FAILED_CLOSED"}\n');noLeaks(result.stdout+result.stderr);}
 assert.equal(inspectQuoteImport(f.options).state,'reserved-no-key');assert.equal(existsSync(join(f.injected.fixtureRoot,'quote.key')),false);assert.throws(()=>reserveQuoteImport(f.options),/ALREADY_RESERVED/);assert.equal(f.custody.readCount,0);
});
