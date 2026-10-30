import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { constants, chmodSync, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalStringify, parseJson } from '../src/json.mjs';
import { TESTNET_STORE_VERSION, normalizeTestnetStoreIdentity, inspectTestnetStoreSnapshot, initializeRestoredTestnetLock } from '../src/testnet-store.mjs';

// SQLite's online backup API is WAL-aware; copying a live db/WAL file pair is not.
// https://nodejs.org/api/sqlite.html#sqlitebackupsource-db-path-options
// https://sqlite.org/backup.html
const FORMAT = 'mote-testnet-order-snapshot-v1';
const SIDECARS = ['-wal', '-shm', '-journal'];
const MAX_IDENTITY_BYTES = 16_384;
const MAX_MANIFEST_BYTES = 32_768;
const HEADER = Buffer.from('SQLite format 3\0');
const MAX_DATABASE_BYTES = 512 * 1024 * 1024;

export class TestnetMaintenanceError extends Error {
  constructor(code, message, cause) { super(message, { cause }); this.name = 'TestnetMaintenanceError'; this.code = code; }
}
const fail = (code, message, cause) => { throw new TestnetMaintenanceError(code, message, cause); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = canonicalStringify;
const same = (a, b) => canonical(a) === canonical(b);
const present = path => { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

function explicitPath(path) {
  check(typeof path === 'string' && path.length > 0 && !path.includes('\0') && path !== ':memory:', 'INVALID_PATH', 'An explicit filesystem path is required.');
  const absolute = resolve(path);
  return join(realpathSync(dirname(absolute)), basename(absolute));
}

function inspectFile(path) {
  let descriptor;
  try {
    const stat = lstatSync(path);
    check(stat.isFile() && !stat.isSymbolicLink(), 'UNSAFE_FILE', 'Input must be an existing regular file, not a symlink.');
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    check(stat.dev === opened.dev && stat.ino === opened.ino, 'SOURCE_CHANGED', 'Input file identity changed while opening.');
    return { path, dev: opened.dev, ino: opened.ino, size: opened.size, mtimeMs: opened.mtimeMs };
  } catch (error) {
    if (error instanceof TestnetMaintenanceError) throw error;
    fail(error.code === 'ENOENT' ? 'SOURCE_MISSING' : 'SOURCE_UNAVAILABLE', 'Existing input file is unavailable.', error);
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function assertFile(identity, immutable = false) {
  const now = inspectFile(identity.path);
  check(now.dev === identity.dev && now.ino === identity.ino && (!immutable || (now.size === identity.size && now.mtimeMs === identity.mtimeMs)), 'SOURCE_CHANGED', 'Input was replaced or modified during the operation.');
}

function standalone(path) {
  check(SIDECARS.every(suffix => !present(path + suffix)), 'SIDECAR_PRESENT', 'A closed standalone snapshot is required; SQLite recovery sidecars are not accepted.');
}

function publicIdentity(value) {
  const normalized = normalizeTestnetStoreIdentity(value);
  check(Buffer.byteLength(canonical(normalized)) <= MAX_IDENTITY_BYTES, 'IDENTITY_INVALID', 'A bounded, independently supplied public deployment identity is required.');
  return normalized;
}

function inspectSnapshot(db, expectedIdentity) {
  return inspectTestnetStoreSnapshot(db, expectedIdentity);
}

function sameAuthority(a, b) {
  return same(a.identity, b.identity) && a.recoveryRequired === b.recoveryRequired;
}

function integrity(db) {
  const rows = db.prepare('PRAGMA integrity_check').all();
  check(rows.length === 1 && rows[0].integrity_check === 'ok', 'INTEGRITY_FAILED', 'SQLite integrity_check did not return ok.');
}

function openDatabase(path) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const header = Buffer.alloc(HEADER.length);
    check(readSync(descriptor, header, 0, header.length, 0) === HEADER.length && header.equals(HEADER), 'INTEGRITY_FAILED', 'Input is not a SQLite database.');
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
  return new DatabaseSync(path, { readOnly: true, allowExtension: false, defensive: true, timeout: 3000 });
}

function fileHash(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const digest = createHash('sha256');
    const chunk = Buffer.alloc(64 * 1024);
    let bytes;
    while ((bytes = readSync(descriptor, chunk, 0, chunk.length, null)) !== 0) digest.update(chunk.subarray(0, bytes));
    return digest.digest('hex');
  } finally { closeSync(descriptor); }
}

function syncFile(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function checkDestination(destination) {
  for (const path of [destination, destination + '.manifest.json', destination + '.lock.sqlite', ...SIDECARS.flatMap(suffix => [destination + suffix, destination + '.lock.sqlite' + suffix])]) {
    check(!present(path), 'DESTINATION_EXISTS', 'Destination, manifest, and SQLite sidecar paths must all be new. Existing files are never overwritten.');
  }
}

function options(input) {
  check(input && typeof input === 'object' && Object.keys(input).every(key => ['source', 'destination', 'expectedIdentity', 'pagesPerStep', 'onProgress'].includes(key)), 'INVALID_OPTIONS', 'Unsupported maintenance option.');
  check(input.expectedIdentity !== undefined, 'EXPECTED_IDENTITY_REQUIRED', 'Backup and restore both require an independently supplied deployment identity.');
  const source = explicitPath(input.source);
  const destination = explicitPath(input.destination);
  check(source !== destination, 'DESTINATION_EXISTS', 'Backup and restore destinations must be new paths.');
  const expectedIdentity = publicIdentity(input.expectedIdentity);
  const pagesPerStep = input.pagesPerStep ?? 100;
  check(Number.isSafeInteger(pagesPerStep) && pagesPerStep > 0 && pagesPerStep <= 1000, 'INVALID_OPTIONS', 'pagesPerStep must be an integer from 1 to 1000.');
  check(input.onProgress === undefined || typeof input.onProgress === 'function', 'INVALID_OPTIONS', 'onProgress must be a function.');
  return { source, destination, expectedIdentity, pagesPerStep, onProgress: input.onProgress };
}

function readManifest(source) {
  standalone(source);
  const identity = inspectFile(source + '.manifest.json');
  check(identity.size > 0 && identity.size <= MAX_MANIFEST_BYTES, 'INVALID_MANIFEST', 'Snapshot manifest size is invalid.');
  let manifest;
  try { manifest = parseJson(readFileSync(identity.path, 'utf8')); } catch (error) { fail('INVALID_MANIFEST', 'Snapshot manifest is not valid unambiguous JSON.', error); }
  const keys = ['format', 'operation', 'createdAt', 'sha256', 'bytes', 'identity', 'identitySha256', 'storeVersion', 'recoveryRequired', 'counts', 'integrityCheck', 'restoredFromSha256', 'activationAuthorized', 'lockCopied', 'restoreLock'];
  check(manifest && Object.getPrototypeOf(manifest) === Object.prototype && Object.keys(manifest).sort().join() === keys.sort().join() && manifest.format === FORMAT && ['backup', 'quarantine-restore'].includes(manifest.operation) && typeof manifest.createdAt === 'string' && Number.isFinite(Date.parse(manifest.createdAt)) && /^[a-f0-9]{64}$/.test(manifest.sha256) && Number.isSafeInteger(manifest.bytes) && manifest.bytes > 0 && manifest.bytes <= MAX_DATABASE_BYTES && manifest.integrityCheck === 'ok' && manifest.storeVersion === TESTNET_STORE_VERSION && typeof manifest.recoveryRequired === 'boolean' && manifest.activationAuthorized === false && manifest.lockCopied === false && (manifest.restoredFromSha256 === null || /^[a-f0-9]{64}$/.test(manifest.restoredFromSha256)), 'INVALID_MANIFEST', 'Snapshot manifest fields are invalid.');
  check(manifest.counts && Object.keys(manifest.counts).sort().join() === 'attempts,quotes' && Object.values(manifest.counts).every(value => Number.isSafeInteger(value) && value >= 0), 'INVALID_MANIFEST', 'Snapshot row counts are invalid.');
  check(manifest.operation === 'backup' ? manifest.restoreLock === null && manifest.restoredFromSha256 === null : manifest.recoveryRequired && manifest.restoredFromSha256 !== null && manifest.restoreLock && Object.keys(manifest.restoreLock).sort().join() === 'bytes,sha256' && /^[a-f0-9]{64}$/.test(manifest.restoreLock.sha256) && Number.isSafeInteger(manifest.restoreLock.bytes) && manifest.restoreLock.bytes > 0, 'INVALID_MANIFEST', 'Snapshot recovery mode is invalid.');
  manifest.identity = publicIdentity(manifest.identity);
  check(manifest.identitySha256 === hash(canonical(manifest.identity)), 'INVALID_MANIFEST', 'Identity digest mismatch.');
  assertFile(identity, true);
  return { manifest, identity };
}

async function snapshot(input, restore) {
  let db, staging;
  const published = [];
  const { source, destination, expectedIdentity, pagesPerStep, onProgress } = options(input);
  const sourceIdentity = inspectFile(source);
  check(sourceIdentity.size <= MAX_DATABASE_BYTES, 'DATABASE_TOO_LARGE', 'Source exceeds the 512 MiB maintenance bound.');
  checkDestination(destination);
  let previous;
  try {
    if (restore) {
      previous = readManifest(source);
      check(same(previous.manifest.identity, expectedIdentity), 'IDENTITY_MISMATCH', 'Snapshot identity differs from the independently supplied deployment configuration.');
      check(previous.manifest.bytes === sourceIdentity.size && fileHash(source) === previous.manifest.sha256, 'HASH_MISMATCH', 'Snapshot bytes do not match the SHA-256 manifest.');
      assertFile(sourceIdentity, true);
    }
    db = openDatabase(source);
    assertFile(sourceIdentity, restore);
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN;');
    // Fix one WAL read snapshot. Concurrent new orders may commit after it.
    const before = inspectSnapshot(db, expectedIdentity);
    integrity(db);
    if (restore) check(same(before.identity, previous.manifest.identity) && before.recoveryRequired === previous.manifest.recoveryRequired && same(before.counts, previous.manifest.counts), 'IDENTITY_MISMATCH', 'Database metadata/counts disagree with its manifest.');
    const pageCount = db.prepare('PRAGMA page_count').get().page_count;
    const pageSize = db.prepare('PRAGMA page_size').get().page_size;
    check(Number.isSafeInteger(pageCount) && Number.isSafeInteger(pageSize) && pageCount > 0 && pageSize > 0 && pageCount * pageSize <= MAX_DATABASE_BYTES, 'DATABASE_TOO_LARGE', 'WAL snapshot exceeds the 512 MiB maintenance bound.');
    const filesystem = statfsSync(dirname(destination), { bigint: true });
    check(filesystem.bavail * filesystem.bsize >= BigInt(pageCount) * BigInt(pageSize) + 64n * 1024n * 1024n, 'INSUFFICIENT_SPACE', 'Snapshot requires its full page size plus 64 MiB of free headroom; no files are deleted or storage resized automatically.');
    staging = mkdtempSync(join(dirname(destination), '.mote-testnet-snapshot-'));
    const staged = join(staging, 'orders.sqlite');
    const pages = await backup(db, staged, { rate: pagesPerStep, progress: onProgress });
    db.exec('COMMIT;');
    check(sameAuthority(inspectSnapshot(db, expectedIdentity), before), 'IDENTITY_CHANGED', 'Source identity or recovery mode changed during backup; no output is published.');
    assertFile(sourceIdentity, restore);
    db.close(); db = undefined;
    if (restore) {
      standalone(source);
      assertFile(previous.identity, true);
      check(fileHash(source) === previous.manifest.sha256, 'HASH_MISMATCH', 'Snapshot changed during restore.');
    }
    let after;
    const output = new DatabaseSync(staged, { allowExtension: false, defensive: true });
    try {
      output.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
      check(sameAuthority(inspectSnapshot(output, expectedIdentity), before), 'IDENTITY_CHANGED', 'Copied snapshot authority differs from the pinned source.');
      if (restore) {
        output.exec('BEGIN IMMEDIATE; UPDATE meta SET recovery_required=1 WHERE id=1; COMMIT;');
      }
      after = inspectSnapshot(output, expectedIdentity);
      check(!restore || after.recoveryRequired, 'RECOVERY_GATE_FAILED', 'Restored database must be durably quarantined.');
      check(output.prepare('PRAGMA journal_mode=DELETE').get().journal_mode === 'delete', 'SNAPSHOT_INCOMPLETE', 'Unable to produce a standalone snapshot.');
    } finally { output.close(); }
    standalone(staged);
    check(lstatSync(staged).size <= MAX_DATABASE_BYTES, 'DATABASE_TOO_LARGE', 'Snapshot exceeds the 512 MiB maintenance bound.');
    chmodSync(staged, 0o600);
    let restoreLock = null;
    if (restore) {
      // This explicit helper creates a fresh lock only for validated gate=1 state.
      // No original lock, payer journal or signing material is copied.
      initializeRestoredTestnetLock({ path: staged, identity: expectedIdentity });
      const lock = new DatabaseSync(staged + '.lock.sqlite', { allowExtension: false, defensive: true });
      try { integrity(lock); check(lock.prepare('PRAGMA journal_mode=DELETE').get().journal_mode === 'delete', 'SNAPSHOT_INCOMPLETE', 'Unable to close the new recovery lock.'); }
      finally { lock.close(); }
      standalone(staged + '.lock.sqlite');
      chmodSync(staged + '.lock.sqlite', 0o600);
      restoreLock = { sha256: fileHash(staged + '.lock.sqlite'), bytes: lstatSync(staged + '.lock.sqlite').size };
      const verify = openDatabase(staged);
      try { check(inspectSnapshot(verify, expectedIdentity).recoveryRequired, 'RECOVERY_GATE_FAILED', 'Lock initialization must never clear quarantine.'); }
      finally { verify.close(); }
    }
    const manifest = {
      format: FORMAT, operation: restore ? 'quarantine-restore' : 'backup', createdAt: new Date().toISOString(),
      sha256: fileHash(staged), bytes: lstatSync(staged).size,
      identity: after.identity, identitySha256: hash(canonical(after.identity)),
      storeVersion: TESTNET_STORE_VERSION, recoveryRequired: after.recoveryRequired,
      counts: after.counts, integrityCheck: 'ok', restoredFromSha256: previous?.manifest.sha256 ?? null,
      activationAuthorized: false, lockCopied: false, restoreLock,
    };
    const stagedManifest = join(staging, 'manifest.json');
    writeFileSync(stagedManifest, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    syncFile(staged); syncFile(stagedManifest);
    if (restore) syncFile(staged + '.lock.sqlite');
    checkDestination(destination);
    // Publish fresh files only; the manifest is the last completion marker.
    // A crash before all files exist fails closed rather than repairing itself.
    for (const [from, to] of [[staged, destination], ...(restore ? [[staged + '.lock.sqlite', destination + '.lock.sqlite']] : []), [stagedManifest, destination + '.manifest.json']]) {
      const owned = inspectFile(from);
      linkSync(from, to);
      published.push({ ...owned, path: to });
      assertFile(published[published.length - 1]);
    }
    syncFile(dirname(destination));
    return { destination, manifestPath: destination + '.manifest.json', lockPath: restore ? destination + '.lock.sqlite' : null, pages, manifest, activationAuthorized: false, mode: restore ? 'recovery-only' : 'snapshot', newQuotes: false };
  } catch (error) {
    for (const identity of published.reverse()) {
      try { assertFile(identity); unlinkSync(identity.path); } catch {}
    }
    if (error instanceof TestnetMaintenanceError) throw error;
    if (typeof error.code === 'string' && error.code.startsWith('STORE_')) throw error;
    fail(error.code === 'EEXIST' ? 'DESTINATION_EXISTS' : 'TESTNET_MAINTENANCE_FAILED', 'Testnet maintenance failed; no existing database was overwritten. Preserve incomplete files for inspection.', error);
  } finally {
    try { db?.close(); } catch {}
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
}

export const backupTestnetStore = input => snapshot(input, false);
export const restoreTestnetStore = input => snapshot(input, true);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  try {
    const [operation, source, destination, expectedPath, ...extra] = process.argv.slice(2);
    check(['backup', 'restore'].includes(operation) && source && destination && expectedPath && !extra.length, 'USAGE', 'Usage: node scripts/testnet-maintenance.mjs backup|restore SOURCE NEW_DESTINATION EXPECTED_PUBLIC_IDENTITY_JSON_FILE. Restore is always recovery-only.');
    const expected = inspectFile(explicitPath(expectedPath));
    check(expected.size > 0 && expected.size <= MAX_IDENTITY_BYTES, 'IDENTITY_INVALID', 'Expected identity file size is invalid.');
    const expectedIdentity = parseJson(readFileSync(expected.path, 'utf8'));
    assertFile(expected, true);
    const result = await (operation === 'backup' ? backupTestnetStore : restoreTestnetStore)({ source, destination, expectedIdentity });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: { code: error.code ?? 'TESTNET_MAINTENANCE_FAILED', message: error instanceof TestnetMaintenanceError ? error.message : 'Maintenance failed. Check public identity, paths and supported paid-order schema.' } }) + '\n');
    process.exitCode = 1;
  }
}
