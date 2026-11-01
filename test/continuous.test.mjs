import test from 'node:test';
import A from 'node:assert/strict';
import {mkdirSync,readdirSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {fixture,input,H} from './fixtures.mjs';
import {Journal} from '../src/journal.mjs';
import {validatePayment} from '../src/protocol.mjs';
import {admissionWindow} from '../src/production-policy.mjs';
import {installProductionControls} from '../src/startup.mjs';
import {providerReservation} from '../src/provider-budget.mjs';
import {BackupSupervisor} from '../src/backup-supervisor.mjs';
import {snapshot} from '../src/maintenance.mjs';

const budget={authorizedMicrousd:'1000000',reservePerAttemptMicrousd:'1000'};
const limits={maxAttempts:null,maxRecords:null,providerBudget:budget};
const backups={assertReady(){},status(){return {available:true};},stop(){}};
test('continuous production has no 24-hour expiry; rollback and early starts fail',()=>{let now=100;const gate=admissionWindow({notBefore:100},()=>now);gate();now+=86400*100;gate();now--;A.throws(gate,/CLOCK_ROLLBACK/);A.throws(admissionWindow({notBefore:100},()=>99),/WINDOW_CLOSED/);});
test('no-count mode requires explicit positive provider-dollar authority',()=>{for(const providerBudget of [undefined,{}, {...budget,reservePerAttemptMicrousd:'0'},{...budget,authorizedMicrousd:'0'},{...budget,reservePerAttemptMicrousd:'1000001'},{...budget,extra:true}]){A.throws(()=>fixture({limits:{...limits,providerBudget}}));}A.throws(()=>providerReservation({providerBudget:budget},1001),/USAGE_CORRUPT/);});
test('101 completed fixture payments are admitted; counter is accounting, not a 100-job gate',async()=>{
 const f=fixture({limits:{...limits,verifyPerMinute:10000,perPayer:1000,maxVerifications:1000},service:{requestsPerMinute:10000},clientBudget:'10000000'});
 try {let first,answer;installProductionControls(f.service,{operation:{notBefore:f.chain.now-1,providerBudget:budget},now:()=>f.chain.now,backups});
 for(let i=0;i<101;i++){const p=await f.payment(`continuous-payment-${String(i).padStart(4,'0')}`);const r=await f.service.execute(input,p);A.equal(r.status,'complete');if(!first){first=p;answer=r;}}
 A.equal(f.facilitator.settleCalls,101);A.equal(f.journal.attempts(),101);A.equal(f.journal.providerStatus().reservedMicrousd,'101000');A.equal(f.service.disclosure.settlementAttemptCap,null);A.equal(f.service.disclosure.newPaymentsUntil,null);
 A.deepEqual(await f.service.execute(input,first),answer);A.equal(f.facilitator.settleCalls,101);
 }finally{f.close();}
});
test('monetary authority, including unknown attempts, survives restart; final permitted call succeeds',async()=>{
 const b={authorizedMicrousd:'1000',reservePerAttemptMicrousd:'1000'},f=fixture({limits:{...limits,providerBudget:b}});let reopened;
 try {installProductionControls(f.service,{operation:{notBefore:f.chain.now-1,providerBudget:b},now:()=>f.chain.now,backups});const p=await f.payment();const result=await f.service.execute(input,p);A.equal(result.status,'complete');A.equal(f.journal.providerStatus().canReserve,false);await A.rejects(f.service.offer(input),/FACILITATOR_BUDGET/);A.deepEqual(await f.service.execute(input,p),result);
 f.journal.close();reopened=new Journal(f.journal.path,f.c.identity,{...limits,providerBudget:b});A.equal(reopened.providerStatus().reservedMicrousd,'1000');A.throws(()=>reopened.assertProviderAdmission(),/FACILITATOR_BUDGET/);A.throws(()=>new Journal(f.journal.path,f.c.identity,limits),/JOURNAL_IDENTITY/);
 }finally{reopened?.close();f.close();}
});
test('two journal connections atomically share last provider reservation; duplicates do not spend twice',async()=>{
 const f=fixture({limits:{...limits,providerBudget:{authorizedMicrousd:'1000',reservePerAttemptMicrousd:'1000'}}});let second;
 try{const p=await f.payment(),p2=await f.payment('fixture-payment-0002'),v=validatePayment(f.c,input,p,f.chain.now),v2=validatePayment(f.c,input,p2,f.chain.now);second=new Journal(f.journal.path,f.c.identity,f.journal.limits);
 A.equal(f.journal.reserve(v,p,f.chain.now).owner,true);A.equal(second.reserve(v,p,f.chain.now).owner,false);A.throws(()=>second.reserve(v2,p2,f.chain.now),/FACILITATOR_BUDGET/);A.equal(second.attempts(),1);A.equal(f.facilitator.settleCalls,0);
 }finally{second?.close();f.close();}
});
test('crash-equivalent stop after reservation keeps dollar authority held without settlement retry',async()=>{
 const f=fixture({limits,service:{hook:async phase=>{if(phase==='afterReservation')throw Error('fixture interruption');}}});
 try{const p=await f.payment();await A.rejects(f.service.execute(input,p),/fixture interruption/);A.equal(f.facilitator.settleCalls,0);A.equal(f.journal.providerStatus().reservedMicrousd,'1000');const r=await f.service.execute(input,p);A.equal(r.status,'pending');A.equal(f.facilitator.settleCalls,0);A.equal(f.journal.providerStatus().reservedMicrousd,'1000');}finally{f.close();}
});
test('dollar ledger corruption and storage exhaustion cannot create new authority',async()=>{
 const f=fixture({limits:{...limits,storageBudgetBytes:32768}});
 try{const p=await f.payment(),v=validatePayment(f.c,input,p,f.chain.now);f.journal.reserve(v,p,f.chain.now);const p2=await f.payment('fixture-payment-0002');A.throws(()=>f.journal.reserve(validatePayment(f.c,input,p2,f.chain.now),p2,f.chain.now),/STORAGE_BUDGET/);f.journal.db.prepare('UPDATE usage SET attempts=1001').run();A.throws(()=>f.journal.attempts(),/USAGE_CORRUPT/);}finally{f.close();}
});
function supervisor(f,copy){const directory=join(f.dir,'rotating');mkdirSync(directory,{mode:0o700});return new BackupSupervisor({source:f.journal.path,directory,expected:{identity:f.c.identity,config:f.c,limits:f.journal.limits},policy:{intervalSeconds:60,maxAgeSeconds:120,maxSnapshots:3,retainSnapshots:2,maxTotalBytes:64*1024*1024},now:()=>f.chain.now,...(copy?{copy}:{})});}
test('verified backup rotation continues past 26 snapshots with two recent copies and intact recovery',async()=>{
 const f=fixture({limits});try{const p=await f.payment(),r=await f.service.execute(input,p),b=supervisor(f);for(let i=0;i<28;i++){f.chain.now+=61;await b.run();b.assertReady();}
 A.deepEqual(readdirSync(b.directory).sort(),['snapshot-000027.sqlite','snapshot-000027.sqlite.manifest.json','snapshot-000028.sqlite','snapshot-000028.sqlite.manifest.json']);A.deepEqual(await f.service.execute(input,p),r);A.equal(f.facilitator.settleCalls,1);
 const manifest=JSON.parse(readFileSync(join(b.directory,'snapshot-000028.sqlite.manifest.json')));A.equal(manifest.counts.attempts,1);A.equal(manifest.quarantined,true);
 }finally{f.close();}
});
test('failed new snapshot never deletes previous backups; partial deletion is a fail-closed restart',async()=>{
 const f=fixture({limits});try{const b=supervisor(f);await b.run();await b.run();const before=readdirSync(b.directory).filter(n=>n.startsWith('snapshot-'));b.copy=async()=>{throw Error('fixture copy failure');};await A.rejects(b.run());A.deepEqual(readdirSync(b.directory).filter(n=>n.startsWith('snapshot-')),before);
 unlinkSync(join(b.directory,'snapshot-000001.sqlite'));b.copy=snapshot;await A.rejects(b.run(),/BACKUP_PARTIAL/);A.equal(b.status().available,false);
 }finally{f.close();}
});
test('corrupt old snapshot is preserved and blocks rotation instead of silently destroying evidence',async()=>{
 const f=fixture({limits});try{const b=supervisor(f);await b.run();await b.run();const p=join(b.directory,'snapshot-000001.sqlite.manifest.json'),m=JSON.parse(readFileSync(p));m.sha256=H(1);writeFileSync(p,JSON.stringify(m));await A.rejects(b.run(),/BACKUP_MANIFEST/);A.equal(b.status().available,false);A.equal(readdirSync(b.directory).filter(n=>n.endsWith('.sqlite')).length,3);}finally{f.close();}
});
