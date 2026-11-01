import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { verifyRenderPrivateGroupMountFixture } from '../src/render-mount-policy.mjs';

const ACK = 'PUBLIC_FILESYSTEM_METADATA_FIXTURES_ONLY';
const status = (uid=1000,gid=1000,groups=String(gid)) => `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t${gid}\t${gid}\t${gid}\t${gid}\nGroups:\t${groups}\nCapEff:\t0000000000000000\nCapPrm:\t0000000000000000\nNoNewPrivs:\t1\n`;
function fixture() {
  const texts = {
    '/etc/passwd': 'root:x:0:0:root:/root:/bin/sh\nrender:x:1000:1000:render:/home/render:/bin/sh\n',
    '/etc/group': 'root:x:0:\nrender:x:1000:\n',
    '/etc/nsswitch.conf': 'passwd: files\ngroup: files\nhosts: files dns\n',
    '/proc/self/mountinfo': '1 0 0:1 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw\n',
    '/proc/self/status': status(), '/proc/1/status': status(0,0), '/proc/42/status': status(),
  };
  let ino=1n;
  const stat = (kind, mode, size=0n, uid=0n, gid=0n) => ({ dev:1n,ino:ino++,uid,gid,mode:BigInt(mode),nlink:1n,size,mtimeNs:1n,ctimeNs:1n,
    isDirectory:()=>kind==='directory',isFile:()=>kind==='file',isSymbolicLink:()=>kind==='symlink' });
  const states=new Map();
  for(const p of ['/','/var','/etc','/usr','/usr/bin','/usr/lib','/proc'])states.set(p,stat('directory',0o40755));
  states.set('/var/data',stat('directory',0o42775,0n,0n,1000n));
  for(const [p,text] of Object.entries(texts))states.set(p,stat('file',0o100644,BigInt(Buffer.byteLength(text))));
  states.set('/usr/bin/python3',stat('symlink',0o120777,10n));states.set('/usr/bin/python3.11',stat('file',0o100755,100n));
  let fd=10; const descriptors=new Map(), hooks={};
  const identity={platform:'linux',uid:1000,euid:1000,gid:1000,egid:1000,groups:[1000]};
  const f={texts,states,hooks,identity,pids:['1','42'],tasks:{'1':['1'],'42':['42']},acl:'absent',closed:0,
    setText(p,text){texts[p]=text;states.get(p).size=BigInt(Buffer.byteLength(text));},
    run(){return verifyRenderPrivateGroupMountFixture({acknowledgement:ACK,io:f.io,identity:()=>structuredClone(identity)});}};
  f.io={constants:{O_RDONLY:0,O_NOFOLLOW:131072},
    lstatSync(p){hooks.lstat?.(p);assert(states.has(p),p);return{...states.get(p)};},
    realpathSync(p){return hooks.realpath?.(p)??(p==='/usr/bin/python3'?'/usr/bin/python3.11':p);},
    openSync(p,flags){assert.equal(flags,131072);p=p.replace(/\/task\/[0-9]+/,'');hooks.open?.(p);const n=fd++;descriptors.set(n,p);return n;},
    fstatSync(n){const p=descriptors.get(n);hooks.fstat?.(p);return{...states.get(p)};},
    closeSync(n){descriptors.delete(n);f.closed++;},
    readSync(n,buffer,offset,length,position){const p=descriptors.get(n);hooks.read?.(p);const data=Buffer.from(texts[p]);return data.copy(buffer,offset,position,position+length);},
    readdirSync(p){if(p==='/proc')return hooks.pids?.()??[...f.pids,'self','net'];const pid=p.split('/')[2];return hooks.tasks?.(pid)??f.tasks[pid];},
    execFileSync(path,args,options){assert.equal(path,'/usr/bin/python3.11');assert.deepEqual(args.slice(0,3),['-I','-S','-c']);assert(args[3].includes('e.errno != errno.ENODATA'));assert(args[3].includes('os.O_NOFOLLOW'));assert.equal(options.timeout,2000);assert.equal(options.maxBuffer,4096);hooks.acl?.();if(f.acl!=='absent')throw Error('non-ENODATA or presentACL');const st=states.get('/var/data');const fields={dev:'st_dev',ino:'st_ino',uid:'st_uid',gid:'st_gid',mode:'st_mode',nlink:'st_nlink',size:'st_size',mtimeNs:'st_mtime_ns',ctimeNs:'st_ctime_ns'};return hooks.aclResult?.()??JSON.stringify(Object.fromEntries(Object.entries(fields).map(([k,v])=>[v,String(st[k])])));},
  };
  return f;
}

