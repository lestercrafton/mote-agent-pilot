import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { backupTestnetStore, restoreTestnetStore } from '../scripts/testnet-maintenance.mjs';
import { initializeTestnetStore, initializeRestoredTestnetLock, inspectTestnetStoreSnapshot, normalizeTestnetStoreIdentity, TestnetStore } from '../src/testnet-store.mjs';
import { hashJson, prepareAudit } from '../src/json.mjs';

const hex = n => `0x${n.toString(16).padStart(64, '0')}`;
const address = n => `0x${n.toString(16).padStart(40, '0')}`;
const expectedIdentity = normalizeTestnetStoreIdentity({ origin: 'https://pilot.example', chainId: 84532, genesisHash: null, token: address(1), router: address(2), recipient: address(3), quoteSigner: address(4), checkpoint: { blockNumber: '123', blockHash: hex(5) }, configHash: hex(6) });
const otherIdentity = { ...expectedIdentity, router: address(9) };
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');

function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'mote-testnet-backup-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, source: join(directory, 'orders.sqlite'), snapshot: join(directory, 'snapshot.sqlite'), restored: join(directory, 'quarantine.sqlite') };
}
function openFixture(f) { initializeTestnetStore({ path: f.source, identity: expectedIdentity }); return new TestnetStore({ path: f.source, identity: expectedIdentity }); }
function addOrder(store, n, { settled = false, state = 'pending', long = false } = {}) {
  const input = { document: { task: 'public synthetic recovery check', count: n, ...(long ? { note: 'x'.repeat(5000) } : {}) } };
  const audit = prepareAudit(input);
  const id = hex(100 + n), transactionHash = hex(1000 + n), payer = address(100 + n);
  const binding = Object.fromEntries(['chainId', 'origin', 'token', 'router', 'recipient', 'quoteSigner', 'configHash'].map(key => [key, expectedIdentity[key]]));
  const draft = { ...binding, protocol: 'mote-base-sepolia-test-v1', domain: { name: 'MotePayments', version: '1', chainId: expectedIdentity.chainId, verifyingContract: expectedIdentity.router }, publicSynthetic: true, testOnly: true, resultHash: audit.resultHash, quote: { quoteId: id, requestHash: audit.requestHash, payer, amount: audit.amount, deadline: '1900000000' } };
  const row = store.saveDraft({ id, key: `quote-key-${n}`, fingerprint: hashJson({ payer, requestHash: audit.requestHash, publicSynthetic: true }), payer, input, result: audit.result, draft });
  store.saveOffer(id, { ...draft, signature: 'synthetic-storage-test-not-a-signature', offerSignature: 'synthetic-storage-test-not-a-signature' });
  const attemptKey = `attempt-key-${n}`;
  store.bindAttempt(attemptKey, id, transactionHash);
  store.proofState(attemptKey, state);
  if (settled) store.saveResponse(id, transactionHash, { result: audit.result, receipt: { ...binding, protocol: draft.protocol, transactionHash, quoteId: id, requestHash: audit.requestHash, resultHash: audit.resultHash, blockHash: hex(2000 + n), note: 'synthetic retained receipt; current finality must be checked separately' } });
  return { ...row, id, transactionHash, attemptKey };
}
function inspect(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return { summary: inspectTestnetStoreSnapshot(db, expectedIdentity), rows: db.prepare('SELECT data FROM quotes ORDER BY id').all().map(row => JSON.parse(row.data)), attempts: db.prepare('SELECT * FROM attempts ORDER BY idem').all().map(row => ({ ...row })) };
  } finally { db.close(); }
}
const backup = (f, extra = {}) => backupTestnetStore({ source: f.source, destination: f.snapshot, expectedIdentity, ...extra });
const restore = (f, extra = {}) => restoreTestnetStore({ source: f.snapshot, destination: f.restored, expectedIdentity, ...extra });

