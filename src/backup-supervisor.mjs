import { lstatSync,realpathSync,readdirSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { snapshot } from './maintenance.mjs';
import { assert } from './protocol.mjs';
import { hashJson } from './core/json.mjs';

// No deletion, off-host transfer, automatic restore, or reactivation. Partial
// snapshots consume capacity. Restart requires a fresh validated snapshot.
export class BackupSupervisor {
  constructor({source,directory,expected,policy,now=()=>Math.floor(Date.now()/1000),copy=snapshot}) {
    this.source=source;this.directory=directory;this.expected=structuredClone(expected);this.policy=policy;this.now=now;this.copy=copy;this.last=0;this.busy=false;this.failed=true;this.timer=null;
    assert(Number.isSafeInteger(policy.intervalSeconds)&&policy.intervalSeconds>=60&&Number.isSafeInteger(policy.maxAgeSeconds)&&policy.maxAgeSeconds>=policy.intervalSeconds&&policy.maxSnapshots>0&&policy.maxSnapshots<=26&&policy.maxTotalBytes>0&&policy.maxTotalBytes<=256*1024*1024,'BACKUP_POLICY');
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
    return {next,bytes,count};
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
      this.last=this.now();this.failed=false;return result;
    }catch(e){this.failed=true;throw e;}finally{this.busy=false;}
  }
  status() {const t=this.now();return {available:!this.failed&&this.last>0&&t>=this.last&&t-this.last<=this.policy.maxAgeSeconds,lastSuccessfulAt:this.last||null,offhost:false};}
  assertReady(){assert(this.status().available,'BACKUP_UNAVAILABLE');}
  async start(){await this.run();this.timer=setInterval(()=>{if(!this.busy)this.run().catch(()=>{});},this.policy.intervalSeconds*1000);this.timer.unref();}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}
}
