import { recoverySourceCommit, assertRecoveryTime } from '../src/recovery-r1-policy.mjs';
import { constants, mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, readFileSync, renameSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import pins from './pins.json' with {type:'json'};

export const ACTIVATION='MOTE_R1_RECOVERY_A_TO_E_EXPLICITLY_APPROVED';
const pendingCodes=new Set(['BOOTSTRAP_PENDING','BOOTSTRAP_NOT_FINALIZED']);
const fail=code=>{const e=new Error(code);e.code=code;throw e;};
const check=(ok,code)=>{if(!ok)fail(code);};
const cleanCode=e=>/^[A-Z][A-Z0-9_]{2,80}$/.test(e?.code??'')?e.code:'LAUNCH_FAILED_CLOSED';
const syncDir=p=>{const fd=openSync(p,constants.O_RDONLY|constants.O_DIRECTORY);try{fsyncSync(fd);}finally{closeSync(fd);}};
const writeNew=(path,value)=>{const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}syncDir(dirname(path));};

/** Adapter methods are trusted in-process dependencies, never supplied by CLI.
 * This controller stores PUBLIC stage metadata only. Existing core journals
 * retain exact spending authority. A preexisting session can never create P. */
export async function createLaunchController({directory,activation,descriptor,adapter}) {
 check(activation===ACTIVATION,'LAUNCH_ACTIVATION_REQUIRED');
 check(typeof directory==='string'&&resolve(directory)===directory&&realpathSync(dirname(directory))===dirname(directory),'LAUNCH_DIRECTORY');
 const parent=lstatSync(dirname(directory));check(parent.isDirectory()&&!parent.isSymbolicLink()&&parent.uid===process.getuid()&&(parent.mode&0o022)===0,'LAUNCH_DIRECTORY');
 check(descriptor&&Object.keys(descriptor).sort().join()==='manifestSha256,sourceCommit'&&/^[a-f0-9]{40}$/.test(descriptor.sourceCommit)&&/^[a-f0-9]{64}$/.test(descriptor.manifestSha256),'LAUNCH_DESCRIPTOR');
 const bound=Object.freeze(structuredClone(descriptor));
 check(bound.manifestSha256===pins.eightTransactionManifestSha256,'LAUNCH_MANIFEST_PIN');
 check(bound.sourceCommit===recoverySourceCommit(),'LAUNCH_DEPLOYED_SOURCE_PIN');
 check(adapter&&['initialize','bootstrapAdopt','bootstrapNext','bootstrapReconcile','bootstrapStatus','prepareConfiguration','checkHost','executeFixedJob','recoverFixedJob','close'].every(k=>typeof adapter[k]==='function'),'LAUNCH_ADAPTER');
 const api=Object.freeze(Object.fromEntries(Object.keys(adapter).filter(k=>typeof adapter[k]==='function').map(k=>[k,adapter[k].bind(adapter)])));
 // Exclusive directory exists before initialize is allowed to create memory P.
 try{mkdirSync(directory,{mode:0o700});syncDir(dirname(directory));}catch{fail('LAUNCH_SESSION_EXISTS_OR_UNAVAILABLE');}
 const stat=lstatSync(directory);check(stat.isDirectory()&&!stat.isSymbolicLink()&&stat.uid===process.getuid()&&(stat.mode&0o777)===0o700,'LAUNCH_DIRECTORY');
 let state={schema:'mote-launch-control-v1',descriptor:bound,phase:'initializing',publicContext:null,bootstrapFinalized:0,paidAttempted:false,lastCode:null};
 writeNew(join(directory,'state.json'),state);
 let busy=false,closed=false,storageFailed=false;
 const persist=()=>{try{writeNew(join(directory,'state.next.json'),state);renameSync(join(directory,'state.next.json'),join(directory,'state.json'));syncDir(directory);}catch{storageFailed=true;fail('LAUNCH_STORAGE_UNCERTAIN');}};
 const snapshot=()=>structuredClone(state);
 const update=(patch)=>{Object.assign(state,patch);persist();};
 const publicResult=result=>{
  check(result&&Object.keys(result).sort().join()==='amount,canonicalJson,quoteId,requestHash,resultHash,transactionHash,valid','LAUNCH_RESULT');
  check(result.amount==='4200'&&result.requestHash===pins.requestHash&&result.resultHash===pins.resultHash&&result.valid===true&&result.canonicalJson==='{"arguments":{"a":2,"b":3},"tool":"sum"}','LAUNCH_RESULT');
  for(const k of ['quoteId','transactionHash'])check(/^0x[a-f0-9]{64}$/.test(result[k]),'LAUNCH_RESULT');
  return structuredClone(result);
 };
 const publicRecovery=result=>{
  if(result&&Object.keys(result).sort().join()==='noTransactionsSubmitted,status'&&result.noTransactionsSubmitted===true&&['claim_finalized_no_payment','cancelled_before_submission'].includes(result.status))return structuredClone(result);
  return publicResult(result);
 };
 const safeStatus=status=>{
  check(status&&Array.isArray(status.steps)&&status.steps.length===5,'LAUNCH_BOOTSTRAP_EVIDENCE');
  const rows=status.steps.map((r,i)=>{check(r.index===i&&['pending','intent','signed','submitted','unknown','finalized','failed'].includes(r.state),'LAUNCH_BOOTSTRAP_EVIDENCE');return{index:i,state:r.state,transactionHash:r.transactionHash??null};});
  check(rows.every(r=>r.transactionHash===null||/^0x[a-f0-9]{64}$/.test(r.transactionHash)),'LAUNCH_BOOTSTRAP_EVIDENCE');
  const finalized=rows.filter(r=>r.state==='finalized').length;
  let nonFinal=false;for(const r of rows){if(nonFinal)check(r.state==='pending','LAUNCH_BOOTSTRAP_EVIDENCE');if(r.state!=='finalized')nonFinal=true;}
  return{steps:rows,finalized,complete:finalized===5};
 };
 const settled=status=>{const s=safeStatus(status);update({bootstrapFinalized:s.finalized,phase:s.complete?'bootstrap_complete':s.steps[s.finalized]?.state==='pending'?'bootstrap_ready':'bootstrap_wait',lastCode:null});return s;};
 try{const context=await api.initialize(directory);check(context&&Object.keys(context).sort().join()==='operator,payer,planHash,quoteSigner','LAUNCH_PUBLIC_CONTEXT');for(const k of ['operator','payer','quoteSigner'])check(/^0x[a-f0-9]{40}$/.test(context[k]),'LAUNCH_PUBLIC_CONTEXT');check(new Set([context.operator,context.payer,context.quoteSigner]).size===3&&/^0x[a-f0-9]{64}$/.test(context.planHash),'LAUNCH_PUBLIC_CONTEXT');update({publicContext:structuredClone(context),phase:'bootstrap_ready'});}
 catch(e){try{update({phase:'blocked',lastCode:cleanCode(e)});}catch{}try{await api.close();}catch{}fail(cleanCode(e));}
 const command=async(name)=>{
  check(!closed&&!storageFailed&&!busy,'LAUNCH_CLOSED_BUSY_OR_UNCERTAIN');
  check(['status','adopt_next','bootstrap_next','reconcile','prepare_configuration','check_host','paid_job','recover'].includes(name),'LAUNCH_COMMAND');busy=true;
  try{
   if(name==='status')return{state:snapshot(),bootstrap:safeStatus(api.bootstrapStatus())};
   if(name==='adopt_next'){
    assertRecoveryTime();
    check(state.phase==='bootstrap_ready'&&state.bootstrapFinalized<2,'LAUNCH_ADOPTION_PHASE');
    update({phase:'bootstrap_intent'});
    try{return{state:(settled(await api.bootstrapAdopt()),snapshot()),bootstrap:safeStatus(api.bootstrapStatus()),noTransactionsSubmitted:true};}
    catch(e){const b=safeStatus(api.bootstrapStatus());update({phase:b.steps[b.finalized]?.transactionHash?'bootstrap_wait':'blocked',lastCode:cleanCode(e)});return{state:snapshot(),bootstrap:b,error:cleanCode(e),noTransactionsSubmitted:true};}
   }
   if(name==='bootstrap_next'){
    assertRecoveryTime();check(state.bootstrapFinalized>=2,'LAUNCH_ADOPTION_REQUIRED');
    check(state.phase==='bootstrap_ready','LAUNCH_NO_NEW_BOOTSTRAP_AUTHORITY');
    const before=safeStatus(api.bootstrapStatus());check(before.finalized===state.bootstrapFinalized&&before.steps[before.finalized]?.state==='pending','LAUNCH_BOOTSTRAP_STATE');
    update({phase:'bootstrap_intent'});
    try{const bootstrap=settled(await api.bootstrapNext());return{state:snapshot(),bootstrap};}
    catch(e){const s=safeStatus(api.bootstrapStatus());const current=s.steps[s.finalized];update({phase:current?.transactionHash?'bootstrap_wait':'blocked',lastCode:cleanCode(e)});return{state:snapshot(),bootstrap:s,error:cleanCode(e),doNotResubmit:true};}
   }
   if(name==='reconcile'){
    check(['bootstrap_wait','bootstrap_ready','bootstrap_complete','blocked'].includes(state.phase),'LAUNCH_RECONCILE_PHASE');
    const before=safeStatus(api.bootstrapStatus());
    if(before.steps.some(r=>r.state!=='pending'&&r.state!=='finalized'&&!r.transactionHash))fail('LAUNCH_HASH_UNKNOWN');
    try{const result=settled(await api.bootstrapReconcile());return{state:snapshot(),bootstrap:result,noTransactionsSubmitted:true};}
    catch(e){update({lastCode:cleanCode(e)});return{state:snapshot(),error:cleanCode(e),pending:pendingCodes.has(e.code),noTransactionsSubmitted:true};}
   }
   if(name==='prepare_configuration'){
    check(state.phase==='bootstrap_complete','LAUNCH_CONFIGURATION_PHASE');
    const metadata=await api.prepareConfiguration(directory);check(metadata&&Object.keys(metadata).sort().join()==='configHash,dispenserConfigHash'&&Object.values(metadata).every(v=>/^0x[a-f0-9]{64}$/.test(v)),'LAUNCH_CONFIGURATION_EVIDENCE');
    update({phase:'configuration_ready'});return{state:snapshot(),configuration:metadata,noTransactionsSubmitted:true};
   }
   if(name==='paid_job'){
    assertRecoveryTime();
    check(state.phase==='configuration_ready'&&!state.paidAttempted,'LAUNCH_NO_NEW_PAYER_AUTHORITY');
    update({phase:'paid_intent',paidAttempted:true});
    try{const result=publicResult(await api.executeFixedJob(directory));update({phase:'paid_complete'});return{state:snapshot(),result};}
    catch(e){update({phase:'paid_uncertain',lastCode:cleanCode(e)});return{state:snapshot(),error:cleanCode(e),doNotRepay:true};}
   }
   if(name==='check_host'){check(state.phase==='configuration_ready','LAUNCH_CONFIGURATION_PHASE');const host=await api.checkHost();check(host?.ready===true&&Object.keys(host).sort().join()==='configHash,dispenserConfigHash,ready'&&/^0x[a-f0-9]{64}$/.test(host.configHash)&&/^0x[a-f0-9]{64}$/.test(host.dispenserConfigHash),'LAUNCH_HOST_NOT_READY');return{host,noTransactionsSubmitted:true};}
   check(state.paidAttempted&&['paid_complete','paid_uncertain'].includes(state.phase),'LAUNCH_RECOVERY_PHASE');
   try{const result=publicRecovery(await api.recoverFixedJob());return{state:snapshot(),result,noTransactionsSubmitted:true};}
   catch(e){return{state:snapshot(),error:cleanCode(e),noTransactionsSubmitted:true,doNotRepay:true};}
  }catch(e){fail(cleanCode(e));}finally{busy=false;}
 };
 return Object.freeze({command,status:snapshot,async close(){if(closed)return;closed=true;await api.close();}});
}

export function inspectLaunchSession(directory){
 const p=join(resolve(directory),'state.json'),s=lstatSync(p);check(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&(s.mode&0o777)===0o600&&s.size<=16384,'LAUNCH_SESSION_UNSAFE');
 const value=JSON.parse(readFileSync(p,'utf8'));check(value.schema==='mote-launch-control-v1','LAUNCH_SESSION_UNSAFE');return value;
}
