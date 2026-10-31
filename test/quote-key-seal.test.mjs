import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createFixtureCustody, sealKeychainQuoteForImport, KEYCHAIN_ACTIVATION } from '../src/keychain-custody.mjs';
import { quoteSealArguments } from '../scripts/quote-key-seal.mjs';
import { describeFileHandoffDestination, createReceiverSession, hashFileHandoffChallenge, QUOTE_HANDOFF_FIXTURE_ACK } from '../src/quote-key-envelope.mjs';

// Deliberately public scalar1 wallet and fixed transport fixtures only.
const NOW=2_000_000_000_000;
const destination=describeFileHandoffDestination({serviceId:'srv-dbijuvou01pc73d59c30',origin:'https://mote-testnet-pilot.onrender.com',configHash:'0x'+'34'.repeat(32),quoteSigner:'0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',sourceCommit:'56'.repeat(20)});
const keyPairFactory=()=>{const privateKey=createPrivateKey({key:Buffer.from('302e020100300506032b656e04220420'+'11'.repeat(32),'hex'),format:'der',type:'pkcs8'});return{privateKey,publicKey:createPublicKey(privateKey)};};
function setup(t){
 const custody=createFixtureCustody({acknowledgement:'PUBLIC_FIXTURE_BYTES_ONLY_NO_KEYCHAIN',role:'quote-backup'});custody.provision();t.after(()=>custody.destroy());
 const receiver=createReceiverSession({destination,fixtureAcknowledgement:QUOTE_HANDOFF_FIXTURE_ACK,keyPairFactory,randomBytesFactory:n=>Buffer.alloc(n,3),now:()=>NOW});t.after(()=>receiver.close());
 const options={challenge:receiver.challenge,expectedDestinationHash:destination.destinationHash,expectedChallengeHash:hashFileHandoffChallenge(receiver.challenge),now:()=>NOW,keyPairFactory,randomBytesFactory:n=>Buffer.alloc(n,4)};
 return{custody,receiver,options};
}
test('Mac fixture bridge reads only approved quote role and returns ciphertext capsule',async t=>{
 const{custody,receiver,options}=setup(t);const capsule=await custody.sealQuoteForImport(options);
 assert.equal(custody.readCount,1);assert.equal(capsule.privateKey,undefined);
 const plain=receiver.open(capsule);assert.equal(plain.toString('hex'),'00'.repeat(31)+'01');plain.fill(0);
 const output=JSON.stringify(capsule);assert(!output.includes('00'.repeat(31)+'01'));assert(!output.includes(Buffer.from('00'.repeat(31)+'01','hex').toString('base64')));
});
test('wrong independent destination/challenge pins and expiry fail before custody read',async t=>{
 const{custody,options}=setup(t);
 for(const patch of [{expectedDestinationHash:'00'.repeat(32)},{expectedChallengeHash:'00'.repeat(32)},{expectedChallengeHash:undefined},{now:()=>NOW+120000}])await assert.rejects(custody.sealQuoteForImport({...options,...patch}));
 assert.equal(custody.readCount,0);
});
test('caller mutation after invocation cannot redirect pending custody handoff',async t=>{
 const{custody,receiver,options}=setup(t);const mutable={...options,challenge:structuredClone(options.challenge)};
 const pending=custody.sealQuoteForImport(mutable);mutable.challenge.destination.origin='https://evil.example';mutable.expectedChallengeHash='00'.repeat(32);mutable.keyPairFactory=()=>{throw Error('CHANGED');};
 const plain=receiver.open(await pending);assert.equal(plain.at(-1),1);plain.fill(0);
});
test('expired challenge across private read cannot produce capsule',async t=>{
 const{custody,options}=setup(t);let reads=0;
 await assert.rejects(custody.sealQuoteForImport({...options,now:()=>++reads===1?NOW:NOW+120000}),/HANDOFF_EXPIRED/);
 assert.equal(custody.readCount,1);
});
test('factory diagnostic is redacted after private read',async t=>{
 const{custody,options}=setup(t);
 await assert.rejects(custody.sealQuoteForImport({...options,keyPairFactory:()=>{throw Error('PRIVATE_FACTORY_DETAIL');}}),e=>e.message==='HANDOFF_INVALID'&&!e.cause);
 assert.equal(custody.readCount,1);
});
test('native bridge cannot activate under tests or accept absent activation',async t=>{
 const {options}=setup(t);
 const request={role:'quote-backup',chainId:11155111,challenge:options.challenge,expectedDestinationHash:options.expectedDestinationHash,expectedChallengeHash:options.expectedChallengeHash};
 // Valid real-clock public challenge is needed to reach the activation gate.
 const challenge={...request.challenge,issuedAt:Date.now(),expiresAt:Date.now()+120000};
 request.challenge=challenge;request.expectedChallengeHash=hashFileHandoffChallenge(challenge);
 await assert.rejects(sealKeychainQuoteForImport(request),/NATIVE_ACTIVATION_REQUIRED/);
 await assert.rejects(sealKeychainQuoteForImport({...request,activation:KEYCHAIN_ACTIVATION}),/NATIVE_FORBIDDEN_IN_TEST|MACOS_REQUIRED/);
});
test('seal CLI accepts only explicit activation and four public pins',()=>{
 const args=['--activate-native-keychain-v1','--helper','/public/helper','--helper-sha256','11'.repeat(32),'--destination-hash','22'.repeat(32),'--challenge-hash','33'.repeat(32)];
 const parsed=quoteSealArguments(args);assert.equal(parsed.role,'quote-backup');assert(Object.isFrozen(parsed));
 for(const bad of [[],args.slice(1),[...args,'secret'],args.map((s,i)=>i===2?'relative':s),args.map((s,i)=>i===6?'not-hash':s)])assert.throws(()=>quoteSealArguments(bad),/SEAL_ARGUMENTS/);
 const child=spawnSync(process.execPath,['scripts/quote-key-seal.mjs','--not-authorized','PRIVATE_ARGUMENT_CANARY'],{cwd:new URL('..',import.meta.url),encoding:'utf8',input:'PRIVATE_INPUT_CANARY',env:{PATH:process.env.PATH,NODE_TEST_CONTEXT:'child-v8'}});
 assert.equal(child.status,1);assert.equal(child.stdout,'');assert.equal(child.stderr,'{"error":"QUOTE_SEAL_FAILED_CLOSED"}\n');
});
