import { DatabaseSync } from 'node:sqlite';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isIP } from 'node:net';
import { getAddress, ZeroAddress } from 'ethers';
import { canonicalStringify, hashJson, hashText, MoteError, prepareAudit } from './json.mjs';
import { getTestnetNetwork } from './testnet-networks.mjs';

export const TESTNET_STORE_VERSION = 1;
export const TESTNET_STORE_ROW_ENCODING = 'mote-order-elision-v1';
export const TESTNET_STORE_LIMITS = Object.freeze({ quotes: 1000, attempts: 4000, quotesPerPayer: 20 });
export const TESTNET_STORE_SCHEMA = Object.freeze({
  meta: 'CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, identity TEXT NOT NULL, identity_hash TEXT NOT NULL, recovery_required INTEGER NOT NULL CHECK(recovery_required IN (0,1)))',
  quotes: 'CREATE TABLE quotes (id TEXT PRIMARY KEY, idem TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL, payer TEXT NOT NULL, data TEXT NOT NULL, data_hash TEXT NOT NULL, transaction_hash TEXT UNIQUE)',
  attempts: 'CREATE TABLE attempts (idem TEXT PRIMARY KEY, quote_id TEXT NOT NULL REFERENCES quotes(id), transaction_hash TEXT NOT NULL, state TEXT NOT NULL)',
});
export const TESTNET_LOCK_SCHEMA = 'CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL)';
const HEX = /^0x[0-9a-fA-F]{64}$/;
const ROW_FIELDS = ['id', 'key', 'fingerprint', 'payer', 'input', 'result', 'draft', 'offer', 'response', 'transactionHash'];
const ROW_BYTES = 524288;
const shape = value => value.replace(/\s+/g, ' ').trim().replace(/;$/, '');
const fail = (code, message, status = 503) => { throw new MoteError(code, message, status); };
const check = (condition, code, message, status) => { if (!condition) fail(code, message, status); };
const clone = value => structuredClone(value);