test('exact private Render group, minimal ACL and visible credentials pass read-only',()=>{
 const f=fixture(),result=f.run();assert.equal(result.path,'/var/data');assert.equal(result.uid,1000);assert.equal(result.gid,1000);assert.equal(result.mode&0o7777n,0o2775n);assert(f.closed>=8);
});
const cases={
 'non-Linux':f=>f.identity.platform='darwin',
 'root service UID':f=>f.identity.uid=f.identity.euid=0,
 'different effective UID':f=>f.identity.euid=1001,
 'different effective GID':f=>f.identity.egid=1001,
 'extra supplementary group':f=>f.identity.groups.push(2000),
 'different mount owner':f=>f.states.get('/var/data').uid=1000n,
 'different mount group':f=>f.states.get('/var/data').gid=1001n,
 'world writable mount':f=>f.states.get('/var/data').mode=0o42777n,
 'missing mount setgid':f=>f.states.get('/var/data').mode=0o40775n,
 'symlink mount':f=>f.states.get('/var/data').isSymbolicLink=()=>true,
 'noncanonical mount':f=>f.hooks.realpath=p=>p==='/var/data'?'/elsewhere':p,
 'unsafe parent':f=>f.states.get('/var').mode=0o40777n,
 'unsafe account parent':f=>f.states.get('/etc').mode=0o40775n,
 'metadata symlink':f=>f.states.get('/etc/group').isSymbolicLink=()=>true,
 'metadata hardlink':f=>f.states.get('/etc/group').nlink=2n,
 'metadata non-root owner':f=>f.states.get('/etc/passwd').uid=1000n,
 'metadata writable':f=>f.states.get('/etc/nsswitch.conf').mode=0o100664n,
 'metadata oversized':f=>f.states.get('/etc/passwd').size=65537n,
 'another primary group member':f=>f.setText('/etc/passwd',f.texts['/etc/passwd']+'other:x:1001:1000:x:/home/x:/bin/sh\n'),
 'another explicit group member':f=>{f.setText('/etc/passwd',f.texts['/etc/passwd']+'other:x:1001:1001:x:/home/x:/bin/sh\n');f.setText('/etc/group','root:x:0:\nrender:x:1000:other\n');},
 'unknown explicit member':f=>f.setText('/etc/group','root:x:0:\nrender:x:1000:unknown\n'),
 'duplicate user name':f=>f.setText('/etc/passwd',f.texts['/etc/passwd']+'render:x:1001:1001:x:/home/x:/bin/sh\n'),
 'duplicate UID':f=>f.setText('/etc/passwd',f.texts['/etc/passwd']+'alias:x:1000:1001:x:/home/x:/bin/sh\n'),
 'duplicate GID':f=>f.setText('/etc/group',f.texts['/etc/group']+'alias:x:1000:\n'),
 'malformed account ID':f=>f.setText('/etc/passwd',f.texts['/etc/passwd'].replace('1000:1000','01000:1000')),
 'malformed group record':f=>f.setText('/etc/group','render:x:1000:\n+::::\n'),
 'remote passwd NSS':f=>f.setText('/etc/nsswitch.conf','passwd: files systemd\ngroup: files\n'),
 'remote group NSS':f=>f.setText('/etc/nsswitch.conf','passwd: files\ngroup: files ldap\n'),
 'remote initgroups NSS':f=>f.setText('/etc/nsswitch.conf','passwd: files\ngroup: files\ninitgroups: ldap\n'),
 'duplicate NSS entry':f=>f.setText('/etc/nsswitch.conf','passwd: files\ngroup: files\ngroup: files\n'),
 'NSS escape':f=>f.setText('/etc/nsswitch.conf','passwd: files\\\ngroup: files\n'),
 'named user write ACL':f=>f.acl='user::rwx\nuser:2000:rwx\ngroup::rwx\nmask::rwx\nother::r-x\n',
 'named group write ACL':f=>f.acl='user::rwx\ngroup::rwx\ngroup:2000:rwx\nmask::rwx\nother::r-x\n',
 'default ACL':f=>f.acl='presentDefault',
 'ACL query error':f=>f.hooks.acl=()=>{throw Error('PRIVATE_DIAGNOSTIC');},
 'ACL executable target symlink':f=>f.states.get('/usr/bin/python3.11').isSymbolicLink=()=>true,
 'ACL executable writable':f=>f.states.get('/usr/bin/python3.11').mode=0o100775n,
 'missing ACL executable':f=>f.states.delete('/usr/bin/python3.11'),
 'unknown process has supplementary group':f=>f.setText('/proc/1/status',status(2000,2000,'2000 1000')),
 'unknown process has primary group':f=>f.setText('/proc/1/status',status(2000,1000)),
 'unknown process retains capabilities':f=>f.setText('/proc/1/status',status(2000,2000).replace('CapEff:\t0000000000000000','CapEff:\t0000000000000001')),
 'different filesystem UID':f=>f.setText('/proc/self/status',status().replace('1000\t1000\t1000\t1000','1000\t1000\t1000\t2000')),
 'unknown process credential layout':f=>f.setText('/proc/1/status','Uid: 2000\n'),
 'inaccessible process':f=>f.hooks.open=p=>{if(p==='/proc/1/status')throw Error('access denied');},
 'process list changes':f=>{let calls=0;f.hooks.pids=()=>++calls===1?['1','42']:['1','42','43'];},
 'process credentials change':f=>{let calls=0;f.hooks.open=p=>{if(p==='/proc/42/status'&&++calls===2)f.setText(p,status(2000,1000));};},
 'metadata replaced before opening':f=>f.hooks.open=p=>{if(p==='/etc/group')f.states.get(p).ino++;},
 'metadata content grows during read':f=>f.hooks.read=p=>{if(p==='/etc/passwd')f.texts[p]='x'.repeat(65537);},
 'metadata changes after read':f=>f.hooks.read=p=>{if(p==='/etc/passwd')f.states.get(p).ctimeNs++;},
 'mount changes during metadata read':f=>f.hooks.read=p=>{if(p==='/etc/passwd')f.states.get('/var/data').ino++;},
 'executable changes while invoked':f=>f.hooks.acl=()=>f.states.get('/usr/bin/python3').ino++,
 'thread list changes':f=>{let count=0;f.hooks.tasks=pid=>pid==='42'&&++count>1?['42','43']:f.tasks[pid];},
 'own privileges changed':f=>f.setText('/proc/self/status',status().replace('NoNewPrivs:\t1','NoNewPrivs:\t0')),
 'ACL fd identity mismatch':f=>f.hooks.aclResult=()=>JSON.stringify({st_dev:'wrong'}),
 'ACL changes on final verification':f=>{let calls=0;f.hooks.acl=()=>{if(++calls===2)f.acl='unknown';};},
};
for(const [name,change] of Object.entries(cases))test(`Render mount refuses ${name}`,()=>{const f=fixture();change(f);assert.throws(()=>f.run(),{code:'QUOTE_FILE_RENDER_MOUNT_UNVERIFIED'});});
test('unrelated nonprivileged process without mount group is not a writer',()=>{const f=fixture();f.setText('/proc/1/status',status(2000,2000));assert.equal(f.run().uid,1000);});
test('explicit same service member and local initgroups remain private',()=>{const f=fixture();f.setText('/etc/group','root:x:0:\nrender:x:1000:render\n');f.setText('/etc/nsswitch.conf','passwd: files\ngroup: files\ninitgroups: files\n');assert.equal(f.run().gid,1000);});
test('fixture seam requires explicit fixture acknowledgement',()=>{const f=fixture();assert.throws(()=>verifyRenderPrivateGroupMountFixture({acknowledgement:'not-approved',io:f.io,identity:()=>f.identity}));});

