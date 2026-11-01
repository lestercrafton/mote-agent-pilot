import test from 'node:test';
import A from 'node:assert/strict';
import { fork } from 'node:child_process';
import { writeFileSync, readFileSync, renameSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, input } from './fixtures.mjs';
import { recoverAuthorization } from '../src/client.mjs';

function worker(f, n, data) {
  const path = join(f.dir, `worker-${n}.json`); writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
  const child = fork(new URL('./process-worker.mjs', import.meta.url), [path], { execPath: process.execPath, stdio: ['ignore','ignore','pipe','ipc'] });
  let stderr = ''; child.stderr.on('data', c => stderr += c);
  const ready = new Promise((resolve,reject) => { child.once('message', resolve); child.once('error',reject); child.once('exit', code => { if(code) reject(Error(stderr)); }); });
  return { child, ready, result: () => new Promise((resolve,reject) => { const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('worker timeout')); }, 5000); child.once('message', m => { clearTimeout(timer); resolve(m); }); child.send('go'); }) };
}
test('two processes cannot spend the same total client budget twice', async () => {
  const f = fixture({clientBudget:'1000'}); const workers=[];
  try {
    for(let n=0;n<2;n++) workers.push(worker(f,n,{mode:'client',path:join(f.dir,'client.sqlite'),identity:{config:f.c.identity,policy:f.policy},options:{clientBudget:'1000'},id:`client-process-${n}`}));
    await Promise.all(workers.map(w=>w.ready)); const results=await Promise.all(workers.map(w=>w.result()));
    A.equal(results.filter(r=>r.ok).length,1); A.equal(results.filter(r=>r.error==='CLIENT_BUDGET').length,1);
  } finally { for(const w of workers) if(w.child.connected) w.child.kill('SIGKILL'); f.close(); }
});
test('two processes reserve a single settlement attempt for one authorization', async () => {
  const f=fixture(); const workers=[];
  try { const payment=await f.payment();
    for(let n=0;n<2;n++) workers.push(worker(f,n,{mode:'server',path:join(f.dir,'server.sqlite'),identity:f.c.identity,c:f.c,payment,now:f.chain.now}));
    await Promise.all(workers.map(w=>w.ready)); const results=await Promise.all(workers.map(w=>w.result())); A.equal(results.filter(r=>r.owner).length,1); A.equal(f.journal.attempts(),1);
  } finally { for(const w of workers) if(w.child.connected) w.child.kill('SIGKILL'); f.close(); }
});
for(const continuous of [false,true]) for(const point of ['afterReservation','afterSettlement','beforeReceiptCommit']) test(`SIGKILL at ${point} preserves recovery without a new settle call (continuous=${continuous})`, async () => {
  const f=fixture(continuous?{limits:{maxAttempts:null,maxRecords:null,providerBudget:{authorizedMicrousd:'1000',reservePerAttemptMicrousd:'1000'}}}:{}); let w;
  try {
    const payment=await f.payment(); const externalState=join(f.dir,'fixture-chain.json');
    w=worker(f,0,{mode:'kill',point,path:join(f.dir,'server.sqlite'),identity:f.c.identity,options:f.journal.limits,c:f.c,payment,now:f.chain.now,externalState}); await w.ready;
    const at=await w.result(); A.equal(at.killPoint,point); const exited=new Promise(r=>w.child.once('exit',r)); w.child.kill('SIGKILL'); await exited;
    f.chain.transfers=new Map(JSON.parse(readFileSync(externalState,'utf8'))); f.chain.used=new Set([...f.chain.transfers.values()].map(t=>t.payment.payload.authorization.nonce));
    const result=await f.service.execute(input,payment); A.equal(result.status,point==='afterReservation'?'pending':'complete'); A.equal(f.facilitator.settleCalls,0); A.equal(f.journal.attempts(),1); if(continuous){A.equal(f.journal.providerStatus().reservedMicrousd,'1000');A.throws(()=>f.journal.assertProviderAdmission(),/FACILITATOR_BUDGET/);}
  } finally { if(w?.child.connected) w.child.kill('SIGKILL'); f.close(); }
});
test('open journal path replacement/hard-link changes fail closed', async () => {
  const f=fixture(); try {
    const payment=await f.payment(); const path=join(f.dir,'client.sqlite'); linkSync(path,join(f.dir,'alias.sqlite'));
    A.throws(()=>recoverAuthorization(f.clientJournal,'fixture-payment-0001'),/JOURNAL_REPLACED/);
  } finally { f.close(); }
});
test('semantic client amount corruption cannot create extra budget', async () => {
  const f=fixture(); try { await f.payment(); f.clientJournal.db.prepare("UPDATE clients SET amount='-1000'").run(); await A.rejects(f.payment('fixture-payment-0002'),/CLIENT_JOURNAL_CORRUPT/); } finally { f.close(); }
});

test('two independent processes cannot overspend the final provider-dollar reservation',async()=>{
 const f=fixture({limits:{maxAttempts:null,maxRecords:null,providerBudget:{authorizedMicrousd:'1000',reservePerAttemptMicrousd:'1000'}}}),workers=[];
 try{
  const payments=[await f.payment('process-provider-0001'),await f.payment('process-provider-0002')];
  for(let n=0;n<2;n++)workers.push(worker(f,n,{mode:'server',path:f.journal.path,identity:f.c.identity,options:f.journal.limits,c:f.c,payment:payments[n],now:f.chain.now}));
  await Promise.all(workers.map(w=>w.ready));const results=await Promise.all(workers.map(w=>w.result()));
  A.equal(results.filter(r=>r.owner===true).length,1);A.equal(results.filter(r=>r.error==='FACILITATOR_BUDGET').length,1);A.equal(f.journal.providerStatus().reservedMicrousd,'1000');A.equal(f.facilitator.settleCalls,0);
 }finally{for(const w of workers)if(w.child.connected)w.child.kill('SIGKILL');f.close();}
});
