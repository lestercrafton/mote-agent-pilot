import test, {beforeEach, afterEach, mock} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFileSync,writeFileSync} from 'node:fs';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {HDNodeWallet} from 'ethers';
import {createBootstrapHarness} from './helpers/bootstrap-harness.mjs';
import {createBootstrapPlan} from '../src/bootstrap-plan.mjs';
import {initializeLocalBootstrapJournal,createLoopbackRecoveryBootstrapRunner} from '../src/bootstrap-runner.mjs';
import {R1,assertRecoveryTime} from '../src/recovery-r1-policy.mjs';
async function setup(t){
 const h=await createBootstrapHarness();t.after(()=>h.close());await h.runner.advance();await h.runner.advance();
 const old=h.runner.status().steps;h.runner.close();
 const oldBytes=readFileSync(h.path);
 const p=HDNodeWallet.fromPhrase('test test test test test test test test test test test junk',undefined,"m/44'/60'/0'/0/8").address;
 const plan=createBootstrapPlan({chainId:11155111,...h.plan.roles,payer:p,operatorNonce:'0',payerNativeWei:'7000000000000000'});
 const path=join(h.directory,'recovery.sqlite');initializeLocalBootstrapJournal({ack:'LOCAL_EVM_ONLY',genesisHash:h.genesisHash,path,plan});
 const recovery={operator:plan.roles.operator,quoteSigner:plan.roles.quoteSigner,originalPayer:h.plan.roles.payer,adopted:old.slice(0,2).map(r=>({index:r.index,transactionHash:r.transactionHash,feeWei:r.proof.feeWei,finalizedAnchor:r.proof.finalized}))};
 const options={ack:'LOCAL_EVM_ONLY',genesisHash:h.genesisHash,reader:h.reader,path,plan,recovery,authorization:{...h.authorization,planHash:plan.planHash,policyHash:plan.policyHash,expiresAt:R1.expiresAt/1000},signer:h.signer};
 const runner=await createLoopbackRecoveryBootstrapRunner(options);t.after(()=>runner.close());return{h,oldBytes,runner,options};
}
test('adopt two finalized hashes one at a time without signer; only next nonce can send; original journal unchanged',async t=>{
 const f=await setup(t);assert.equal(f.h.signCalls,2);
 await assert.rejects(f.runner.advance(),{code:'BOOTSTRAP_ADOPTION_REQUIRED'});
 let r=await f.runner.adoptNext();assert.deepEqual(r.steps.map(x=>x.state),['finalized','pending','pending','pending','pending']);assert.equal(f.h.signCalls,2);
 await assert.rejects(f.runner.advance(),{code:'BOOTSTRAP_ADOPTION_REQUIRED'});
 r=await f.runner.adoptNext();assert.equal(r.steps[1].state,'finalized');assert.equal(f.h.signCalls,2);
 await assert.rejects(f.runner.adoptNext(),{code:'BOOTSTRAP_ADOPTION_COMPLETE'});
 r=await f.runner.advance();assert.equal(r.steps[2].state,'finalized');assert.equal(f.h.signCalls,3);assert.equal(r.steps[2].intent.nonce,'2');
 assert.deepEqual(readFileSync(f.h.path),f.oldBytes);
});
test('missing historical evidence retains known hash and permits read-only retry, never resend',async t=>{
 const f=await setup(t);f.runner.close();let fail=true;
 const reader={...f.h.reader,send:async(m,p)=>{if(fail&&m==='eth_getTransactionReceipt')throw Error('fixture evidence unavailable');return f.h.reader.send(m,p);}};
 const runner=await createLoopbackRecoveryBootstrapRunner({...f.options,reader});t.after(()=>runner.close());
 await assert.rejects(runner.adoptNext(),/unavailable/);assert.equal(runner.status().steps[0].transactionHash,f.options.recovery.adopted[0].transactionHash);assert.equal(runner.status().steps[0].state,'submitted');assert.equal(f.h.signCalls,2);
 await assert.rejects(runner.advance());assert.equal(f.h.signCalls,2);
 fail=false;await runner.reconcile();assert.equal(runner.status().steps[0].state,'finalized');assert.equal(f.h.signCalls,2);
});
test('wrong adopted receipt fee and swapped transaction hash fail strict verifier with no signer calls',async t=>{
 for(const kind of ['fee','hash']){const f=await setup(t);f.runner.close();const recovery=structuredClone(f.options.recovery);
 if(kind==='fee')recovery.adopted[0].feeWei='1';else recovery.adopted[0].transactionHash=recovery.adopted[1].transactionHash;
 const runner=await createLoopbackRecoveryBootstrapRunner({...f.options,recovery});t.after(()=>runner.close());await assert.rejects(runner.adoptNext());assert.equal(f.h.signCalls,2);assert.equal(runner.status().steps[1].state,'pending');}
});
test('crash/reopen after one adoption retains row and rechecks it before second without signer',async t=>{
 const f=await setup(t);await f.runner.adoptNext();f.runner.close();
 const runner=await createLoopbackRecoveryBootstrapRunner({...f.options,signer:undefined});t.after(()=>runner.close());await runner.adoptNext();assert.equal(runner.status().steps[1].state,'finalized');assert.equal(f.h.signCalls,2);
 await assert.rejects(runner.advance(),{code:'BOOTSTRAP_SIGNER'});assert.equal(f.h.signCalls,2);
});
test('same payer, reset expiry or expanded recovery scope rejected',async t=>{
 const f=await setup(t);f.runner.close();
 await assert.rejects(createLoopbackRecoveryBootstrapRunner({...f.options,authorization:{...f.options.authorization,expiresAt:f.options.authorization.expiresAt+1}}),{code:'BOOTSTRAP_RECOVERY_SCOPE'});
 await assert.rejects(createLoopbackRecoveryBootstrapRunner({...f.options,recovery:{...f.options.recovery,originalPayer:f.options.plan.roles.payer}}),{code:'BOOTSTRAP_RECOVERY_SCOPE'});assert.equal(f.h.signCalls,2);
});
test('fixed authorization has earlier operational cutoff, no refreshed clock and F disabled',()=>{
 assert.equal(R1.expiresAt-R1.approvedAt,86400000);assert.equal(R1.storedProofFallback,false);
 assertRecoveryTime(R1.approvedAt);assertRecoveryTime(R1.operationalDeadline-1);
 for(const n of [R1.approvedAt-1,R1.operationalDeadline,R1.expiresAt])assert.throws(()=>assertRecoveryTime(n),{code:'R1_AUTHORIZATION_EXPIRED_OR_NOT_STARTED'});
});