test('live WAL backup retains orders and unknown/finalized states; restore is permanently recovery-only', async t => {
  const f = fixture(t), store = openFixture(f);
  t.after(() => store.close());
  store.db.exec('PRAGMA wal_autocheckpoint=0;');
  const pending = addOrder(store, 1);
  addOrder(store, 2, { settled: true, state: 'finalized' });
  addOrder(store, 3, { state: 'reorg' });
  assert.ok(lstatSync(f.source + '-wal').size > 0);
  const saved = await backup(f);
  assert.equal(saved.manifest.sha256, digest(f.snapshot));
  assert.deepEqual(saved.manifest.counts, { quotes: 3, attempts: 3 });
  assert.equal(saved.manifest.lockCopied, false);
  assert.equal(existsSync(f.snapshot + '.lock.sqlite'), false);
  const recovered = await restore(f);
  assert.equal(recovered.mode, 'recovery-only');
  assert.equal(recovered.activationAuthorized, false);
  assert.equal(recovered.newQuotes, false);
  assert.equal(recovered.manifest.recoveryRequired, true);
  assert.equal(recovered.manifest.restoreLock.sha256, digest(f.restored + '.lock.sqlite'));
  assert.equal(recovered.manifest.restoredFromSha256, saved.manifest.sha256);
  assert.deepEqual(inspect(f.restored).rows, inspect(f.snapshot).rows);
  assert.deepEqual(inspect(f.restored).attempts, inspect(f.snapshot).attempts);
  assert.deepEqual(inspect(f.restored).summary.attemptStates, { pending: 1, finalized: 1, reorg: 1 });
  assert.equal(inspect(f.restored).rows[0].transactionHash, null);
  assert.equal(lstatSync(f.restored).mode & 0o777, 0o600);
  assert.equal(lstatSync(f.restored + '.lock.sqlite').mode & 0o777, 0o600);
  assert.equal(lstatSync(f.restored + '.manifest.json').mode & 0o777, 0o600);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    assert.equal(existsSync(f.restored + suffix), false);
    assert.equal(existsSync(f.restored + '.lock.sqlite' + suffix), false);
  }
  assert.throws(() => new TestnetStore({ path: f.restored, identity: expectedIdentity }), { code: 'STORE_RECOVERY_REQUIRED' });
  const recovery = new TestnetStore({ path: f.restored, identity: expectedIdentity, recoveryOnly: true });
  assert.equal(recovery.ready(), true);
  assert.equal(recovery.byId(pending.id).response, null);
  assert.throws(() => addOrder(recovery, 4), { code: 'RECOVERY_ONLY' });
  assert.throws(() => recovery.saveOffer(pending.id, {}), { code: 'RECOVERY_ONLY' });
  recovery.close();
  assert.throws(() => new TestnetStore({ path: f.restored, identity: expectedIdentity }), { code: 'STORE_RECOVERY_REQUIRED' });
});

