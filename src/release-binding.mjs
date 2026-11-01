import {constants,openSync,closeSync,fstatSync,readFileSync,lstatSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {assert} from './protocol.mjs';
import {hashJson} from './core/json.mjs';
export const RELEASE_ROOT=fileURLToPath(new URL('../',import.meta.url)).replace(/\/$/,'');
export const LEGACY_COMMIT='70061654f33aea56ea1f6a1babff411af5c43f2d';
export const RELEASE_SERVICE='srv-dbijuvou01pc73d59c30';
export const RELEASE_ORIGIN='https://mote-testnet-pilot.onrender.com';
export const TRANSITION_PATH='/var/data/mote-usdc/release-transition.json';
const sha=b=>createHash('sha256').update(b).digest('hex');
const exact=(v,keys)=>assert(v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===keys.sort().join(','),'RELEASE_FIELDS');
export function verifyArtifact(root,expected) {
  assert(/^[a-f0-9]{64}$/.test(expected),'RELEASE_HASH');
  const p=join(root,'RELEASE-MANIFEST.json'),bytes=readFileSync(p);assert(sha(bytes)===expected,'RELEASE_HASH');
  const m=JSON.parse(bytes);exact(m,['format','files']);assert(m.format==='mote-release-files-v1'&&Array.isArray(m.files)&&m.files.length>0&&m.files.length<=500,'RELEASE_MANIFEST');
  const seen=new Set();
  for(const row of m.files) {exact(row,['path','sha256']);assert(typeof row.path==='string'&&/^[A-Za-z0-9_./-]+$/.test(row.path)&&!row.path.startsWith('/')&&!row.path.split('/').includes('..')&&!seen.has(row.path)&&/^[a-f0-9]{64}$/.test(row.sha256),'RELEASE_MANIFEST');seen.add(row.path);
    const f=join(root,row.path),s=lstatSync(f);assert(s.isFile()&&!s.isSymbolicLink()&&realpathSync(f)===resolve(f)&&s.size<=16*1024*1024&&sha(readFileSync(f))===row.sha256,'RELEASE_FILE');
  }
  for(const required of ['src/startup.mjs','src/release-binding.mjs','src/legacy-quote-key-file-transition.mjs','src/production-policy.mjs','package-lock.json','LEGACY-PROVENANCE.json'])assert(seen.has(required),'RELEASE_MANIFEST');
  return m;
}
export function validateTransition(record,env,destination) {
  exact(record,['format','serviceId','origin','fromCommit','toCommit','legacyDestinationHash','artifactHash']);
  assert(hashJson(record)===env.MOTE_RELEASE_TRANSITION_HASH,'RELEASE_TRANSITION_HASH');
  assert(record.format==='mote-explicit-source-transition-v1'&&record.serviceId===RELEASE_SERVICE&&record.origin===RELEASE_ORIGIN&&record.fromCommit===LEGACY_COMMIT&&/^[a-f0-9]{40}$/.test(record.toCommit)&&record.toCommit!==record.fromCommit&&/^[a-f0-9]{64}$/.test(record.artifactHash),'RELEASE_TRANSITION');
  assert(env.RENDER==='true'&&env.RENDER_SERVICE_ID===record.serviceId&&env.RENDER_EXTERNAL_URL===record.origin&&env.MOTE_PUBLIC_ORIGIN===record.origin&&env.RENDER_GIT_COMMIT===record.toCommit&&env.IS_PULL_REQUEST!=='true'&&env.MOTE_SOURCE_ARTIFACT_HASH===record.artifactHash,'RELEASE_ENVIRONMENT');
  if(destination)assert(destination.sourceCommit===record.fromCommit&&destination.destinationHash===record.legacyDestinationHash&&destination.serviceId===record.serviceId&&destination.origin===record.origin,'RELEASE_OLD_BINDING');
  return record;
}
export function readTransition(env) {
  const p=TRANSITION_PATH,s=lstatSync(p);assert(s.isFile()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&0o777)===0o600&&s.nlink===1&&s.size<=8192&&realpathSync(p)===p,'RELEASE_TRANSITION_FILE');
  const fd=openSync(p,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes;
  try{const n=fstatSync(fd);assert(n.ino===s.ino&&n.dev===s.dev&&n.size===s.size&&n.mode===s.mode&&n.uid===s.uid&&n.nlink===s.nlink,'RELEASE_TRANSITION_FILE');bytes=readFileSync(fd);}finally{closeSync(fd);}
  const r=validateTransition(JSON.parse(bytes),env);verifyArtifact(RELEASE_ROOT,r.artifactHash);return r;
}
// Only the approved public transition grants the new revision access to the old
// unchanged import. RENDER_GIT_COMMIT is never rewritten. No import records move.
export function authorizeLegacySource(env,destination,fixtureRecord) {
  const r=fixtureRecord??readTransition(env);return validateTransition(r,env,destination);
}
