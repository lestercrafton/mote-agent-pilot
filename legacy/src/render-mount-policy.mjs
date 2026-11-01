import { constants, lstatSync, realpathSync, openSync, fstatSync, readSync, readdirSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// A private primary group grants no writer beyond the already trusted service
// UID and root. This exception is ONLY for Render's root-owned /var/data mount.
// It is not a general group-writable-ancestor policy or an authority grant.
const fail = () => { const e = new Error('QUOTE_FILE_RENDER_MOUNT_UNVERIFIED'); e.code = e.message; throw e; };
const check = value => { if (!value) fail(); };
const metadataPaths = ['/etc/passwd', '/etc/group', '/etc/nsswitch.conf'];
const MAX_BYTES = 65536;
const stamp = s => ['dev','ino','uid','gid','mode','nlink','size','mtimeNs','ctimeNs'].map(k => String(s[k])).join(':');
const directoryStamp = s => ['dev','ino','uid','gid','mode'].map(k => String(s[k])).join(':');
const mode = s => Number(s.mode & 0o7777n);
const identifier = s => typeof s === 'string' && /^[a-zA-Z_][a-zA-Z0-9_.-]*\$?$/.test(s);
const numeric = s => /^(0|[1-9][0-9]{0,9})$/.test(s) && Number.isSafeInteger(Number(s)) && Number(s) <= 4294967294;

function accountPolicy(texts, uid, gid) {
  for (const value of Object.values(texts)) check(typeof value === 'string' && !value.includes('\0') && !value.includes('\r') && !value.includes('\uFFFD'));
  const rows = (text, length) => text.split('\n').filter(Boolean).map(line => {
    const fields = line.split(':'); check(fields.length === length && identifier(fields[0])); return fields;
  });
  const passwd = rows(texts['/etc/passwd'], 7), groups = rows(texts['/etc/group'], 4);
  check(passwd.length > 0 && groups.length > 0);
  const names = new Map(), uids = new Set();
  for (const p of passwd) {
    check(numeric(p[2]) && numeric(p[3]) && !names.has(p[0]) && !uids.has(p[2]));
    names.set(p[0], Number(p[2])); uids.add(p[2]);
    if (Number(p[3]) === gid) check(Number(p[2]) === uid);
  }
  const service = passwd.filter(p => Number(p[2]) === uid);
  check(service.length === 1 && Number(service[0][3]) === gid);
  const groupNames = new Set(), gids = new Set(); let primary = false;
  for (const g of groups) {
    check(numeric(g[2]) && !groupNames.has(g[0]) && !gids.has(g[2])); groupNames.add(g[0]); gids.add(g[2]);
    const members = g[3] === '' ? [] : g[3].split(',');
    check(new Set(members).size === members.length && members.every(n => identifier(n) && names.has(n)));
    if (Number(g[2]) === gid) { primary = true; check(members.every(n => names.get(n) === uid)); }
  }
  check(primary);
  const sources = new Map();
  for (const raw of texts['/etc/nsswitch.conf'].split('\n')) {
    const line = raw.split('#')[0].trim(); if (!line) continue;
    const match = /^([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.*?)\s*$/.exec(line); check(match && !sources.has(match[1]));
    sources.set(match[1], match[2]);
  }
  check(sources.get('passwd') === 'files' && sources.get('group') === 'files'
    && (!sources.has('initgroups') || sources.get('initgroups') === 'files'));
}

const nativeIo = { constants, lstatSync, realpathSync, openSync, fstatSync, readSync, readdirSync, closeSync, execFileSync };
const nativeIdentity = () => ({ platform: process.platform, uid: process.getuid(), euid: process.geteuid(), gid: process.getgid(), egid: process.getegid(), groups: process.getgroups() });

function inspect(io, identity) {
  const who = identity();
  check(who.platform === 'linux' && Number.isSafeInteger(who.uid) && who.uid > 0 && who.uid === who.euid
    && Number.isSafeInteger(who.gid) && who.gid > 0 && who.gid === who.egid
    && Array.isArray(who.groups) && who.groups.length <= 1 && who.groups.every(g => g === who.gid));
  const snapshots = new Map();
  const boundedRead = (fd, limit) => {
    const bytes = Buffer.alloc(limit + 1); let length = 0;
    while (length < bytes.length) { const count = io.readSync(fd, bytes, length, bytes.length - length, length); if (count === 0) break; length += count; }
    check(length <= limit); return bytes.subarray(0, length);
  };
  const observe = (path, kind) => {
    const st = io.lstatSync(path, { bigint: true });
    check(io.realpathSync(path) === path && !st.isSymbolicLink());
    if (kind === 'mount') check(st.isDirectory() && st.uid === 0n && st.gid === BigInt(who.gid) && mode(st) === 0o2775);
    else if (kind === 'parent') check(st.isDirectory() && st.uid === 0n && (mode(st) & 0o022) === 0);
    else check(st.isFile() && st.uid === 0n && st.gid === 0n && mode(st) === 0o644 && st.nlink === 1n && st.size > 0n && st.size <= BigInt(MAX_BYTES));
    return st;
  };
  for (const path of ['/', '/var', '/etc']) snapshots.set(path, { kind: 'parent', stat: observe(path, 'parent') });
  snapshots.set('/var/data', { kind: 'mount', stat: observe('/var/data', 'mount') });
  const texts = {};
  for (const path of metadataPaths) {
    const before = observe(path, 'file'); snapshots.set(path, { kind: 'file', stat: before });
    const fd = io.openSync(path, io.constants.O_RDONLY | io.constants.O_NOFOLLOW);
    try {
      check(stamp(before) === stamp(io.fstatSync(fd, { bigint: true })));
      const bytes = boundedRead(fd, MAX_BYTES); check(bytes.length === Number(before.size));
      check(stamp(before) === stamp(io.fstatSync(fd, { bigint: true })) && stamp(before) === stamp(observe(path, 'file')));
      texts[path] = bytes.toString('utf8');
    } finally { io.closeSync(fd); }
  }
  accountPolicy(texts, who.uid, who.gid);
  // Query the two exact POSIX ACL xattrs using the pre-existing isolated
  // system Python. No installation, environment search, shell or fallback.
  // ENODATA alone means absent; unsupported/permission/other errors refuse.
  for (const path of ['/usr', '/usr/bin', '/usr/lib', '/proc']) snapshots.set(path, { kind: 'parent', stat: observe(path, 'parent') });
  // A hidden PID namespace cannot establish exclusive group access. Reject
  // hidepid even when configured as 0, and require a real visible proc mount.
  const mountInfo = () => {
    const fd = io.openSync('/proc/self/mountinfo', io.constants.O_RDONLY | io.constants.O_NOFOLLOW);
    let text; try { check(io.fstatSync(fd, { bigint: true }).isFile()); text = boundedRead(fd, 262144).toString('utf8'); } finally { io.closeSync(fd); }
    check(text.length > 0 && !text.includes('\0') && !text.includes('\uFFFD'));
    let proc = 0;
    for (const line of text.trimEnd().split('\n')) {
      const parts = line.split(' - '); check(parts.length === 2);
      const left = parts[0].split(' '), right = parts[1].split(' ');
      check(left.length >= 6 && right.length === 3 && /^[0-9]+$/.test(left[0]) && /^[0-9]+$/.test(left[1]));
      if (left[4] === '/proc') { check(right[0] === 'proc' && left[3] === '/'); proc++; }
      if (right[0] === 'proc') check(![...left[5].split(','), ...right[2].split(',')].some(o => /^hidepid(?:=|$)/.test(o)));
    }
    check(proc === 1); return text;
  };
  const initialMountInfo = mountInfo();
  const executable = '/usr/bin/python3' , executableLink = io.lstatSync(executable, { bigint: true });
  const executableTarget = io.realpathSync(executable), executableBefore = io.lstatSync(executableTarget, { bigint: true });
  check(executableLink.uid === 0n && executableLink.gid === 0n && (executableLink.isSymbolicLink() || executableLink.isFile())
    && executableTarget === '/usr/bin/python3.11'
    && executableBefore.isFile() && !executableBefore.isSymbolicLink()
    && executableBefore.uid === 0n && executableBefore.gid === 0n && executableBefore.nlink === 1n
    && mode(executableBefore) === 0o755 && executableBefore.size > 0n && executableBefore.size <= 33554432n);
  const script = `import os,sys,errno
fd=os.open('/var/data',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 a=os.fstat(fd)
 for name in ('system.posix_acl_access','system.posix_acl_default'):
  try: os.getxattr(fd,name)
  except OSError as e:
   if e.errno != errno.ENODATA: sys.exit(2)
  else: sys.exit(3)
 b=os.fstat(fd)
 fields=('st_dev','st_ino','st_uid','st_gid','st_mode','st_nlink','st_size','st_mtime_ns','st_ctime_ns')
 if any(getattr(a,k)!=getattr(b,k) for k in fields): sys.exit(4)
 print('{'+','.join(chr(34)+k+chr(34)+':'+chr(34)+str(getattr(b,k))+chr(34) for k in fields)+'}')
finally: os.close(fd)
`;
  const runtimeStable = () => check(stamp(executableLink) === stamp(io.lstatSync(executable, { bigint: true }))
    && io.realpathSync(executable) === executableTarget && stamp(executableBefore) === stamp(io.lstatSync(executableTarget, { bigint: true })));
  const acl = () => {
    runtimeStable();
    const result = io.execFileSync(executableTarget, ['-I', '-S', '-c', script],
      { encoding: 'utf8', timeout: 2000, maxBuffer: 4096, env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
    check(typeof result === 'string'); const record = JSON.parse(result);
    const fields = { dev:'st_dev',ino:'st_ino',uid:'st_uid',gid:'st_gid',mode:'st_mode',nlink:'st_nlink',size:'st_size',mtimeNs:'st_mtime_ns',ctimeNs:'st_ctime_ns' };
    check(record && Object.keys(record).length === Object.keys(fields).length);
    const expected = snapshots.get('/var/data').stat;
    for (const [key, value] of Object.entries(fields)) check(record[value] === String(expected[key]));
    runtimeStable();
  };
  acl();
  // Local account files do not enumerate retained supplementary credentials.
  // Inspect the complete visible PID namespace twice; any inaccessible/racing
  // process, unknown credential layout, or other writer refuses the operation.
  const pids = () => {
    const ids = io.readdirSync('/proc').filter(p => /^[1-9][0-9]*$/.test(p)).sort();
    check(ids.includes('1') && ids.length <= 4096); return ids;
  };
  const credentials = path => {
    const fd = io.openSync(path, io.constants.O_RDONLY | io.constants.O_NOFOLLOW);
    let text; try { const st = io.fstatSync(fd, { bigint: true }); check(st.isFile()); text = boundedRead(fd, 16384).toString('utf8'); } finally { io.closeSync(fd); }
    const values = new Map();
    for (const line of text.split('\n')) {
      const match = /^(Uid|Gid|Groups|CapEff|CapPrm|NoNewPrivs):\s*(.*?)\s*$/.exec(line); if (!match) continue;
      check(!values.has(match[1])); values.set(match[1], match[2]);
    }
    check(values.size === 6 && /^[01]$/.test(values.get('NoNewPrivs')));
    const ids = key => { const v = values.get(key).split(/\s+/).filter(Boolean); check(v.every(numeric)); return v.map(Number); };
    const uids = ids('Uid'), gids = ids('Gid'), groups = ids('Groups');
    check(uids.length === 4 && gids.length === 4 && groups.length <= 256);
    check(['CapEff','CapPrm'].every(k => /^[a-fA-F0-9]{16}$/.test(values.get(k))));
    if (!uids.every(u => u === 0 || u === who.uid)) check(!gids.includes(who.gid) && !groups.includes(who.gid)
      && BigInt('0x' + values.get('CapEff')) === 0n && BigInt('0x' + values.get('CapPrm')) === 0n);
    return JSON.stringify({ uids, gids, groups, permitted: values.get('CapPrm'), effective: values.get('CapEff'), noNewPrivileges: values.get('NoNewPrivs') });
  };
  const self = JSON.parse(credentials('/proc/self/status'));
  check(self.uids.every(u => u === who.uid) && self.gids.every(g => g === who.gid) && self.groups.length <= 1 && self.groups.every(g => g === who.gid) && self.effective === '0000000000000000' && self.permitted === '0000000000000000' && self.noNewPrivileges === '1');
  let totalTasks = 0;
  const tasks = pid => { const ids = io.readdirSync(`/proc/${pid}/task`).filter(p => /^[1-9][0-9]*$/.test(p)).sort(); check(ids.length > 0 && ids.length <= 1024); return ids; };
  const ids = pids(), taskLists = new Map(), processSnapshots = new Map();
  for (const pid of ids) {
    const tids = tasks(pid); totalTasks += tids.length; check(totalTasks <= 4096); taskLists.set(pid, tids);
    for (const tid of tids) { const path = `/proc/${pid}/task/${tid}/status`; processSnapshots.set(path, credentials(path)); }
  }
  check(JSON.stringify(ids) === JSON.stringify(pids()));
  for (const [pid, tids] of taskLists) check(JSON.stringify(tids) === JSON.stringify(tasks(pid)));
  for (const [path, value] of processSnapshots) check(value === credentials(path));
  acl();
  const afterWho = identity();
  check(JSON.stringify(who) === JSON.stringify(afterWho));
  check(initialMountInfo === mountInfo());
  for (const [path, value] of snapshots) { const stampFor = path === '/proc' ? directoryStamp : stamp; check(stampFor(value.stat) === stampFor(observe(path, value.kind))); }
  return Object.freeze({ path: '/var/data', uid: who.uid, gid: who.gid,
    dev: snapshots.get('/var/data').stat.dev, ino: snapshots.get('/var/data').stat.ino,
    mode: snapshots.get('/var/data').stat.mode });
}

export function verifyRenderPrivateGroupMount() {
  try { return inspect(nativeIo, nativeIdentity); } catch { fail(); }
}

// Test-only read-only metadata seam. The custody writer never accepts this
// seam; fixture observations cannot authorize a native import or key read.
export function verifyRenderPrivateGroupMountFixture({ acknowledgement, io, identity }) {
  check(process.env.NODE_TEST_CONTEXT && acknowledgement === 'PUBLIC_FILESYSTEM_METADATA_FIXTURES_ONLY');
  try { return inspect(io, identity); } catch { fail(); }
}
