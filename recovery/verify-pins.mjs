import { readFileSync,lstatSync,realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve,join } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { recoverySourceManifest } from '../src/recovery-r1-policy.mjs';
import pins from './pins.json' with {type:'json'};
import preserved from './original-record-pins.json' with {type:'json'};
const root=fileURLToPath(new URL('../',import.meta.url)),workspace=fileURLToPath(new URL('../../',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const fail=()=>{throw Object.assign(Error('R1_SOURCE_OR_RECORD_PIN'),{code:'R1_SOURCE_OR_RECORD_PIN'});};
function bytes(path){const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||realpathSync(path)!==path)fail();return readFileSync(path);}
function verifyManifest(base,name,expected){
 const b=bytes(join(base,name));if(sha(b)!==expected)fail();const m=JSON.parse(b);if(!Array.isArray(m.files)||!m.files.length)fail();
 const seen=new Set();for(const f of m.files){const p=resolve(base,f.path);if(!p.startsWith(base)||seen.has(p)||sha(bytes(p))!==f.sha256)fail();seen.add(p);}return m;
}
export function verifyLaunchPins(){try{
 const m=verifyManifest(root,'SOURCE-MANIFEST.json',recoverySourceManifest());if(m.version!==pins.candidateVersion)fail();
 verifyManifest(join(workspace,'mote-custody-handoff-candidate-v0722/'),'SOURCE-MANIFEST.json','dda14cb68b44cd332d7166e786c90decf8a75295c07d26ee025785da70c084ca');
 verifyManifest(join(workspace,'mote-launch-control-v073/'),'CONTROLLER-SOURCE-MANIFEST.json','915305c68c9e5f433eae74885ce1ef8f4c70768e5d581b2d5447a260f47c9f34');
 verifyManifest(join(workspace,'mote-fresh-custody-candidate-v073/'),'SOURCE-MANIFEST.json',pins.overlayManifestSha256);
 const helper=join(workspace,'mote-fresh-custody-candidate-v073/helper');if(sha(bytes(helper))!==pins.helperSha256||(lstatSync(helper).mode&0o777)!==0o700)fail();
 if(sha(bytes(join(root,'docs/SIGNER-EIGHT-TRANSACTIONS.json')))!==pins.eightTransactionManifestSha256)fail();
 for(const f of pins.quarantineFiles)if(sha(bytes(join(workspace,f.path)))!==f.sha256)fail();
 return{sourceManifestSha256:recoverySourceManifest(),sourceFiles:m.files.length,nativeExecuted:false};
}catch{fail();}}
/** No SQLite connection: inspect/hash existing bytes without changing WAL/SHM. */
export function verifyOriginalRecoveryState(){try{for(const f of preserved.files){const p=resolve(workspace,f.path);if(!p.startsWith(workspace)||sha(bytes(p))!==f.sha256)fail();}return{originalRecordsUnchanged:true,files:preserved.files.length};}catch{fail();}}
export function verifyProvisionedRoles({operator,quoteSigner}){
 verifyOriginalRecoveryState();
 for(const [role,address] of [['bootstrap',operator],['quote-backup',quoteSigner]]){
  const v=JSON.parse(bytes(join(workspace,'mote-launch-control-v073/provisioning',role,'verified.json')));
  if(v.identity.address.toLowerCase()!==address.toLowerCase()||v.created!==true||v.readbackVerified!==true||v.identityRecorded!==true)fail();
 }
 return{operator,quoteSigner,readbackVerified:true};
}
export function verifyNativePrerequisites(){
 try{if(process.platform!=='darwin')fail();const p=join(homedir(),'Library/Keychains/login.keychain-db'),s=lstatSync(p);
 if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||realpathSync(p)!==p||(s.mode&0o077)!==0)fail();
 return{metadataCompatible:true,keychainContentsRead:false};
 }catch{throw Object.assign(Error('LAUNCH_NATIVE_PREREQUISITE'),{code:'LAUNCH_NATIVE_PREREQUISITE'});}
}
