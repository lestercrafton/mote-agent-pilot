import { statfsSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { assert } from './protocol.mjs';
export const DISK_LIMITS = Object.freeze({ minFreeBytes: 64*1024*1024, maxWalBytes: 32*1024*1024, maxDatabaseBytes: 128*1024*1024 });
function size(path) { try { const s=lstatSync(path); assert(s.isFile() && !s.isSymbolicLink() && s.nlink===1 && (s.mode & 0o077)===0, 'DISK_FILE'); return s.size; } catch(e) { if(e.code==='ENOENT')return 0; throw e; } }
export function diskStatus(path, { statfs = statfsSync, sizeOf = size } = {}) {
  const fs=statfs(dirname(path),{bigint:true}); const free=fs.bavail*fs.bsize;
  const databaseBytes=sizeOf(path), walBytes=sizeOf(path+'-wal');
  return { freeBytes:free.toString(), databaseBytes,walBytes,newAdmissionAllowed:free>=BigInt(DISK_LIMITS.minFreeBytes) && databaseBytes<=DISK_LIMITS.maxDatabaseBytes && walBytes<=DISK_LIMITS.maxWalBytes };
}
export function requireDisk(path, options) { const result=diskStatus(path,options); assert(result.newAdmissionAllowed,'DISK_PRESSURE'); return result; }