beforeEach(()=>mock.method(Date,'now',()=>Date.parse('2026-10-31T22:00:00Z')));afterEach(()=>mock.restoreAll());

test('process kill around adoption persistence preserves known hash and permits only read-only recovery',async t=>{
 for(const phase of ['afterAdoptionIntent','afterAdoptionFinalized']){
  const f=await setup(t);f.runner.close();
  const file=join(f.h.directory,'child.json');
  const {reader,signer,...options}=f.options;writeFileSync(file,JSON.stringify({...options,endpoint:reader.endpoint,phase}),{mode:0o600});
  const child=fork(new URL('./helpers/recovery-process.mjs',import.meta.url),[file],{stdio:['ignore','ignore','pipe','ipc']});
  let diagnostic='';child.stderr.on('data',b=>{diagnostic+=b.toString();});
  const [code,signal]=await once(child,'exit');assert.equal(signal,'SIGKILL',diagnostic);assert.equal(code,null);
  const runner=await createLoopbackRecoveryBootstrapRunner({...f.options,signer:undefined});t.after(()=>runner.close());
  assert.equal(runner.status().steps[0].transactionHash,f.options.recovery.adopted[0].transactionHash);
  await runner.reconcile();assert.equal(runner.status().steps[0].state,'finalized');
  await runner.adoptNext();assert.equal(runner.status().steps[1].state,'finalized');assert.equal(f.h.signCalls,2);
 }
});
