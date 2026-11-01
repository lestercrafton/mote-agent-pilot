import { lstatSync,realpathSync,readdirSync,readFileSync,createReadStream,unlinkSync,openSync,closeSync,fsyncSync,rmdirSync } from 'node:fs';
import {createHash} from 'node:crypto';
import { join } from 'node:path';
import { snapshot } from './maintenance.mjs';
import { assert } from './protocol.mjs';
import { hashJson } from './core/json.mjs';

// Optional explicitly configured retention removes only redundant validated
// snapshot pairs after a fresh quarantined copy commits. Never removes orders.
// Partial pairs/stages fail closed; no off-host transfer or automatic restore.
export class BackupSupervisor {
  constructor({source,directory,expected,policy,now=()=>Math.floor(Date.now()/1000),copy=snapshot}) {
    this.source=source;this.directory=directory;this.expected=structuredClone(expected);this.policy=policy;this.now=now;this.copy=copy;this.last=0;this.busy=false;this.failed=true;this.timer=null;
    assert(Number.isSafeInteger(policy.intervalSeconds)&&policy.intervalSeconds>=60&&Number.isSafeInteger(policy.maxAgeSeconds)&&policy.maxAgeSeconds>=policy.intervalSeconds&&policy.maxSnapshots>0&&policy.maxSnapshots<=26&&policy.maxTotalBytes>0&&policy.maxTotalBytes<=256*1024*1024,'BACKUP_POLICY');
    if(policy.retainSnapshots!==undefined) assert(Number.isSafeInteger(policy.retainSnapshots)&&policy.retainSnapshots>=2&&policy.maxSnapshots===policy.retainSnapshots+1,'BACKUP_RETENTION');
    const s=lstatSync(directory);assert(s.isDirectory()&&!s.isSymbolicLink()&&realpathSync(directory)===directory&&s.uid===process.getuid()&&(s.mode&0o077)===0,'BACKUP_DIRECTORY');this.stamp=s;
  }
  inspect() {
    const d=lstatSync(this.directory);assert(d.dev===this.stamp.dev&&d.ino===this.stamp.ino&&d.uid===this.stamp.uid&&d.mode===this.stamp.mode&&!d.isSymbolicLink(),'BACKUP_DIRECTORY_CHANGED');
    let count=0,bytes=0,next=1;
    for(const name of readdirSync(this.directory)) {
      // snapshot() leaves bounded empty staging directories; interrupted stages
      // remain evidence, and block new backup/admission for operator review.
      const p=join(this.directory,name),s=lstatSync(p);
      if(name.startsWith('.mote-backup-')) { assert(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&0o077)===0&&readdirSync(p).length===0,'BACKUP_PARTIAL');continue; }
      assert(/^snapshot-[0-9]{6}\.sqlite(?:\.manifest\.json)?$/.test(name)&&s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&0o077)===0,'BACKUP_CONTENT');
      bytes+=s.size;
      if(name.endsWith('.sqlite')) {count++;next=Math.max(next,Number(name.slice(9,15))+1);}
    }
    assert(count<this.policy.maxSnapshots&&bytes+Number(lstatSync(this.source).size)+16*1024*1024<=this.policy.maxTotalBytes,'BACKUP_CAPACITY');
    const names=readdirSync(this.directory);
    for(const name of names.filter(n=>/^snapshot-/.test(n))) assert(names.includes(name.endsWith('.manifest.json')?name.slice(0,-14):name+'.manifest.json'),'BACKUP_PARTIAL');
    return {next,bytes,count};
  }
  async rotate() {
    if(this.policy.retainSnapshots===undefined)return;
    const names=readdirSync(this.directory).filter(n=>/^snapshot-[0-9]{6}\.sqlite$/.test(n)).sort();
    for(const name of names.slice(0,Math.max(0,names.length-this.policy.retainSnapshots))) {
      const database=join(this.directory,name),manifestPath=database+'.manifest.json';
      const stamps=[database,manifestPath].map(p=>lstatSync(p));
      for(const s of stamps)assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&0o077)===0,'BACKUP_FILE');
      assert(stamps[1].size<=65536,'BACKUP_FILE');
      const manifest=JSON.parse(readFileSync(manifestPath,'utf8')),h=createHash('sha256');
      for await(const chunk of createReadStream(database,{highWaterMark:65536}))h.update(chunk);
      assert(manifest.format==='mote-usdc-snapshot-v1'&&manifest.expectedHash===hashJson(this.expected)&&manifest.sha256===h.digest('hex')&&manifest.quarantined===true&&manifest.activationAuthorized===false,'BACKUP_MANIFEST');
      const d=lstatSync(this.directory);assert(d.dev===this.stamp.dev&&d.ino===this.stamp.ino&&d.mode===this.stamp.mode,'BACKUP_DIRECTORY_CHANGED');
      for(const [i,p] of [database,manifestPath].entries()){const s=lstatSync(p);assert(s.dev===stamps[i].dev&&s.ino===stamps[i].ino&&s.nlink===1&&s.mode===stamps[i].mode&&s.uid===stamps[i].uid,'BACKUP_FILE_CHANGED');}
      // An interruption between deletions is deliberately an orphan-pair stop;
      // it never grants extra capacity or removes the two newest snapshots.
      unlinkSync(database);unlinkSync(manifestPath);
      const fd=openSync(this.directory,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
    }
    for(const name of readdirSync(this.directory).filter(n=>n.startsWith('.mote-backup-'))){const p=join(this.directory,name),s=lstatSync(p);assert(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&0o077)===0&&readdirSync(p).length===0,'BACKUP_PARTIAL');rmdirSync(p);}
  }
  async run() {
    assert(!this.busy,'BACKUP_BUSY');this.busy=true;
    try {
      const {next}=this.inspect(),destination=join(this.directory,`snapshot-${String(next).padStart(6,'0')}.sqlite`);
      const result=await this.copy({source:this.source,destination,expected:this.expected});
      const manifest=JSON.parse(readFileSync(result.manifestPath,'utf8'));
      assert(manifest.expectedHash===hashJson(this.expected)&&manifest.quarantined===true&&manifest.activationAuthorized===false,'BACKUP_MANIFEST');
      const total=readdirSync(this.directory).filter(n=>/^snapshot-/.test(n)).reduce((n,f)=>n+lstatSync(join(this.directory,f)).size,0);
      assert(total<=this.policy.maxTotalBytes,'BACKUP_CAPACITY');
      await this.rotate();
      this.last=this.now();this.failed=false;return result;
    }catch(e){this.failed=true;throw e;}finally{this.busy=false;}
  }
  status() {const t=this.now();return {available:!this.failed&&this.last>0&&t>=this.last&&t-this.last<=this.policy.maxAgeSeconds,lastSuccessfulAt:this.last||null,offhost:false};}
  assertReady(){assert(this.status().available,'BACKUP_UNAVAILABLE');}
  async start(){await this.run();this.timer=setInterval(()=>{if(!this.busy)this.run().catch(()=>{});},this.policy.intervalSeconds*1000);this.timer.unref();}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}
}
