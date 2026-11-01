import { DatabaseSync, backup } from 'node:sqlite';
import { lstatSync, realpathSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, linkSync, unlinkSync, mkdtempSync, chmodSync, existsSync, createReadStream } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { getBytes, verifyMessage, verifyTypedData } from 'ethers';
import { verifySchema, JOURNAL_FORMAT } from './journal-schema.mjs';
import { assert, config, equal, address, requirements, authDomain, AUTH_TYPES, authHash, bindDomain, BIND_TYPES, BINDING, hash32 } from './protocol.mjs';
import { hashJson } from './core/json.mjs';
import { requireDisk, DISK_LIMITS } from './disk.mjs';
const hashFile = async p => {const h=createHash('sha256');for await(const chunk of createReadStream(p,{highWaterMark:65536}))h.update(chunk);return h.digest('hex');};
const fileIdentity = (p,maxBytes=DISK_LIMITS.maxDatabaseBytes) => { const s=lstatSync(p); assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&0o077)===0&&s.size<=maxBytes,'BACKUP_FILE'); return {ino:s.ino,dev:s.dev}; };
function parent(p) { const d=dirname(p),s=lstatSync(d); assert(realpathSync(d)===d&&s.isDirectory()&&s.uid===process.getuid()&&(s.mode&0o077)===0,'BACKUP_DIRECTORY'); }
function sync(p) { const fd=openSync(p,'r'); try{fsyncSync(fd);}finally{closeSync(fd);} }
function publish(staged,target) { sync(staged); linkSync(staged,target); unlinkSync(staged); sync(dirname(target)); }
const parse = s => JSON.parse(s);

function order(c,row) {
  assert(['unknown','complete','unsettled'].includes(row.status),'BACKUP_STATE');
  const p=parse(row.payment), info=p.extensions?.[BINDING]?.info, o=info?.offer, a=p.payload?.authorization;
  assert(p.x402Version===2&&equal(p.accepted,requirements(c))&&o?.body?.configHash===c.identity&&o.body.profile===c.profile&&o.body.resource.url===c.origin+c.path&&equal(p.resource,o.body.resource)&&equal(o.body.requirements,requirements(c)),'BACKUP_PAYMENT');
  assert(Number.isSafeInteger(o.body.issuedAt)&&o.body.expiresAt-o.body.issuedAt===c.offerLifetime&&Number.isSafeInteger(row.created)&&row.created>=o.body.issuedAt&&row.created<Number(a.validBefore)&&row.expiresAt===Number(a.validBefore),'BACKUP_TIME');
  assert(address(verifyMessage(getBytes(hashJson(o.body)),o.signature))===c.offerSigner,'BACKUP_OFFER');
  assert(a.validAfter==='0'&&a.value===c.amount&&address(a.to)===c.payTo&&BigInt(a.validBefore)<=BigInt(o.body.expiresAt)&&hash32(a.nonce),'BACKUP_AUTH');
  const payer=address(verifyTypedData(authDomain(c),AUTH_TYPES,a,p.payload.signature));
  const id=p.extensions?.['payment-identifier']?.info?.id;
  const message={origin:c.origin,method:c.method,path:c.path,requestHash:o.body.requestHash,offerHash:hashJson(o.body),paymentId:id,authorizationHash:authHash(c,a)};
  assert(/^[A-Za-z0-9_-]{16,128}$/.test(id)&&payer===address(a.from)&&payer===row.payer&&id===row.paymentId&&row.authKey===`${c.network}:${c.asset}:${payer}:${a.nonce.toLowerCase()}`&&hashJson({message,accepted:p.accepted})===row.fingerprint,'BACKUP_BINDING');
  assert(address(verifyTypedData(bindDomain(c),BIND_TYPES,message,info.signature))===payer,'BACKUP_BINDING');
  assert(hashJson(parse(row.result))===row.resultHash&&o.body.resultHash===row.resultHash,'BACKUP_RESULT');
  assert(Number.isSafeInteger(row.reservedBytes)&&row.reservedBytes>=Buffer.byteLength(row.payment)+Buffer.byteLength(row.result)+(row.response?Buffer.byteLength(row.response):0)&&(!row.txHash||hash32(row.txHash)),'BACKUP_STORAGE');
  if(row.status==='complete') {
    const r=parse(row.response); assert(r.status==='complete'&&hashJson(r.result)===row.resultHash&&r.receipt.resultHash===row.resultHash&&r.receipt.configHash===c.identity&&r.receipt.requestFingerprint===row.fingerprint&&r.receipt.paymentId===id&&r.receipt.payer===payer&&r.receipt.transaction===row.txHash,'BACKUP_RECEIPT');
    assert(address(verifyMessage(getBytes(hashJson(r.receipt)),r.signature))===c.offerSigner,'BACKUP_RECEIPT');
  } else assert(row.response===null,'BACKUP_STATE');
}
export function inspectJournal(db,expected) {
  verifySchema(db); assert(db.prepare('PRAGMA quick_check').get().quick_check==='ok','BACKUP_INTEGRITY');
  assert(expected?.config&&expected.identity===expected.config.identity&&equal(config(expected.config),expected.config),'BACKUP_EXPECTED_IDENTITY');
  const meta=Object.fromEntries(db.prepare('SELECT * FROM metadata').all().map(r=>[r.key,r.value]));
  assert(Object.keys(meta).sort().join(',')==='format,identity,identityInput,limits,quarantine,role'&&meta.format===JOURNAL_FORMAT&&meta.role==='server'&&['0','1'].includes(meta.quarantine),'BACKUP_METADATA');
  assert(meta.identity===hashJson({identity:expected.identity,limits:expected.limits})&&meta.identityInput===JSON.stringify(expected.identity)&&equal(parse(meta.limits),expected.limits),'BACKUP_IDENTITY');
  assert(db.prepare('SELECT count(*) AS n FROM clients').get().n===0,'CLIENT_BACKUP_FORBIDDEN');
  let count=0, reserved=0;
  for(const row of db.prepare('SELECT * FROM orders').iterate()) { assert(++count<=expected.limits.maxRecords,'BACKUP_LIMIT'); order(expected.config,row); reserved+=row.reservedBytes; }
  assert(reserved<=expected.limits.storageBudgetBytes,'BACKUP_LIMIT');
  const usage=db.prepare('SELECT * FROM usage').all(); assert(usage.length<=1,'BACKUP_USAGE');
  const attempts=usage[0]?.attempts??0; assert((!usage.length||usage[0].epoch===expected.limits.budgetEpoch)&&Number.isSafeInteger(attempts)&&attempts>=count&&attempts<=expected.limits.maxAttempts,'BACKUP_USAGE');
  const verificationCount=db.prepare('SELECT count(*) AS n FROM verification').get().n; assert(verificationCount<=expected.limits.maxVerifications,'BACKUP_LIMIT');
  const rate=db.prepare('SELECT * FROM verify_usage').all(); assert(rate.length<=1&&rate.every(r=>r.singleton===1&&Number.isSafeInteger(r.window)&&r.window>=0&&Number.isSafeInteger(r.attempts)&&r.attempts>=0&&r.attempts<=expected.limits.verifyPerMinute),'BACKUP_RATE');
  return {identity:meta.identity,quarantined:meta.quarantine==='1',counts:{orders:count,attempts,verification:verificationCount},reservedBytes:reserved};
}
// Never a transport: an off-host destination can be recorded for review, but transfer remains disabled.
export function offhostPlan(value={enabled:false,destination:null}) { assert(value.enabled===false&&(value.destination===null||typeof value.destination==='string'&&value.destination.length<=256),'OFFHOST_DISABLED'); return {enabled:false,destination:value.destination}; }