for (const [scenario,expected] of [['absent',0],['present',3],['unsupported',2],['permission',2],['io',2],['changed-fd',4]]) {
 test(`actual isolated Python probe handles ${scenario} ACL evidence without filesystem access`,()=>{
  const f=fixture();let script;f.io.execFileSync=(_path,args)=>{script=args[3];throw Error('capture fixture script');};assert.throws(()=>f.run());assert(script);
  const harness=`import os,errno,types
scenario=${JSON.stringify(scenario)}
counter=[0]
def opened(path,flags):
 assert path=='/var/data' and flags & os.O_NOFOLLOW and flags & os.O_DIRECTORY
 return 83
def statted(fd):
 assert fd==83
 counter[0]+=1
 return types.SimpleNamespace(st_dev=1,st_ino=(2 if scenario=='changed-fd' and counter[0]>1 else 1),st_uid=0,st_gid=1000,st_mode=17917,st_nlink=2,st_size=4096,st_mtime_ns=1,st_ctime_ns=1)
def attr(fd,name):
 assert fd==83 and name in ('system.posix_acl_access','system.posix_acl_default')
 if scenario=='present': return b''
 code={'unsupported':errno.EOPNOTSUPP,'permission':errno.EACCES,'io':errno.EIO}.get(scenario,errno.ENODATA)
 raise OSError(code,'public fixture')
os.open=opened
os.fstat=statted
os.getxattr=attr
os.close=lambda fd: None
`;
  const result=spawnSync('/usr/bin/python3',['-I','-S','-c',harness+script],{encoding:'utf8',timeout:3000,maxBuffer:4096,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'}});
  assert.equal(result.status,expected,result.stderr??String(result.error));if(expected===0){const record=JSON.parse(result.stdout);assert.equal(record.st_gid,'1000');assert.equal(record.st_ino,'1');}else assert.equal(result.stdout,'');
 });
}

test('empty supplementary groups are allowed while real/effective primary GID remains pinned',()=>{const f=fixture();f.identity.groups=[];f.setText('/proc/self/status',status(1000,1000,''));assert.equal(f.run().gid,1000);});
test('proc link count and timestamps may change without changing its identity or permissions',()=>{const f=fixture();f.hooks.lstat=p=>{if(p==='/proc'){const s=f.states.get(p);s.nlink++;s.mtimeNs++;s.ctimeNs++;s.size++;}};assert.equal(f.run().gid,1000);});
for(const option of ['hidepid=2','hidepid=1','hidepid=0','hidepid=invisible'])test(`hidden process view ${option} is refused`,()=>{const f=fixture();f.setText('/proc/self/mountinfo',`1 0 0:1 / /proc rw - proc proc rw,${option}\n`);assert.throws(()=>f.run(),{code:'QUOTE_FILE_RENDER_MOUNT_UNVERIFIED'});});
test('PID 1 must be visible',()=>{const f=fixture();f.pids=['42'];assert.throws(()=>f.run());});
test('mountinfo change during inspection is refused',()=>{const f=fixture();let n=0;f.hooks.open=p=>{if(p==='/proc/self/mountinfo'&&++n===2)f.setText(p,'1 0 0:1 / /proc ro - proc proc ro\n');};assert.throws(()=>f.run());});
test('fake proc filesystem is refused',()=>{const f=fixture();f.setText('/proc/self/mountinfo','1 0 0:1 / /proc rw - tmpfs tmpfs rw\n');assert.throws(()=>f.run());});