test('backup fixes one WAL snapshot while a separate worker connection changes a proof state', async t => {
  const f = fixture(t), store = openFixture(f);
  t.after(() => store.close());
  for (let n = 1; n <= 3; n++) addOrder(store, n, { long: true });
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData.path);
    const signal = new Int32Array(workerData.signal);
    parentPort.on('message', () => {
      db.prepare('UPDATE attempts SET state=? WHERE idem=?').run('finalized', 'attempt-key-1');
      Atomics.store(signal, 0, 1); Atomics.notify(signal, 0);
    });
    parentPort.postMessage('ready');
  `, { eval: true, workerData: { path: f.source, signal: signal.buffer } });
  t.after(() => worker.terminate());
  await new Promise((ok, fail) => { worker.once('message', ok); worker.once('error', fail); });
  let wrote = false;
  await backup(f, { pagesPerStep: 1, onProgress({ remainingPages }) {
    if (wrote || remainingPages === 0) return;
    worker.postMessage('write');
    assert.notEqual(Atomics.wait(signal, 0, 0, 3000), 'timed-out');
    wrote = true;
  } });
  assert.equal(wrote, true);
  assert.equal(inspect(f.source).attempts[0].state, 'finalized');
  assert.equal(inspect(f.snapshot).attempts[0].state, 'pending');
  // No recorded state is upgraded by maintenance or treated as current finality.
  await restore(f);
  assert.equal(inspect(f.restored).attempts[0].state, 'pending');
});

test('missing post-snapshot orders are not fabricated and restore never enables fresh offers', async t => {
  const f = fixture(t), store = openFixture(f); t.after(() => store.close());
  addOrder(store, 1, { settled: true, state: 'finalized' });
  await backup(f);
  const later = addOrder(store, 2, { settled: true, state: 'finalized' });
  await restore(f);
  const recovery = new TestnetStore({ path: f.restored, identity: expectedIdentity, recoveryOnly: true });
  t.after(() => recovery.close());
  assert.equal(recovery.byId(later.id), null);
  assert.equal(inspect(f.restored).summary.recoveryRequired, true);
  assert.throws(() => addOrder(recovery, 3), { code: 'RECOVERY_ONLY' });
});

test('a backup of a recovery database retains quarantine through another restore', async t => {
  const f = fixture(t), store = openFixture(f); addOrder(store, 1); store.close();
  await backup(f); await restore(f);
  const second = join(f.directory, 'second.sqlite'), third = join(f.directory, 'third.sqlite');
  const saved = await backupTestnetStore({ source: f.restored, destination: second, expectedIdentity });
  assert.equal(saved.manifest.recoveryRequired, true);
  await restoreTestnetStore({ source: second, destination: third, expectedIdentity });
  assert.equal(inspect(third).summary.recoveryRequired, true);
  assert.throws(() => new TestnetStore({ path: third, identity: expectedIdentity }), { code: 'STORE_RECOVERY_REQUIRED' });
});

test('backup and restore require independent identity and reject a different deployment', async t => {
  const f = fixture(t), store = openFixture(f); store.close();
  await assert.rejects(backupTestnetStore({ source: f.source, destination: f.snapshot }), { code: 'EXPECTED_IDENTITY_REQUIRED' });
  await assert.rejects(backup(f, { expectedIdentity: otherIdentity }), { code: 'STORE_IDENTITY_MISMATCH' });
  await backup(f);
  await assert.rejects(restoreTestnetStore({ source: f.snapshot, destination: f.restored }), { code: 'EXPECTED_IDENTITY_REQUIRED' });
  await assert.rejects(restore(f, { expectedIdentity: otherIdentity }), { code: 'IDENTITY_MISMATCH' });
  assert.equal(existsSync(f.restored), false);
});

test('missing input, corrupt SQLite and truncated databases do not initialize destinations', async t => {
  const f = fixture(t);
  await assert.rejects(backup(f), { code: 'SOURCE_MISSING' });
  writeFileSync(f.source, 'not a database');
  await assert.rejects(backup(f), { code: 'INTEGRITY_FAILED' });
  rmSync(f.source); const store = openFixture(f); store.close();
  writeFileSync(f.source, readFileSync(f.source).subarray(0, 128));
  await assert.rejects(backup(f));
  assert.equal(existsSync(f.snapshot), false);
});

test('live store, manifests, lock files and SQLite sidecars are never overwritten', async t => {
  const f = fixture(t), store = openFixture(f); store.close();
  for (const suffix of ['', '.manifest.json', '.lock.sqlite', '-wal', '-shm', '-journal', '.lock.sqlite-wal', '.lock.sqlite-shm', '.lock.sqlite-journal']) {
    writeFileSync(f.snapshot + suffix, 'preserve', { flag: 'wx' });
    await assert.rejects(backup(f), { code: 'DESTINATION_EXISTS' });
    assert.equal(readFileSync(f.snapshot + suffix, 'utf8'), 'preserve');
    rmSync(f.snapshot + suffix);
  }
  await backup(f);
  const oldHash = digest(f.source);
  await assert.rejects(restore(f, { destination: f.source }), { code: 'DESTINATION_EXISTS' });
  assert.equal(digest(f.source), oldHash);
});

test('symlink sources, directory sources and destination symlinks are refused', async t => {
  const f = fixture(t), store = openFixture(f); store.close();
  const alias = join(f.directory, 'alias.sqlite'); symlinkSync(f.source, alias);
  await assert.rejects(backup(f, { source: alias }), { code: 'UNSAFE_FILE' });
  await assert.rejects(backup(f, { source: f.directory }), { code: 'UNSAFE_FILE' });
  symlinkSync(f.source, f.snapshot);
  await assert.rejects(backup(f), { code: 'DESTINATION_EXISTS' });
});

test('manifest corruption, duplicate fields and metadata/hash changes fail closed', async t => {
  const f = fixture(t), store = openFixture(f); store.close();
  const { manifestPath } = await backup(f), original = readFileSync(manifestPath, 'utf8');
  rmSync(manifestPath);
  await assert.rejects(restore(f), { code: 'SOURCE_MISSING' });
  for (const value of ['{', '{"format":"x","format":"y"}', JSON.stringify({ ...JSON.parse(original), identity: otherIdentity }), JSON.stringify({ ...JSON.parse(original), recoveryRequired: true }), JSON.stringify({ ...JSON.parse(original), activationAuthorized: true })]) {
    writeFileSync(manifestPath, value);
    await assert.rejects(restore(f));
    assert.equal(existsSync(f.restored), false);
  }
  writeFileSync(manifestPath, original);
  const db = new DatabaseSync(f.snapshot); db.exec('UPDATE meta SET recovery_required=1'); db.close();
  await assert.rejects(restore(f), { code: 'HASH_MISMATCH' });
});

test('restore rejects unhashed WAL and recovery sidecars', async t => {
  const f = fixture(t), store = openFixture(f); store.close();
  await backup(f);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    writeFileSync(f.snapshot + suffix, 'unhashed');
    await assert.rejects(restore(f), { code: 'SIDECAR_PRESENT' });
    rmSync(f.snapshot + suffix);
  }
});

test('matching a rewritten manifest hash does not admit a different database schema', async t => {
  const f = fixture(t), store = openFixture(f); store.close();
  await backup(f);
  const db = new DatabaseSync(f.snapshot); db.exec('CREATE TABLE unrelated(value TEXT)'); db.close();
  const manifestPath = f.snapshot + '.manifest.json';
  const manifest = JSON.parse(readFileSync(manifestPath));
  manifest.sha256 = digest(f.snapshot); manifest.bytes = lstatSync(f.snapshot).size;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await assert.rejects(restore(f), { code: 'STORE_CORRUPT' });
  assert.equal(existsSync(f.restored), false);
});

test('oversized sparse source fails before allocating a destination snapshot', async t => {
  const f = fixture(t), store = openFixture(f); store.close();
  truncateSync(f.source, 512 * 1024 * 1024 + 1);
  await assert.rejects(backup(f), { code: 'DATABASE_TOO_LARGE' });
  assert.equal(existsSync(f.snapshot), false);
});

test('host databases, payer journals, extra tables and executable schema objects are rejected', async t => {
  const f = fixture(t);
  for (const sql of [
    'CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);',
    'CREATE TABLE meta(id INTEGER PRIMARY KEY,context TEXT,context_hash TEXT);',
  ]) {
    const db = new DatabaseSync(f.source); db.exec(sql); db.close();
    await assert.rejects(backup(f), { code: 'STORE_CORRUPT' }); rmSync(f.source);
  }
  for (const sql of [
    'CREATE TABLE secrets(private_key TEXT);',
    'CREATE VIEW extra AS SELECT * FROM meta;',
    'CREATE INDEX extra_index ON meta(identity);',
    'CREATE TRIGGER extra AFTER UPDATE ON meta BEGIN SELECT 1; END;',
  ]) {
    const store = openFixture(f); store.close();
    const db = new DatabaseSync(f.source); db.exec(sql); db.close();
    await assert.rejects(backup(f), { code: 'STORE_CORRUPT' });
    rmSync(f.source); rmSync(f.source + '.lock.sqlite');
  }
  assert.equal(existsSync(f.snapshot), false);
});

test('order checksum damage, invalid attempt state and dangling references are rejected', async t => {
  const f = fixture(t);
  for (const sql of ["UPDATE quotes SET data_hash='bad'", "UPDATE attempts SET state='assumed-paid'", `UPDATE attempts SET quote_id='${hex(999)}'`]) {
    const store = openFixture(f); addOrder(store, 1); store.close();
    const db = new DatabaseSync(f.source); db.exec('PRAGMA foreign_keys=OFF;'); db.exec(sql); db.close();
    await assert.rejects(backup(f), { code: 'STORE_CORRUPT' });
    rmSync(f.source); rmSync(f.source + '.lock.sqlite');
  }
});

test('source recovery mode change and path replacement during backup prevent publication', async t => {
  const f = fixture(t), store = openFixture(f); addOrder(store, 1, { long: true }); store.close();
  let changed = false;
  await assert.rejects(backup(f, { pagesPerStep: 1, onProgress() {
    if (changed) return; changed = true;
    const db = new DatabaseSync(f.source); db.exec('UPDATE meta SET recovery_required=1'); db.close();
  } }), { code: 'IDENTITY_CHANGED' });
  assert.equal(existsSync(f.snapshot), false);
  changed = false;
  await assert.rejects(backup(f, { pagesPerStep: 1, onProgress() {
    if (changed) return; changed = true;
    renameSync(f.source, f.source + '.old');
    writeFileSync(f.source, readFileSync(f.source + '.old'));
  } }), { code: 'SOURCE_CHANGED' });
  assert.equal(existsSync(f.snapshot), false);
});

test('a concurrent destination owner wins without overwrite', async t => {
  const f = fixture(t), store = openFixture(f); store.close();
  let wrote = false;
  await assert.rejects(backup(f, { pagesPerStep: 1, onProgress() {
    if (!wrote) { wrote = true; writeFileSync(f.snapshot + '.lock.sqlite', 'other-owner', { flag: 'wx' }); }
  } }), { code: 'DESTINATION_EXISTS' });
  assert.equal(readFileSync(f.snapshot + '.lock.sqlite', 'utf8'), 'other-owner');
  assert.equal(existsSync(f.snapshot), false);
});

test('recovery-lock helper cannot grant normal quote authority or overwrite a lock', async t => {
  const f = fixture(t), store = openFixture(f); store.close();
  rmSync(f.source + '.lock.sqlite');
  assert.throws(() => initializeRestoredTestnetLock({ path: f.source, identity: expectedIdentity }), { code: 'STORE_RECOVERY_REQUIRED' });
  assert.equal(existsSync(f.source + '.lock.sqlite'), false);
  const db = new DatabaseSync(f.source); db.exec('UPDATE meta SET recovery_required=1'); db.close();
  initializeRestoredTestnetLock({ path: f.source, identity: expectedIdentity });
  assert.throws(() => initializeRestoredTestnetLock({ path: f.source, identity: expectedIdentity }), { code: 'STORE_EXISTS' });
  assert.equal(inspect(f.source).summary.recoveryRequired, true);
});

test('CLI requires public identity, emits recovery-only mode and rejects in-place restore', t => {
  const f = fixture(t), store = openFixture(f); store.close();
  const identityFile = join(f.directory, 'identity.json'); writeFileSync(identityFile, JSON.stringify(expectedIdentity));
  const script = new URL('../scripts/testnet-maintenance.mjs', import.meta.url).pathname;
  const saved = JSON.parse(execFileSync(process.execPath, [script, 'backup', f.source, f.snapshot, identityFile], { encoding: 'utf8' }));
  const restored = JSON.parse(execFileSync(process.execPath, [script, 'restore', f.snapshot, f.restored, identityFile], { encoding: 'utf8' }));
  assert.equal(saved.activationAuthorized, false);
  assert.equal(restored.mode, 'recovery-only');
  assert.throws(() => execFileSync(process.execPath, [script, 'restore', f.snapshot, f.source, identityFile], { stdio: 'pipe' }), error => error.status === 1 && error.stderr.toString().includes('DESTINATION_EXISTS'));
});