export async function snapshot({source,destination,expected,restore=false,hook=async()=>{}}) {
  source=resolve(source); destination=resolve(destination); parent(source); parent(destination);
  assert(source!==destination&&!existsSync(destination)&&!existsSync(destination+'.manifest.json'),'BACKUP_NO_OVERWRITE');
  const original=fileIdentity(source); requireDisk(source); requireDisk(destination);
  let prior=null;
  if(restore) {
    for(const suffix of ['-wal','-shm','-journal']) assert(!existsSync(source+suffix),'BACKUP_NOT_CLOSED');
    fileIdentity(source+'.manifest.json',65536); prior=parse(readFileSync(source+'.manifest.json','utf8'));
    assert(prior.format==='mote-usdc-snapshot-v1'&&prior.sha256===await hashFile(source)&&prior.expectedHash===hashJson(expected),'BACKUP_MANIFEST');
  }
  const stage=mkdtempSync(join(dirname(destination),'.mote-backup-')); chmodSync(stage,0o700);
  const staged=join(stage,'journal.sqlite');
  const db=new DatabaseSync(source,{readOnly:true}); db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; BEGIN;');
  let before;
  try {
    before=inspectJournal(db,expected);
    const bytes=db.prepare('PRAGMA page_count').get().page_count*db.prepare('PRAGMA page_size').get().page_size;
    assert(bytes<=DISK_LIMITS.maxDatabaseBytes&&BigInt(requireDisk(destination).freeBytes)>=BigInt(bytes+DISK_LIMITS.minFreeBytes),'BACKUP_SPACE');
    await hook('beforeCopy'); await backup(db,staged,{rate:64}); chmodSync(staged,0o600);
    assert(equal(fileIdentity(source),original),'BACKUP_SOURCE_CHANGED');
  } finally { db.exec('ROLLBACK'); db.close(); }
  await hook('afterCopy');
  const out=new DatabaseSync(staged); out.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
  let after;
  try {
    const originalCopy=inspectJournal(out,expected); assert(equal(originalCopy,before),'BACKUP_SNAPSHOT_CHANGED');
    // A snapshot must not become fresh authority even if opened directly without the restore CLI.
    out.prepare("UPDATE metadata SET value='1' WHERE key='quarantine'").run();
    after=inspectJournal(out,expected); assert(after.quarantined,'RESTORE_QUARANTINE');
  } finally {out.close();}
  if(restore) assert(await hashFile(source)===prior.sha256,'BACKUP_SOURCE_CHANGED');
  const manifest={format:'mote-usdc-snapshot-v1',operation:restore?'quarantine-restore':'backup',createdAt:new Date().toISOString(),sha256:await hashFile(staged),expectedHash:hashJson(expected),bytes:lstatSync(staged).size,...after,activationAuthorized:false,offhostEnabled:false};
  const stagedManifest=join(stage,'manifest.json'); writeFileSync(stagedManifest,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  await hook('beforePublish'); publish(staged,destination); await hook('afterDatabasePublish'); publish(stagedManifest,destination+'.manifest.json');
  return {destination,manifestPath:destination+'.manifest.json',manifest};
}
