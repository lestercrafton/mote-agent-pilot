import { constants, openSync, closeSync, fstatSync, lstatSync, realpathSync, readFileSync, writeFileSync, fsyncSync, mkdirSync, linkSync, unlinkSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Wallet, hexlify } from 'ethers';
import { parseJson } from './json.mjs';
import { validateTestnetChainConfig } from './testnet-chain.mjs';
import { QUOTE_HANDOFF_ACTIVATION, QUOTE_HANDOFF_FIXTURE_ACK, validateFileHandoffDestination, hashFileHandoffChallenge } from './quote-key-envelope.mjs';

export const QUOTE_FILE_ROOT = '/var/data/mote-sepolia-quote';
export const QUOTE_FILE_ENVIRONMENT_KEY = 'MOTE_ETHEREUM_SEPOLIA_QUOTE_PRIVATE_KEY';
const FIXTURE_KEY = Buffer.from('00'.repeat(31)+'01','hex');
const FILES = Object.freeze({intent:'intent.json',challenge:'challenge.json',pending:'.quote-key.pending',key:'quote.key',receipt:'receipt.json'});
const fail = code => { const e=new Error(code);e.code=code;throw e; };
const check=(ok,code='QUOTE_FILE_INVALID_REQUEST')=>{if(!ok)fail(code);};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value)+'\n';
const exact=(value,keys)=>check(value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k)),'QUOTE_FILE_CORRUPT');
function safe(fn,code='QUOTE_FILE_STORAGE_UNAVAILABLE'){try{return fn();}catch(e){if(/^QUOTE_FILE_[A-Z_]+$/.test(e?.code??''))throw e;fail(code);}}
function sameFile(a,b){return a.dev===b.dev&&a.ino===b.ino;}
function missing(path){try{lstatSync(path);return false;}catch(e){if(e.code==='ENOENT')return true;fail('QUOTE_FILE_STORAGE_UNAVAILABLE');}}
function directory(path,{privateDirectory=false}={}){
 const st=lstatSync(path);check(st.isDirectory()&&!st.isSymbolicLink()&&realpathSync(path)===path,'QUOTE_FILE_UNSAFE_PATH');
 check(privateDirectory?st.uid===process.getuid()&&(st.mode&0o777)===0o700:(st.uid===process.getuid()||st.uid===0)&&(st.mode&0o022)===0,'QUOTE_FILE_UNSAFE_PERMISSIONS');return st;
}
function parents(root,fixture){
 if(fixture){const parent=dirname(root);directory(parent,{privateDirectory:true});check(parent.startsWith(realpathSync(tmpdir())+'/'),'QUOTE_FILE_FIXTURE_SCOPE');return;}
 for(let p=dirname(root);;p=dirname(p)){directory(p);if(p==='/')break;}
}
function syncDirectory(path){const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
function readOwned(path,limit,{allowPendingLink=false}={}){
 return safe(()=>{const before=lstatSync(path);check(before.isFile()&&!before.isSymbolicLink()&&before.uid===process.getuid()&&(before.mode&0o777)===0o600&&(before.nlink===1||(allowPendingLink&&before.nlink===2))&&before.size<=limit,'QUOTE_FILE_UNSAFE_FILE');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const st=fstatSync(fd);check(sameFile(before,st)&&st.size===before.size&&st.nlink===before.nlink&&st.uid===before.uid&&st.mode===before.mode,'QUOTE_FILE_CHANGED');return readFileSync(fd);}finally{closeSync(fd);}});
}
function writeNew(root,name,bytes){
 return safe(()=>{const fd=openSync(join(root,name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}syncDirectory(root);});
}
function parseOwned(root,name,limit=16384){let b;try{b=readOwned(join(root,name),limit);return parseJson(b.toString('utf8'));}catch{fail('QUOTE_FILE_CORRUPT');}finally{b?.fill(0);}}
function binding(options){
 check(options&&Object.getPrototypeOf(options)===Object.prototype);
 check(Object.keys(options).every(k=>['destination','activation','env','fixtureRoot','fixtureAcknowledgement','fixtureConfiguration','onCheckpoint'].includes(k)),'QUOTE_FILE_INVALID_REQUEST');
 const destination=validateFileHandoffDestination(options.destination);
 check(options.activation===QUOTE_HANDOFF_ACTIVATION,'QUOTE_FILE_ACTIVATION_REQUIRED');
 const fixture=options.fixtureAcknowledgement===QUOTE_HANDOFF_FIXTURE_ACK;
 check(fixture||options.fixtureAcknowledgement===undefined,'QUOTE_FILE_FIXTURE_SCOPE');
 let root=QUOTE_FILE_ROOT;
 if(fixture){check(typeof options.fixtureRoot==='string'&&resolve(options.fixtureRoot)===options.fixtureRoot,'QUOTE_FILE_FIXTURE_SCOPE');root=options.fixtureRoot;check(destination.quoteSigner.toLowerCase()===new Wallet(hexlify(FIXTURE_KEY)).address.toLowerCase(),'QUOTE_FILE_FIXTURE_SCOPE');}
 else{check(options.fixtureRoot===undefined&&options.fixtureConfiguration===undefined&&options.onCheckpoint===undefined,'QUOTE_FILE_FIXTURE_SCOPE');check(process.platform==='linux'&&!process.env.NODE_TEST_CONTEXT,'QUOTE_FILE_RENDER_RUNTIME_REQUIRED');}
 const env=Object.freeze({...options.env});
 check(env.RENDER==='true'&&env.RENDER_SERVICE_ID===destination.serviceId&&env.RENDER_EXTERNAL_URL===destination.origin&&env.RENDER_GIT_COMMIT===destination.sourceCommit&&env.IS_PULL_REQUEST!=='true','QUOTE_FILE_RENDER_IDENTITY_MISMATCH');
 check(['ethereum-sepolia-setup','ethereum-sepolia-public-synthetic-test'].includes(env.MOTE_MODE)&&(!env.MOTE_PUBLIC_ORIGIN||env.MOTE_PUBLIC_ORIGIN===destination.origin)&&(!env.MOTE_CONFIG_HASH||env.MOTE_CONFIG_HASH===destination.configHash)&&(!env.MOTE_CHAIN_CONFIG||env.MOTE_CHAIN_CONFIG==='/var/data/deployment.json'),'QUOTE_FILE_CONFIGURATION_MISMATCH');
 check(!Object.entries(env).some(([k,v])=>v&&/PRIVATE_?KEY|MNEMONIC|SEED_PHRASE|DEPLOYER_KEY|WALLET_KEY/i.test(k)),'QUOTE_FILE_ENVIRONMENT_AUTHORITY_FORBIDDEN');
 parents(root,fixture);
 return Object.freeze({destination,env,root,fixture,fixtureConfiguration:options.fixtureConfiguration,onCheckpoint:fixture&&typeof options.onCheckpoint==='function'?options.onCheckpoint:()=>{}});
}
function configuration(bound){
 const {destination,env}=bound;let config;
 if(bound.fixture){config=bound.fixtureConfiguration;check(config&&config.fixtureOnly===true&&config.chainId===11155111&&config.origin===destination.origin&&config.configHash===destination.configHash&&config.roles?.quoteSigner?.toLowerCase()===destination.quoteSigner.toLowerCase(),'QUOTE_FILE_CONFIGURATION_MISMATCH');}
 else{
  let b;try{b=readOwned('/var/data/deployment.json',131072);config=validateTestnetChainConfig(parseJson(b.toString('utf8')),destination.configHash);}catch{fail('QUOTE_FILE_CONFIGURATION_MISMATCH');}finally{b?.fill(0);}
  check(config.mode==='ethereum-sepolia'&&config.chainId===11155111&&config.origin===destination.origin&&config.roles.quoteSigner.toLowerCase()===destination.quoteSigner.toLowerCase(),'QUOTE_FILE_CONFIGURATION_MISMATCH');
 }
 check(['deployer','initialHolder','merchant'].every(k=>typeof config.roles[k]==='string'&&config.roles[k].toLowerCase()!==destination.quoteSigner.toLowerCase()),'QUOTE_FILE_ROLE_CONFLICT');
 return config;
}
function intentFor(bound){return {protocol:'mote-quote-file-import-intent-v1',destination:bound.destination,destinationHash:bound.destination.destinationHash,attemptId:hash(Buffer.from(json(bound.destination)))};}
function inspectBound(bound){
 const {root,destination}=bound;
 if(missing(root))return {state:'absent',destinationHash:destination.destinationHash,mayAutomaticallyImport:false};
 directory(root,{privateDirectory:true});
 const names=readdirSync(root).sort();check(names.every(n=>Object.values(FILES).includes(n)),'QUOTE_FILE_UNEXPECTED_CONTENT');
 if(!names.includes(FILES.intent))return {state:'uncertain-missing-intent',destinationHash:destination.destinationHash,mayAutomaticallyImport:false};
 check(!names.includes(FILES.receipt)||(names.includes(FILES.key)&&names.includes(FILES.challenge)&&!names.includes(FILES.pending)),'QUOTE_FILE_CORRUPT');
 check(names.includes(FILES.challenge)||(!names.includes(FILES.key)&&!names.includes(FILES.pending)),'QUOTE_FILE_CORRUPT');
 const intent=parseOwned(root,FILES.intent);check(json(intent)===json(intentFor(bound)),'QUOTE_FILE_IDENTITY_MISMATCH');
 if(!names.includes(FILES.challenge))return {state:'reserved-no-challenge',destinationHash:destination.destinationHash,mayAutomaticallyImport:false};
 const challengeRecord=parseOwned(root,FILES.challenge);exact(challengeRecord,['protocol','destinationHash','challengeHash','challenge']);
 check(challengeRecord.protocol==='mote-quote-file-challenge-v1'&&challengeRecord.destinationHash===destination.destinationHash&&challengeRecord.challengeHash===hashFileHandoffChallenge(challengeRecord.challenge)&&challengeRecord.challenge.destination?.destinationHash===destination.destinationHash,'QUOTE_FILE_IDENTITY_MISMATCH');
 if(!names.includes(FILES.key))return {state:names.includes(FILES.pending)?'uncertain-staged-key':'reserved-no-key',destinationHash:destination.destinationHash,challengeHash:challengeRecord.challengeHash,mayAutomaticallyImport:false};
 let bytes;let address;const pendingLink=names.includes(FILES.pending);
 if(pendingLink){const staged=lstatSync(join(root,FILES.pending)),published=lstatSync(join(root,FILES.key));check(staged.isFile()&&!staged.isSymbolicLink()&&sameFile(staged,published)&&staged.nlink===2,'QUOTE_FILE_UNSAFE_FILE');}
 try{bytes=readOwned(join(root,FILES.key),32,{allowPendingLink:pendingLink});check(bytes.length===32,'QUOTE_FILE_CORRUPT');if(bound.fixture)check(bytes.equals(FIXTURE_KEY),'QUOTE_FILE_FIXTURE_SCOPE');address=new Wallet(hexlify(bytes)).address;check(address.toLowerCase()===destination.quoteSigner.toLowerCase(),'QUOTE_FILE_SIGNER_MISMATCH');}
 catch(e){if(/^QUOTE_FILE_[A-Z_]+$/.test(e?.code??''))throw e;fail('QUOTE_FILE_CORRUPT');}finally{bytes?.fill(0);}
 if(!names.includes(FILES.receipt))return {state:pendingLink?'uncertain-publication-link':'installed-receipt-missing',destinationHash:destination.destinationHash,challengeHash:challengeRecord.challengeHash,address,mayAutomaticallyImport:false};
 const receipt=parseOwned(root,FILES.receipt);exact(receipt,['protocol','destinationHash','challengeHash','address','installed']);
 check(receipt.protocol==='mote-quote-file-import-receipt-v1'&&receipt.destinationHash===destination.destinationHash&&receipt.challengeHash===challengeRecord.challengeHash&&receipt.address===address&&receipt.installed===true&&!names.includes(FILES.pending),'QUOTE_FILE_CORRUPT');
 return {state:'installed',...receipt,mayAutomaticallyImport:false};
}
export function inspectQuoteImport(options){return safe(()=>{const bound=binding(options);configuration(bound);return Object.freeze(inspectBound(bound));});}
export function reserveQuoteImport(options){
 return safe(()=>{const bound=binding(options);configuration(bound);const {root,destination}=bound;
  check(missing(root),'QUOTE_FILE_IMPORT_ALREADY_RESERVED');mkdirSync(root,{mode:0o700});syncDirectory(dirname(root));const rootIdentity=directory(root,{privateDirectory:true});
  const checkRoot=()=>check(sameFile(rootIdentity,directory(root,{privateDirectory:true})),'QUOTE_FILE_CHANGED');
  writeNew(root,FILES.intent,Buffer.from(json(intentFor(bound))));bound.onCheckpoint('intent-durable');let used=false,challengeHash;
  const bindChallenge=challenge=>safe(()=>{checkRoot();check(!used&&!challengeHash,'QUOTE_FILE_ATTEMPT_CONSUMED');check(challenge.destination?.destinationHash===destination.destinationHash,'QUOTE_FILE_IDENTITY_MISMATCH');challengeHash=hashFileHandoffChallenge(challenge);writeNew(root,FILES.challenge,Buffer.from(json({protocol:'mote-quote-file-challenge-v1',destinationHash:destination.destinationHash,challengeHash,challenge})));bound.onCheckpoint('challenge-durable');return challengeHash;});
  const commit=bytes=>{
   try{check(!used&&challengeHash,'QUOTE_FILE_ATTEMPT_CONSUMED');used=true;check(bytes instanceof Uint8Array&&bytes.length===32,'QUOTE_FILE_INVALID_KEY');if(bound.fixture)check(Buffer.from(bytes).equals(FIXTURE_KEY),'QUOTE_FILE_FIXTURE_SCOPE');check(new Wallet(hexlify(bytes)).address.toLowerCase()===destination.quoteSigner.toLowerCase(),'QUOTE_FILE_SIGNER_MISMATCH');
    checkRoot();check(inspectBound(bound).state==='reserved-no-key','QUOTE_FILE_IMPORT_ALREADY_RESERVED');writeNew(root,FILES.pending,bytes);bound.onCheckpoint('key-staged');
    checkRoot();linkSync(join(root,FILES.pending),join(root,FILES.key));syncDirectory(root);bound.onCheckpoint('key-published');
    checkRoot();unlinkSync(join(root,FILES.pending));syncDirectory(root);bound.onCheckpoint('key-finalized');
    checkRoot();const receipt={protocol:'mote-quote-file-import-receipt-v1',destinationHash:destination.destinationHash,challengeHash,address:new Wallet(hexlify(bytes)).address,installed:true};writeNew(root,FILES.receipt,Buffer.from(json(receipt)));bound.onCheckpoint('receipt-durable');return Object.freeze(receipt);
   }catch(e){if(e?.code==='QUOTE_FILE_ATTEMPT_CONSUMED')fail('QUOTE_FILE_ATTEMPT_CONSUMED');fail('QUOTE_FILE_IMPORT_OUTCOME_UNKNOWN');}finally{bytes?.fill?.(0);}
  };
  return Object.freeze({destination,bindChallenge,commit,close(){used=true;},inspect:()=>Object.freeze(inspectBound(bound))});
 });
}
/** Validate public configuration first; never assign process.env or spawn a child.
 * The callback remains trusted and must not log/copy the ephemeral key string. */
export async function withQuoteFileEnvironment(options,callback){
 let bytes,env;
 try{const bound=safe(()=>binding(options));check(bound.env.MOTE_MODE==='ethereum-sepolia-public-synthetic-test'&&bound.env.MOTE_PUBLIC_ORIGIN===bound.destination.origin&&bound.env.MOTE_CONFIG_HASH===bound.destination.configHash&&bound.env.MOTE_CHAIN_CONFIG==='/var/data/deployment.json','QUOTE_FILE_CONFIGURATION_MISMATCH');safe(()=>configuration(bound));const state=safe(()=>inspectBound(bound));check(state.state==='installed','QUOTE_FILE_INSTALLATION_INCOMPLETE');
  bytes=readOwned(join(bound.root,FILES.key),32);check(bytes.length===32&&new Wallet(hexlify(bytes)).address.toLowerCase()===bound.destination.quoteSigner.toLowerCase(),'QUOTE_FILE_SIGNER_MISMATCH');
  env={...bound.env,[QUOTE_FILE_ENVIRONMENT_KEY]:hexlify(bytes)};return await callback(env);
 }catch{fail('QUOTE_FILE_STARTUP_FAILED');}finally{bytes?.fill(0);if(env)delete env[QUOTE_FILE_ENVIRONMENT_KEY];}
}
