import test from 'node:test';
import A from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,readFileSync,renameSync,symlinkSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPrivateKey,createPublicKey} from 'node:crypto';
import {Wallet} from 'ethers';
import {describeFileHandoffDestination,createReceiverSession,QUOTE_HANDOFF_ACTIVATION,QUOTE_HANDOFF_FIXTURE_ACK} from '../legacy/src/quote-key-envelope.mjs';
import {reserveQuoteImport,inspectQuoteImport,withQuoteFileEnvironment as oldRead,QUOTE_FILE_ENVIRONMENT_KEY} from '../legacy/src/quote-key-file.mjs';
import {withQuoteFileEnvironment as transitionedRead} from '../src/legacy-quote-key-file-transition.mjs';
import {LEGACY_COMMIT,RELEASE_SERVICE,RELEASE_ORIGIN} from '../src/release-binding.mjs';
import {hashJson} from '../src/core/json.mjs';
const key='0x'+'00'.repeat(31)+'01';
function installed(t){
 const base=realpathSync(mkdtempSync(join(tmpdir(),'mote-transition-fixture-')));t.after(()=>rmSync(base,{recursive:true,force:true}));
 const destination=describeFileHandoffDestination({serviceId:RELEASE_SERVICE,origin:RELEASE_ORIGIN,configHash:'0x'+'11'.repeat(32),quoteSigner:new Wallet(key).address,sourceCommit:LEGACY_COMMIT});
 const env={RENDER:'true',RENDER_SERVICE_ID:RELEASE_SERVICE,RENDER_EXTERNAL_URL:RELEASE_ORIGIN,RENDER_GIT_COMMIT:LEGACY_COMMIT,MOTE_MODE:'ethereum-sepolia-public-synthetic-test',MOTE_PUBLIC_ORIGIN:RELEASE_ORIGIN,MOTE_CONFIG_HASH:destination.configHash,MOTE_CHAIN_CONFIG:'/var/data/deployment.json'};
 const options={destination,env,activation:QUOTE_HANDOFF_ACTIVATION,fixtureRoot:join(base,'quote'),fixtureAcknowledgement:QUOTE_HANDOFF_FIXTURE_ACK,fixtureConfiguration:{fixtureOnly:true,chainId:11155111,origin:RELEASE_ORIGIN,configHash:destination.configHash,roles:{quoteSigner:destination.quoteSigner,deployer:'0x'+'33'.repeat(20),initialHolder:'0x'+'33'.repeat(20),merchant:'0x'+'33'.repeat(20)}}};
 const receiver=createReceiverSession({destination,now:()=>2e12,keyPairFactory:()=>{const privateKey=createPrivateKey({key:Buffer.from('302e020100300506032b656e04220420'+'11'.repeat(32),'hex'),format:'der',type:'pkcs8'});return {privateKey,publicKey:createPublicKey(privateKey)};},randomBytesFactory:n=>Buffer.alloc(n,7),fixtureAcknowledgement:QUOTE_HANDOFF_FIXTURE_ACK});
 const reservation=reserveQuoteImport(options);reservation.bindChallenge(receiver.challenge);reservation.commit(Buffer.from(key.slice(2),'hex'));receiver.close();
 const r={format:'mote-explicit-source-transition-v1',serviceId:RELEASE_SERVICE,origin:RELEASE_ORIGIN,fromCommit:LEGACY_COMMIT,toCommit:'aa'.repeat(20),legacyDestinationHash:destination.destinationHash,artifactHash:'bb'.repeat(32)};
 const transitioned={...options,sourceTransition:r,env:{...env,RENDER_GIT_COMMIT:r.toCommit,MOTE_RELEASE_TRANSITION_HASH:hashJson(r),MOTE_SOURCE_ARTIFACT_HASH:r.artifactHash}};
 return {base,options,transitioned};
}
test('explicit source transition leaves original imported fixture bytes and actual source identity intact',async t=>{
 const f=installed(t),names=['intent.json','challenge.json','quote.key','receipt.json'],before=names.map(n=>readFileSync(join(f.options.fixtureRoot,n)));
 await transitionedRead(f.transitioned,async env=>{A.equal(env.RENDER_GIT_COMMIT,f.transitioned.sourceTransition.toCommit);A.equal(env[QUOTE_FILE_ENVIRONMENT_KEY],key);});
 names.forEach((n,i)=>A.deepEqual(readFileSync(join(f.options.fixtureRoot,n)),before[i]));A.equal(inspectQuoteImport(f.options).state,'installed');
 await A.rejects(oldRead({...f.options,env:f.transitioned.env},()=>A.fail('old binding must reject new source')));
});
for(const kind of ['hash','commit','destination','permissions','symlink'])test(`transition rejects ${kind} conflict before signer callback`,async t=>{
 const f=installed(t),o=f.transitioned;
 if(kind==='hash')o.env.MOTE_RELEASE_TRANSITION_HASH='00'.repeat(32);
 if(kind==='commit')o.env.RENDER_GIT_COMMIT=LEGACY_COMMIT;
 if(kind==='destination'){o.sourceTransition={...o.sourceTransition,legacyDestinationHash:'00'.repeat(32)};o.env.MOTE_RELEASE_TRANSITION_HASH=hashJson(o.sourceTransition);}
 if(kind==='permissions')chmodSync(f.base,0o770);
 if(kind==='symlink'){renameSync(join(o.fixtureRoot,'quote.key'),join(f.base,'moved'));symlinkSync(join(f.base,'moved'),join(o.fixtureRoot,'quote.key'));}
 await A.rejects(transitionedRead(o,()=>A.fail('must not expose signer')));if(kind==='permissions')chmodSync(f.base,0o700);
});
test('transition fork changes only imports, explicit source authorization and fixture argument',()=>{
 let expected=readFileSync(new URL('../legacy/src/quote-key-file.mjs',import.meta.url),'utf8').replaceAll("from './","from '../legacy/src/");
 expected="// Explicit transition fork; immutable original remains in legacy/src/quote-key-file.mjs.\nimport {authorizeLegacySource} from './release-binding.mjs';\n"+expected;
 expected=expected.replace("'fixtureConfiguration','onCheckpoint']","'fixtureConfiguration','onCheckpoint','sourceTransition']").replace("options.onCheckpoint===undefined,'QUOTE_FILE_FIXTURE_SCOPE'","options.onCheckpoint===undefined&&options.sourceTransition===undefined,'QUOTE_FILE_FIXTURE_SCOPE'").replace("check(env.RENDER==='true'&&env.RENDER_SERVICE_ID===destination.serviceId&&env.RENDER_EXTERNAL_URL===destination.origin&&env.RENDER_GIT_COMMIT===destination.sourceCommit&&env.IS_PULL_REQUEST!=='true','QUOTE_FILE_RENDER_IDENTITY_MISMATCH');","authorizeLegacySource(env,destination,fixture?options.sourceTransition:undefined);");
 A.equal(readFileSync(new URL('../src/legacy-quote-key-file-transition.mjs',import.meta.url),'utf8'),expected);
});