export function normalizeTestnetStoreIdentity(input) {
  const fields = ['origin', 'chainId', 'genesisHash', 'token', 'router', 'recipient', 'quoteSigner', 'checkpoint', 'configHash'];
  check(input && Object.getPrototypeOf(input) === Object.prototype && Object.keys(input).sort().join() === fields.sort().join(), 'STORE_IDENTITY_INVALID', 'Exact public deployment identity is required.');
  const identity = clone(input);
  try { getTestnetNetwork(identity.chainId); } catch { fail('STORE_IDENTITY_INVALID', 'Only explicitly pinned Base Sepolia 84532 or Ethereum Sepolia 11155111 identities are supported.'); }
  let url;
  try { url = new URL(identity.origin); } catch { fail('STORE_IDENTITY_INVALID', 'A canonical public HTTPS origin is required.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  check(url.protocol === 'https:' && url.origin === identity.origin && !url.username && !url.password && !url.port && host !== 'localhost' && !host.endsWith('.localhost') && !isIP(host), 'STORE_IDENTITY_INVALID', 'A canonical public HTTPS origin is required.');
  for (const key of ['token', 'router', 'recipient', 'quoteSigner']) {
    try { identity[key] = getAddress(identity[key]).toLowerCase(); } catch { fail('STORE_IDENTITY_INVALID', 'Invalid deployment address.'); }
    check(identity[key] !== ZeroAddress, 'STORE_IDENTITY_INVALID', 'Deployment addresses must be nonzero.');
  }
  for (const key of ['genesisHash', 'configHash']) { if (key === 'genesisHash' && identity[key] === null) continue; check(typeof identity[key] === 'string' && HEX.test(identity[key]), 'STORE_IDENTITY_INVALID', 'Invalid deployment hash.'); identity[key] = identity[key].toLowerCase(); }
  check(identity.chainId !== 11155111 || identity.genesisHash !== null, 'STORE_IDENTITY_INVALID', 'Ethereum Sepolia identities require a verified genesis binding.');
  check(identity.checkpoint && Object.keys(identity.checkpoint).sort().join() === 'blockHash,blockNumber' && ((Number.isSafeInteger(identity.checkpoint.blockNumber) && identity.checkpoint.blockNumber >= 0) || (typeof identity.checkpoint.blockNumber === 'string' && /^(0|[1-9]\d{0,77})$/.test(identity.checkpoint.blockNumber))) && typeof identity.checkpoint.blockHash === 'string' && HEX.test(identity.checkpoint.blockHash), 'STORE_IDENTITY_INVALID', 'A pinned deployment checkpoint is required.');
  identity.checkpoint.blockNumber = String(identity.checkpoint.blockNumber);
  identity.checkpoint.blockHash = identity.checkpoint.blockHash.toLowerCase();
  return identity;
}

function inspect(path) {
  let fd;
  try {
    const stat = lstatSync(path);
    const directory = lstatSync(dirname(path));
    check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o600) === 0o600, 'STORE_UNAVAILABLE', 'Store must be a writable regular file with one link.');
    check(directory.isDirectory() && !directory.isSymbolicLink() && (directory.mode & 0o700) === 0o700 && realpathSync(dirname(path)) === dirname(path), 'STORE_UNAVAILABLE', 'Store directory must be canonical and writable.');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    check(opened.dev === stat.dev && opened.ino === stat.ino, 'STORE_FILE_CHANGED', 'Store changed while opening.');
    const header = Buffer.alloc(16);
    check(readSync(fd, header, 0, 16, 0) === 16 && header.equals(Buffer.from('SQLite format 3\0')), 'STORE_CORRUPT', 'Store does not have a valid SQLite header.');
    return { dev: stat.dev, ino: stat.ino, directoryDev: directory.dev, directoryIno: directory.ino };
  } catch (error) {
    if (error instanceof MoteError) throw error;
    fail(error.code === 'ENOENT' ? 'STORE_MISSING' : 'STORE_UNAVAILABLE', 'Existing paid store and lock files are required; startup never initializes them.');
  } finally { if (fd !== undefined) closeSync(fd); }
}
function sameFile(path, pinned) {
  const current = inspect(path);
  check(Object.keys(pinned).every(key => pinned[key] === current[key]), 'STORE_FILE_CHANGED', 'Store identity changed; stop and reconcile.');
}
function schema(db, tables) {
  const entries = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name").all();
  const expected = Object.keys(tables).sort();
  check(entries.length === expected.length && entries.every((row, i) => row.name === expected[i] && shape(row.sql) === shape(tables[row.name])), 'STORE_CORRUPT', 'Unexpected store schema.');
  check(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type IN ('view','trigger') OR (type='index' AND sql IS NOT NULL)").get().n === 0, 'STORE_CORRUPT', 'Unexpected executable schema object.');
  check(db.prepare('PRAGMA user_version').get().user_version === TESTNET_STORE_VERSION, 'STORE_CORRUPT', 'Unsupported store version.');
}
function integrity(db) {
  const rows = db.prepare('PRAGMA integrity_check').all();
  check(rows.length === 1 && rows[0].integrity_check === 'ok' && db.prepare('PRAGMA foreign_key_check').all().length === 0, 'STORE_CORRUPT', 'Store integrity check failed.');
}
function validateRow(row, raw, expectedIdentity) {
  check(row && Object.keys(row).sort().join() === ROW_FIELDS.slice().sort().join() && row.id === raw.id && row.key === raw.idem && row.fingerprint === raw.fingerprint && row.payer === raw.payer && row.transactionHash === raw.transaction_hash && HEX.test(row.id) && HEX.test(row.fingerprint) && (row.transactionHash === null || HEX.test(row.transactionHash)) && row.draft?.publicSynthetic === true && row.draft?.testOnly === true && row.draft?.quote?.quoteId === row.id, 'STORE_CORRUPT', 'Order structure or indexing disagrees.');
  check((row.response === null && row.transactionHash === null) || (row.response && row.offer && row.transactionHash && row.response.receipt?.transactionHash === row.transactionHash), 'STORE_CORRUPT', 'Order settlement state is inconsistent.');
  try {
    const network = getTestnetNetwork(row.draft.chainId);
    check(row.draft.protocol === network.protocol && canonicalStringify(row.draft.domain) === canonicalStringify({ name: 'MotePayments', version: '1', chainId: network.chainId, verifyingContract: row.draft.router }), 'STORE_CORRUPT', 'Stored offer protocol or signature domain does not match its network.');
    if (expectedIdentity) check(['chainId', 'origin', 'token', 'router', 'recipient', 'quoteSigner', 'configHash'].every(key => row.draft[key] === expectedIdentity[key]), 'STORE_CORRUPT', 'Stored order belongs to another network or deployment identity.');
    const prepared = prepareAudit(row.input);
    check(canonicalStringify(row.result) === canonicalStringify(prepared.result) && row.draft.resultHash === prepared.resultHash && row.draft.quote.requestHash === prepared.requestHash && row.draft.quote.amount === prepared.amount && row.draft.quote.payer === row.payer && row.fingerprint === hashJson({ payer: row.payer, requestHash: prepared.requestHash, publicSynthetic: true }), 'STORE_CORRUPT', 'Stored input, result and quote commitments disagree.');
    if (row.offer) {
      const { signature, offerSignature, ...draft } = row.offer;
      check(typeof signature === 'string' && typeof offerSignature === 'string' && canonicalStringify(draft) === canonicalStringify(row.draft), 'STORE_CORRUPT', 'Stored signed offer differs from the committed draft.');
    }
    if (row.response) check(canonicalStringify(row.response.result) === canonicalStringify(row.result) && row.response.receipt.resultHash === prepared.resultHash && row.response.receipt.quoteId === row.id && row.response.receipt.requestHash === prepared.requestHash && row.response.receipt.protocol === network.protocol && ['chainId', 'origin', 'token', 'router', 'recipient', 'quoteSigner', 'configHash'].every(key => row.response.receipt[key] === row.draft[key]), 'STORE_CORRUPT', 'Stored delivery differs from the signed result commitment or pinned network.');
  } catch (error) { if (error.code === 'STORE_CORRUPT') throw error; fail('STORE_CORRUPT', 'Stored public synthetic input is invalid.'); }
  return row;
}

function expandRow(stored) {
  // Direct rows are the original on-disk representation. Reading one does not
  // rewrite it. Older binaries fail closed on this explicitly marked envelope.
  if (!stored || (!Object.hasOwn(stored, 'encoding') && !Object.hasOwn(stored, 'row'))) return stored;
  check(Object.keys(stored).sort().join() === 'encoding,row' && stored.encoding === TESTNET_STORE_ROW_ENCODING, 'STORE_CORRUPT', 'Unsupported order encoding.');
  const row = stored.row;
  check(row && !Array.isArray(row) && row.result && !Array.isArray(row.result) && Object.hasOwn(row.result, 'canonicalJson') && row.result.canonicalJson === null && (row.response === null || (row.response && !Array.isArray(row.response) && Object.hasOwn(row.response, 'result') && row.response.result === null)), 'STORE_CORRUPT', 'Invalid compact order placeholders.');
  try {
    // Only duplicated bytes are reconstructed. Validation metadata, signed
    // commitments, offers and receipts remain stored exactly as supplied.
    row.result.canonicalJson = canonicalStringify(row.input.document);
    if (row.response) row.response.result = clone(row.result);
    check(Buffer.byteLength(JSON.stringify(row)) <= ROW_BYTES, 'STORE_CORRUPT', 'Expanded order exceeds the durable record limit.');
  } catch (error) { if (error.code === 'STORE_CORRUPT') throw error; fail('STORE_CORRUPT', 'Invalid compact order input.'); }
  return row;
}

/** Serializes a fully validated order without repeating its document. Both
 * encoded and expanded records retain the original admission bound. The full
 * result is checked before elision, so encoding cannot repair a mismatched
 * canonical result or response. No compression or cross-order references. */
export function encodeTestnetStoreRow(row, expectedIdentity) {
  let expanded;
  try { expanded = JSON.stringify(row); } catch { fail('STORE_CORRUPT', 'Invalid prepared order.'); }
  check(typeof expanded === 'string' && Buffer.byteLength(expanded) <= ROW_BYTES, 'STORE_LIMIT', 'Prepared order exceeds the durable record limit.');
  const checked = validateRow(JSON.parse(expanded), { id: row.id, idem: row.key, fingerprint: row.fingerprint, payer: row.payer, transaction_hash: row.transactionHash }, expectedIdentity);
  const compact = clone(checked);
  compact.result.canonicalJson = null;
  if (compact.response) compact.response.result = null;
  const data = JSON.stringify({ encoding: TESTNET_STORE_ROW_ENCODING, row: compact });
  check(Buffer.byteLength(data) <= ROW_BYTES, 'STORE_LIMIT', 'Encoded order exceeds the durable record limit.');
  // A legacy response can have a semantically equal result with a different key
  // order. Preserve its exact serialization instead of normalizing that order.
  if (JSON.stringify(expandRow(JSON.parse(data))) !== expanded) return expanded;
  return data;
}

export function decodeTestnetStoreRow(raw, expectedIdentity) {
  if (!raw) return null;
  check(typeof raw.data === 'string' && Buffer.byteLength(raw.data) <= ROW_BYTES && hashText(raw.data) === raw.data_hash, 'STORE_CORRUPT', 'Order checksum failed.');
  let stored; try { stored = JSON.parse(raw.data); } catch { fail('STORE_CORRUPT', 'Invalid stored order.'); }
  return validateRow(expandRow(stored), raw, expectedIdentity);
}
/** Read-only inspection, also usable inside the maintenance tool's explicit read
 * transaction. Never clears quarantine or starts a service. */
export function inspectTestnetStoreSnapshot(db, expectedIdentity) {
  const identity = normalizeTestnetStoreIdentity(expectedIdentity);
  const serialized = canonicalStringify(identity);
  schema(db, TESTNET_STORE_SCHEMA); integrity(db);
  const meta = db.prepare('SELECT * FROM meta WHERE id=1').get();
  check(meta?.version === TESTNET_STORE_VERSION && meta.identity === serialized && meta.identity_hash === hashText(serialized) && [0, 1].includes(meta.recovery_required) && db.prepare('SELECT count(*) AS n FROM meta').get().n === 1, 'STORE_IDENTITY_MISMATCH', 'Snapshot does not match the independently pinned deployment.');
  const counts = { quotes: db.prepare('SELECT count(*) AS n FROM quotes').get().n, attempts: db.prepare('SELECT count(*) AS n FROM attempts').get().n };
  check(counts.quotes <= TESTNET_STORE_LIMITS.quotes && counts.attempts <= TESTNET_STORE_LIMITS.attempts, 'STORE_CORRUPT', 'Snapshot exceeds compiled admission limits.');
  for (const raw of db.prepare('SELECT * FROM quotes').iterate()) decodeTestnetStoreRow(raw, identity);
  const attemptStates = {};
  for (const row of db.prepare('SELECT * FROM attempts').iterate()) {
    check(typeof row.idem === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(row.idem) && HEX.test(row.quote_id) && HEX.test(row.transaction_hash) && ['unverified', 'pending', 'finalized', 'reorg', 'rejected'].includes(row.state), 'STORE_CORRUPT', 'Invalid stored reconciliation attempt.');
    attemptStates[row.state] = (attemptStates[row.state] ?? 0) + 1;
  }
  return { identity, identityHash: hashText(serialized), recoveryRequired: meta.recovery_required === 1, counts, attemptStates };
}
function open(path) { return new DatabaseSync(path, { allowExtension: false, defensive: true }); }
function createFile(path) {
  let fd;
  try { fd = openSync(path, 'wx', 0o600); } catch (error) { fail(error.code === 'EEXIST' ? 'STORE_EXISTS' : 'STORE_UNAVAILABLE', 'Explicit initialization requires two new paths; existing files are never overwritten.'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Explicit offline initialization only. No keys, network access, or implicit restore.
 * Partial initialization is preserved for inspection and is never auto-repaired. */
export function initializeTestnetStore({ path, identity }) {
  const filename = resolve(path);
  const normalized = normalizeTestnetStoreIdentity(identity);
  const serialized = canonicalStringify(normalized);
  const dir = lstatSync(dirname(filename));
  check(dir.isDirectory() && !dir.isSymbolicLink() && (dir.mode & 0o700) === 0o700 && realpathSync(dirname(filename)) === dirname(filename), 'STORE_UNAVAILABLE', 'Initialization requires an existing canonical writable directory.');
  // Check both names before creating either; an incomplete previous initialization
  // requires inspection, never automatic replacement.
  for (const name of [filename, filename + '.lock.sqlite']) {
    try { lstatSync(name); fail('STORE_EXISTS', 'Store or gate already exists.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  createFile(filename);
  createFile(filename + '.lock.sqlite');
  for (const [name, gate] of [[filename, false], [filename + '.lock.sqlite', true]]) {
    const db = open(name);
    try {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
      if (gate) { db.exec(TESTNET_LOCK_SCHEMA); db.prepare('INSERT INTO meta VALUES (1,?)').run(serialized); }
      else { for (const sql of Object.values(TESTNET_STORE_SCHEMA)) db.exec(sql); db.prepare('INSERT INTO meta VALUES (1,?,?,?,0)').run(TESTNET_STORE_VERSION, serialized, hashText(serialized)); }
      db.exec(`PRAGMA user_version=${TESTNET_STORE_VERSION}; COMMIT;`);
    } finally { db.close(); }
  }
  return { path: filename, lockPath: filename + '.lock.sqlite', identity: normalized };
}

/** Creates only a new process gate beside an independently checked quarantined
 * restore. It cannot create orders, clear quarantine, or grant quote authority. */
export function initializeRestoredTestnetLock({ path, identity }) {
  const filename = resolve(path);
  const pinned = inspect(filename);
  const db = new DatabaseSync(filename, { readOnly: true, allowExtension: false, defensive: true });
  let inspected;
  try { inspected = inspectTestnetStoreSnapshot(db, identity); } finally { db.close(); }
  check(inspected.recoveryRequired, 'STORE_RECOVERY_REQUIRED', 'Only a quarantined restored database may receive a new recovery gate.');
  sameFile(filename, pinned);
  createFile(filename + '.lock.sqlite');
  const gate = open(filename + '.lock.sqlite');
  try {
    gate.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
    gate.exec(TESTNET_LOCK_SCHEMA);
    gate.prepare('INSERT INTO meta VALUES (1,?)').run(canonicalStringify(inspected.identity));
    gate.exec(`PRAGMA user_version=${TESTNET_STORE_VERSION}; COMMIT;`);
  } finally { gate.close(); }
  sameFile(filename, pinned);
  return { path: filename, lockPath: filename + '.lock.sqlite', recoveryRequired: true };
}

/** Public synthetic order store, not payer authority. Trusted local storage is
 * required: checksums detect damage, not a deliberately valid rollback. */
export class TestnetStore {
  constructor({ path, identity, limits = TESTNET_STORE_LIMITS, recoveryOnly = false }) {
    this.path = resolve(path); this.lockPath = this.path + '.lock.sqlite';
    this.identity = normalizeTestnetStoreIdentity(identity);
    this.serializedIdentity = canonicalStringify(this.identity);
    check(typeof recoveryOnly === 'boolean', 'STORE_IDENTITY_INVALID', 'Recovery mode must be explicit.');
    this.recoveryOnly = recoveryOnly;
    this.limits = { ...limits };
    check(Object.keys(this.limits).sort().join() === Object.keys(TESTNET_STORE_LIMITS).sort().join() && Object.entries(this.limits).every(([key,value]) => Number.isSafeInteger(value) && value > 0 && value <= TESTNET_STORE_LIMITS[key]), 'STORE_LIMITS_INVALID', 'Admission limits must be positive and no larger than the compiled caps.');
    this.file = inspect(this.path); this.lockFile = inspect(this.lockPath);
    this.closed = false; this.failed = false;
    try {
      this.gate = open(this.lockPath);
      this.gate.exec('PRAGMA busy_timeout=100; PRAGMA synchronous=FULL;');
      schema(this.gate, { meta: TESTNET_LOCK_SCHEMA }); integrity(this.gate);
      this.gate.exec('BEGIN IMMEDIATE;');
      check(this.gate.prepare('SELECT identity FROM meta WHERE id=1').get()?.identity === this.serializedIdentity && this.gate.prepare('SELECT count(*) AS n FROM meta').get().n === 1, 'STORE_IDENTITY_MISMATCH', 'Gate belongs to another deployment.');
      this.db = open(this.path);
      this.db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
      this.guard(); inspectTestnetStoreSnapshot(this.db, this.identity);
    } catch (error) {
      try { this.db?.close(); } catch {}
      try { this.gate?.close(); } catch {}
      if (error instanceof MoteError) throw error;
      fail(error.code?.includes('SQLITE') ? 'STORE_UNAVAILABLE' : 'STORE_CORRUPT', 'Paid store is locked, damaged or unavailable; no initialization was performed.');
    }
  }
  guard() {
    check(!this.closed && !this.failed, 'STORE_UNAVAILABLE', 'Paid store is unavailable.');
    try {
      sameFile(this.path, this.file); sameFile(this.lockPath, this.lockFile);
      schema(this.db, TESTNET_STORE_SCHEMA);
      const row = this.db.prepare('SELECT * FROM meta WHERE id=1').get();
      check(row?.version === TESTNET_STORE_VERSION && row.identity === this.serializedIdentity && row.identity_hash === hashText(row.identity) && this.db.prepare('SELECT count(*) AS n FROM meta').get().n === 1, 'STORE_IDENTITY_MISMATCH', 'Store belongs to another deployment or metadata was changed.');
      check(row.recovery_required === 0 || (row.recovery_required === 1 && this.recoveryOnly), 'STORE_RECOVERY_REQUIRED', 'Restored state is quarantined; only explicit recovery mode is allowed.');
      check(this.gate.prepare('SELECT identity FROM meta WHERE id=1').get()?.identity === this.serializedIdentity, 'STORE_IDENTITY_MISMATCH', 'Gate metadata changed.');
    } catch (error) { this.failed = true; throw error; }
  }
  transact(fn) {
    this.guard();
    this.db.exec('BEGIN IMMEDIATE;');
    try { this.guard(); const result = fn(); this.db.exec('COMMIT;'); return clone(result); }
    catch (error) { try { this.db.exec('ROLLBACK;'); } catch {} throw error; }
  }
  decode(raw) { return decodeTestnetStoreRow(raw, this.identity); }
  write(row) {
    const data = encodeTestnetStoreRow(row, this.identity);
    this.db.prepare('UPDATE quotes SET data=?,data_hash=?,transaction_hash=? WHERE id=?').run(data, hashText(data), row.transactionHash, row.id);
  }
  byKey(key) { this.guard(); return clone(this.decode(this.db.prepare('SELECT * FROM quotes WHERE idem=?').get(key))); }
  byId(id) { this.guard(); return clone(this.decode(this.db.prepare('SELECT * FROM quotes WHERE id=?').get(id))); }
  saveDraft({ id, key, fingerprint, payer, input, result, draft }) {
    check(!this.recoveryOnly, 'RECOVERY_ONLY', 'Recovery mode cannot issue quotes.', 503);
    return this.transact(() => {
      const previous = this.decode(this.db.prepare('SELECT * FROM quotes WHERE idem=?').get(key));
      if (previous) { check(previous.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', 'Idempotency key belongs to another payer, input or declaration.', 409); return previous; }
      check(this.db.prepare('SELECT count(*) AS n FROM quotes').get().n < this.limits.quotes && this.db.prepare('SELECT count(*) AS n FROM quotes WHERE payer=?').get(payer).n < this.limits.quotesPerPayer, 'CAPACITY', 'Pilot admission capacity reached; existing orders remain recoverable.', 503);
      const row = { id, key, fingerprint, payer, input, result, draft, offer: null, response: null, transactionHash: null };
      const data = encodeTestnetStoreRow(row, this.identity);
      this.db.prepare('INSERT INTO quotes VALUES (?,?,?,?,?,?,NULL)').run(id, key, fingerprint, payer, data, hashText(data));
      return row;
    });
  }
  saveOffer(id, offer) {
    check(!this.recoveryOnly, 'RECOVERY_ONLY', 'Recovery mode cannot issue signed offers.', 503);
    return this.transact(() => {
      const row = this.decode(this.db.prepare('SELECT * FROM quotes WHERE id=?').get(id));
      check(row, 'QUOTE_NOT_FOUND', 'Unknown quote.', 404);
      if (!row.offer) { row.offer = clone(offer); this.write(row); }
      return row.offer;
    });
  }
  bindAttempt(key, quoteId, transactionHash) {
    return this.transact(() => {
      const old = this.db.prepare('SELECT * FROM attempts WHERE idem=?').get(key);
      if (old) { check(old.quote_id === quoteId && old.transaction_hash === transactionHash, 'IDEMPOTENCY_CONFLICT', 'Idempotency key belongs to another proof.', 409); return old; }
      check(this.db.prepare('SELECT count(*) AS n FROM attempts').get().n < this.limits.attempts, 'CAPACITY', 'Proof admission capacity reached; existing proof keys and completed orders remain recoverable.', 503);
      this.db.prepare('INSERT INTO attempts VALUES (?,?,?,?)').run(key, quoteId, transactionHash, 'unverified');
      return { idem: key, quote_id: quoteId, transaction_hash: transactionHash, state: 'unverified' };
    });
  }
  proofState(key, state) {
    check(['unverified', 'pending', 'finalized', 'reorg', 'rejected'].includes(state), 'STORE_INVALID_STATE', 'Invalid proof state.');
    return this.transact(() => { this.db.prepare('UPDATE attempts SET state=? WHERE idem=?').run(state, key); return state; });
  }
  saveResponse(id, transactionHash, response) {
    return this.transact(() => {
      const row = this.decode(this.db.prepare('SELECT * FROM quotes WHERE id=?').get(id));
      check(row?.offer, 'QUOTE_NOT_FOUND', 'Signed offer not found.', 404);
      if (row.response) { check(row.transactionHash === transactionHash, 'ALREADY_PAID', 'Order already has another recorded transaction; do not pay again.', 409); return row.response; }
      check(!this.db.prepare('SELECT id FROM quotes WHERE transaction_hash=? AND id<>?').get(transactionHash, id), 'PAYMENT_REUSED', 'Payment already belongs to another order.', 409);
      row.transactionHash = transactionHash; row.response = clone(response); this.write(row); return row.response;
    });
  }
  importRecovered({ id, key, fingerprint, payer, input, result, draft, offer, transactionHash, response }) {
    check(this.recoveryOnly, 'RECOVERY_MODE_REQUIRED', 'Missing orders may only be reconstructed in explicit recovery mode.', 409);
    return this.transact(() => {
      const attempt = this.db.prepare('SELECT * FROM attempts WHERE idem=?').get(key);
      check(!attempt || (attempt.quote_id === id && attempt.transaction_hash === transactionHash), 'IDEMPOTENCY_CONFLICT', 'Recovery key already belongs to a different payment proof.', 409);
      const known = this.decode(this.db.prepare('SELECT * FROM quotes WHERE id=?').get(id));
      if (known) {
        check(known.fingerprint === fingerprint && known.transactionHash === transactionHash && known.response, 'RECOVERY_CONFLICT', 'Recovered proof conflicts with an existing order.', 409);
        return known.response;
      }
      check(!this.db.prepare('SELECT id FROM quotes WHERE idem=? OR transaction_hash=?').get(key, transactionHash), 'IDEMPOTENCY_CONFLICT', 'Recovery key or proof already belongs to another order.', 409);
      check(this.db.prepare('SELECT count(*) AS n FROM quotes').get().n < this.limits.quotes, 'CAPACITY', 'Recovery record capacity reached; preserve the original offer, input and proof.', 503);
      check(attempt || this.db.prepare('SELECT count(*) AS n FROM attempts').get().n < this.limits.attempts, 'CAPACITY', 'Recovery proof-key capacity reached; preserve the original offer, input and proof.', 503);
      const row = { id, key, fingerprint, payer, input, result, draft, offer, transactionHash, response };
      const data = encodeTestnetStoreRow(row, this.identity);
      this.db.prepare('INSERT INTO quotes VALUES (?,?,?,?,?,?,?)').run(id, key, fingerprint, payer, data, hashText(data), transactionHash);
      this.db.prepare('INSERT INTO attempts VALUES (?,?,?,?) ON CONFLICT(idem) DO UPDATE SET state=excluded.state').run(key, id, transactionHash, 'finalized');
      return response;
    });
  }
  ready() { try { this.guard(); return true; } catch { return false; } }
  close() { if (this.closed) return; this.closed = true; try { this.db?.close(); } finally { try { this.gate?.exec('ROLLBACK;'); } finally { this.gate?.close(); } } }
}
