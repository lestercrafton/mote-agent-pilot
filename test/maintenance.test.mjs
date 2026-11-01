import test from 'node:test';
import A from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fork } from 'node:child_process';
import { fixture,input,PUBLIC_FIXTURE_OPERATOR } from './fixtures.mjs';
import { snapshot,offhostPlan } from '../src/maintenance.mjs';
import { Journal } from '../src/journal.mjs';
import { Service } from '../src/service.mjs';
import { diskStatus,requireDisk } from '../src/disk.mjs';
const expected=f=>({identity:f.c.identity,config:f.c,limits:f.journal.limits});
const backup=(f,dest,options={})=>snapshot({source:join(f.dir,'server.sqlite'),destination:join(f.dir,dest),expected:expected(f),...options});
test('online backup includes committed WAL; restore stays quarantined across restarts and recovers original receipt',async()=>{
 const f=fixture();try{
  const p=await f.payment(),response=await f.service.execute(input,p);const b=await backup(f,'backup.sqlite');A.equal(b.manifest.counts.orders,1);A.equal(statSync(b.destination).mode&0o777,0o600);
  A.equal(b.manifest.quarantined,true);A.throws(()=>new Journal(b.destination,f.c.identity),/RESTORE_REQUIRES_RECOVERY_ONLY/);
  const r=await snapshot({source:b.destination,destination:join(f.dir,'restored.sqlite'),expected:expected(f),restore:true});A.equal(r.manifest.quarantined,true);
  A.throws(()=>new Journal(r.destination,f.c.identity),/RESTORE_REQUIRES_RECOVERY_ONLY/);
  for(let i=0;i<2;i++) { const j=new Journal(r.destination,f.c.identity,{recoveryOnly:true});try{
   const s=new Service({config:f.c,journal:j,facilitator:{settle(){throw Error('must not call');}},proof:f.proof,receiptSigner:PUBLIC_FIXTURE_OPERATOR,now:()=>f.chain.now});
   A.deepEqual(await s.execute(input,p),response);await A.rejects(s.offer(input),/JOURNAL_QUARANTINED/);A.equal(j.attempts(),1);A.equal(j.readiness().newAdmissionAllowed,false);
  }finally{j.close();}}
 }finally{f.close();}
});
test('snapshot is consistent when a new order commits during online copy; stale restore cannot admit it',async()=>{
 const f=fixture();try{const p=await f.payment();await f.service.execute(input,p);const p2=await f.payment('second-payment-0002');
 const b=await backup(f,'backup.sqlite',{hook:async phase=>{if(phase==='beforeCopy')await f.service.execute(input,p2);}});A.equal(b.manifest.counts.orders,1);A.equal(f.journal.attempts(),2);
 const r=await snapshot({source:b.destination,destination:join(f.dir,'restored.sqlite'),expected:expected(f),restore:true});const j=new Journal(r.destination,f.c.identity,{recoveryOnly:true});try{
  const s=new Service({config:f.c,journal:j,facilitator:f.facilitator,proof:f.proof,receiptSigner:PUBLIC_FIXTURE_OPERATOR,now:()=>f.chain.now});await A.rejects(s.execute(input,p2),/JOURNAL_QUARANTINED/);A.equal(f.facilitator.settleCalls,2);
 }finally{j.close();}}finally{f.close();}
});
test('backup rejects wrong identity, extra schema and altered committed receipt',async()=>{
 const f=fixture();try{const p=await f.payment();await f.service.execute(input,p);
 await A.rejects(backup(f,'wrong.sqlite',{expected:{...expected(f),identity:'wrong'}}),/BACKUP_EXPECTED_IDENTITY/);
 f.journal.db.exec('CREATE TABLE extra(x)');await A.rejects(backup(f,'extra.sqlite'),/JOURNAL_SCHEMA/);f.journal.db.exec('DROP TABLE extra');
 f.journal.db.prepare("UPDATE orders SET response='{}'").run();await A.rejects(backup(f,'damaged.sqlite'));
 }finally{f.close();}
});
test('backup and restore never overwrite destinations; partial publication is not a valid backup',async()=>{
 const f=fixture();try{await f.service.execute(input,await f.payment());
 await A.rejects(backup(f,'partial.sqlite',{hook:async phase=>{if(phase==='afterDatabasePublish')throw Error('interrupted');}}),/interrupted/);
 A.equal(existsSync(join(f.dir,'partial.sqlite')),true);A.equal(existsSync(join(f.dir,'partial.sqlite.manifest.json')),false);
 await A.rejects(backup(f,'partial.sqlite'),/BACKUP_NO_OVERWRITE/);await A.rejects(snapshot({source:join(f.dir,'partial.sqlite'),destination:join(f.dir,'restored.sqlite'),expected:expected(f),restore:true}));
 const b=await backup(f,'complete.sqlite');const original=readFileSync(b.destination);await A.rejects(backup(f,'complete.sqlite'),/BACKUP_NO_OVERWRITE/);A.deepEqual(readFileSync(b.destination),original);
 }finally{f.close();}
});
test('client budgets are never restored through server backup tooling',async()=>{const f=fixture();try{await A.rejects(backup(f,'client-copy.sqlite',{source:join(f.dir,'client.sqlite')}),/BACKUP_METADATA/);}finally{f.close();}});
test('disk and WAL gates are explicit and fail closed without weakening recovery reads',async()=>{
 const fake={statfs:()=>({bavail:100000000n,bsize:1n}),sizeOf:()=>100};A.equal(diskStatus('/fixture/db',fake).newAdmissionAllowed,true);
 A.throws(()=>requireDisk('/fixture/db',{...fake,statfs:()=>({bavail:1n,bsize:1n})}),/DISK_PRESSURE/);
 A.throws(()=>requireDisk('/fixture/db',{...fake,sizeOf:p=>p.endsWith('-wal')?40*1024*1024:100}),/DISK_PRESSURE/);
 const f=fixture();try{const p=await f.payment();const r=await f.service.execute(input,p);f.journal.assertNewAuthority=()=>{throw Error('DISK_PRESSURE');};A.deepEqual(await f.service.execute(input,p),r);await A.rejects(f.service.offer(input),/DISK_PRESSURE/);}finally{f.close();}
});
test('disk pressure after reservation prevents settlement and retains unknown intent',async()=>{const f=fixture();try{const p=await f.payment();f.service.hook=async stage=>{if(stage==='afterReservation')f.journal.assertNewAuthority=()=>{throw Error('DISK_PRESSURE');};};await A.rejects(f.service.execute(input,p),/DISK_PRESSURE/);A.equal(f.facilitator.settleCalls,0);A.equal(f.journal.attempts(),1);}finally{f.close();}});
test('off-host transfer stays disabled even with a proposed destination',()=>{A.deepEqual(offhostPlan({enabled:false,destination:'private-backup-folder-pending'}),{enabled:false,destination:'private-backup-folder-pending'});A.throws(()=>offhostPlan({enabled:true,destination:'anything'}),/OFFHOST_DISABLED/);});
for(const point of ['afterCopy','afterDatabasePublish'])test('actual SIGKILL at '+point+' cannot produce an accepted complete snapshot',async()=>{
 const f=fixture();let child;
 try{
  await f.service.execute(input,await f.payment());const destination=join(f.dir,'killed.sqlite'),args=join(f.dir,'worker.json');
  writeFileSync(args,JSON.stringify({source:join(f.dir,'server.sqlite'),destination,expected:expected(f),point}),{mode:0o600});
  child=fork(new URL('./maintenance-worker.mjs',import.meta.url),[args],{execPath:process.execPath,stdio:['ignore','ignore','ignore','ipc']});
  const reached=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('worker checkpoint timeout')),5000);child.once('message',m=>{clearTimeout(timer);resolve(m);});child.once('exit',()=>{clearTimeout(timer);reject(Error('worker exited before checkpoint'));});});
  A.equal(reached.point,point);const exited=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await exited;
  A.equal(existsSync(destination),point==='afterDatabasePublish');A.equal(existsSync(destination+'.manifest.json'),false);
  await A.rejects(snapshot({source:destination,destination:join(f.dir,'restored.sqlite'),expected:expected(f),restore:true}));
  A.equal(f.journal.attempts(),1);A.equal((await backup(f,'safe.sqlite')).manifest.counts.orders,1);
 }finally{if(child?.connected)child.kill('SIGKILL');f.close();}
});
test('restore rejects altered bytes, manifest identity and unexpected sidecars',async()=>{
 const f=fixture();try{const b=await backup(f,'backup.sqlite'),manifest=readFileSync(b.manifestPath,'utf8');
  writeFileSync(b.manifestPath,JSON.stringify({...JSON.parse(manifest),expectedHash:'wrong'}));
  await A.rejects(snapshot({source:b.destination,destination:join(f.dir,'r1.sqlite'),expected:expected(f),restore:true}),/BACKUP_MANIFEST/);
  writeFileSync(b.manifestPath,manifest);writeFileSync(b.destination+'-wal','',{mode:0o600});
  await A.rejects(snapshot({source:b.destination,destination:join(f.dir,'r2.sqlite'),expected:expected(f),restore:true}),/BACKUP_NOT_CLOSED/);
 }finally{f.close();}
});
