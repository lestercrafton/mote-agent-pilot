import { DatabaseSync } from 'node:sqlite';
import { constants, openSync, closeSync, readSync, fstatSync, lstatSync, accessSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { getAddress, Interface } from 'ethers';
import { canonicalStringify } from './json.mjs';

const VERSION = 2;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^(0|[1-9]\d*)$/;
const PHASES = new Set(['reserved', 'approval_intent', 'approval_submitted', 'approval_unknown', 'approved', 'payment_intent', 'payment_submitted', 'payment_unknown', 'settled', 'failed', 'cancelled', 'complete']);
const TERMINAL = new Set(['settled', 'failed', 'cancelled', 'complete']);
const POLICY_FIELDS = ['enabled', 'chainId', 'payer', 'token', 'router', 'recipient', 'serviceOrigin', 'quoteSigner', 'asset', 'decimals', 'maxSingleSpend', 'maxTotalSpend', 'maxGasPerTransactionWei', 'maxGasTotalWei'];
const CHAIN_FIELDS = ['chainId', 'genesisHash', 'quoteSigner', 'tokenCodeHash', 'routerCodeHash'];
const OFFER_FIELDS = ['protocol', 'quote', 'domain', 'signature', 'offerSignature', 'chainId', 'token', 'router', 'recipient', 'quoteSigner', 'decimals', 'asset', 'service', 'resultHash', 'expiresAt', 'inputBytes', 'localOnly'];
const TX_FIELDS = ['nonce', 'to', 'data', 'gasLimit', 'gasPrice', 'chainId', 'from', 'value'];
const PROOF_FIELDS = ['transactionHash', 'feeWei', 'success', 'blockNumber', 'blockHash', 'transaction', 'quoteId', 'requestHash', 'payer', 'amount'];
const ROW_FIELDS = ['quoteId', 'offer', 'idempotencyKey', 'revision', 'phase', 'owner', 'tokenReserved', 'tokenSpent', 'approvalReservedWei', 'paymentReservedWei', 'approvalHash', 'paymentHash', 'approvalIntent', 'paymentIntent', 'approvalProof', 'paymentProof', 'observedPayment', 'response'];
const APPROVE = new Interface(['function approve(address,uint256) returns (bool)']);
const PAY = new Interface(['function pay((bytes32 quoteId,bytes32 requestHash,address payer,uint256 amount,uint256 deadline),bytes)']);
const SCHEMA = {
  meta: 'CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, context TEXT NOT NULL, context_hash TEXT NOT NULL)',
  entries: 'CREATE TABLE entries (quote_id TEXT PRIMARY KEY, data TEXT NOT NULL, data_hash TEXT NOT NULL)',
  fees: 'CREATE TABLE fees (transaction_hash TEXT PRIMARY KEY, quote_id TEXT NOT NULL REFERENCES entries(quote_id), step TEXT NOT NULL, fee_wei TEXT NOT NULL, proof TEXT NOT NULL, proof_hash TEXT NOT NULL)',
  gate: 'CREATE TABLE gate (id INTEGER PRIMARY KEY CHECK(id=1), quote_id TEXT NOT NULL UNIQUE REFERENCES entries(quote_id))',
};
const sqlShape = (sql) => sql.replace(/\s+/g, ' ').trim().replace(/;$/, '');

export class JournalError extends Error {
  constructor(code, message, cause) { super(message, { cause }); this.name = 'JournalError'; this.code = code; this.doNotRepay = true; }
}
const fail = (code, message, cause) => { throw new JournalError(code, message, cause); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };
const digest = (value) => createHash('sha256').update(canonicalStringify(value)).digest('hex');
const clone = (value) => structuredClone(value);
const same = (a, b) => canonicalStringify(a) === canonicalStringify(b);
function uint(value, label) {
  check(typeof value === 'string' && UINT.test(value) && value.length <= 78, 'JOURNAL_INVALID_INPUT', `${label} must be an unsigned base-unit integer string.`);
  return BigInt(value);
}
function address(value, label) {
  try { return getAddress(value).toLowerCase(); } catch { fail('JOURNAL_INVALID_INPUT', `${label} must be an EVM address.`); }
}
function hash(value, label) {
  check(typeof value === 'string' && HEX32.test(value), 'JOURNAL_INVALID_INPUT', `${label} must be 32-byte hexadecimal.`);
  return value.toLowerCase();
}
function object(value, fields, label) {
  check(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'JOURNAL_INVALID_INPUT', `${label} must be a plain object.`);
  check(Object.keys(value).every((key) => fields.includes(key)), 'JOURNAL_INVALID_INPUT', `${label} contains an unsupported field; credentials and arbitrary objects must never enter the journal.`);
}
function policyContext(policy) {
  object(policy, POLICY_FIELDS, 'policy');
  check(typeof policy.enabled === 'boolean' && policy.chainId === 31337, 'JOURNAL_INVALID_INPUT', 'Policy must explicitly identify local chain 31337 and enabled state.');
  const normalized = { enabled: policy.enabled, chainId: policy.chainId };
  for (const key of ['payer', 'token', 'router', 'recipient']) normalized[key] = address(policy[key], key);
  if (policy.quoteSigner !== undefined) normalized.quoteSigner = address(policy.quoteSigner, 'quoteSigner');
  const url = new URL(policy.serviceOrigin);
  check(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) && url.origin === policy.serviceOrigin, 'JOURNAL_INVALID_INPUT', 'Policy serviceOrigin must be an exact loopback HTTP origin.');
  normalized.serviceOrigin = url.origin;
  for (const key of ['maxSingleSpend', 'maxTotalSpend', 'maxGasPerTransactionWei', 'maxGasTotalWei']) normalized[key] = uint(policy[key], key).toString();
  check(uint(normalized.maxSingleSpend, 'maxSingleSpend') > 0n && uint(normalized.maxGasPerTransactionWei, 'maxGasPerTransactionWei') > 0n, 'JOURNAL_INVALID_INPUT', 'Single-payment and per-transaction fee limits must be positive.');
  if (policy.asset !== undefined) { check(policy.asset === 'MOTE', 'JOURNAL_INVALID_INPUT', 'Only MOTE is supported.'); normalized.asset = policy.asset; }
  if (policy.decimals !== undefined) { check(policy.decimals === 6, 'JOURNAL_INVALID_INPUT', 'MOTE decimals must be six.'); normalized.decimals = policy.decimals; }
  return normalized;
}
function chainContext(identity, policy) {
  object(identity, CHAIN_FIELDS, 'chainIdentity');
  check(Object.keys(identity).length === CHAIN_FIELDS.length && identity.chainId === policy.chainId, 'JOURNAL_INVALID_INPUT', 'Complete matching chain identity is required.');
  const result = { chainId: identity.chainId, quoteSigner: address(identity.quoteSigner, 'quoteSigner') };
  for (const key of ['genesisHash', 'tokenCodeHash', 'routerCodeHash']) result[key] = hash(identity[key], key);
  check(!policy.quoteSigner || policy.quoteSigner === result.quoteSigner, 'JOURNAL_IDENTITY_MISMATCH', 'Policy quote signer differs from the chain instance.');
  return result;
}
function context({ policyId, policy, chainIdentity }) {
  check(typeof policyId === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(policyId), 'JOURNAL_INVALID_INPUT', 'policyId must be an explicit 8–128 character public identifier.');
  const normalized = policyContext(policy);
  return { policyId, policy: normalized, chainIdentity: chainContext(chainIdentity, normalized) };
}
function transaction(input, policy) {
  object(input, TX_FIELDS, 'transaction');
  check(Object.keys(input).length === TX_FIELDS.length, 'JOURNAL_INVALID_INPUT', 'A complete explicit unsigned transaction intent is required.');
  const value = {};
  for (const key of ['nonce', 'gasLimit', 'gasPrice', 'chainId', 'value']) value[key] = uint(input[key], key).toString();
  value.to = address(input.to, 'transaction.to'); value.from = address(input.from, 'transaction.from');
  check(value.from === policy.payer && value.chainId === String(policy.chainId) && value.value === '0', 'JOURNAL_INVALID_INPUT', 'Transaction must use the pinned payer/network and zero native value.');
  check(typeof input.data === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(input.data) && input.data.length <= 16386, 'JOURNAL_INVALID_INPUT', 'Transaction calldata must be bounded hexadecimal.');
  value.data = input.data.toLowerCase();
  check(BigInt(value.gasLimit) > 0n && BigInt(value.gasPrice) > 0n && BigInt(value.gasLimit) * BigInt(value.gasPrice) <= BigInt(policy.maxGasPerTransactionWei), 'GAS_TRANSACTION_LIMIT', 'Unsigned transaction exceeds the pinned per-transaction native fee cap.');
  return value;
}
function proof(input, policy) {
  object(input, PROOF_FIELDS, 'receipt proof');
  check(typeof input.success === 'boolean' && Number.isSafeInteger(input.blockNumber) && input.blockNumber >= 0, 'JOURNAL_INVALID_INPUT', 'Receipt proof must identify success and a valid block number.');
  const out = { transactionHash: hash(input.transactionHash, 'transactionHash'), feeWei: uint(input.feeWei, 'feeWei').toString(), success: input.success, blockNumber: input.blockNumber, blockHash: hash(input.blockHash, 'blockHash'), transaction: transaction(input.transaction, policy) };
  check(BigInt(out.feeWei) <= BigInt(policy.maxGasPerTransactionWei), 'JOURNAL_PROOF_MISMATCH', 'Receipt fee exceeds its authorized cap.');
  for (const key of ['quoteId', 'requestHash']) if (input[key] !== undefined) out[key] = hash(input[key], key);
  if (input.payer !== undefined) out.payer = address(input.payer, 'proof.payer');
  if (input.amount !== undefined) out.amount = uint(input.amount, 'proof.amount').toString();
  return out;
}

/** SQLite authority store for one pinned policy. Trusted local storage is required:
 * well-formed malicious rollback/tampering and using another journal are outside
 * this prototype's protection. A missing/corrupt/replaced file never initializes.
 */
export class SQLiteBudgetJournal {
  static initialize(options) {
    const path = resolve(options.path);
    const binding = context(options);
    let descriptor;
    try { descriptor = openSync(path, 'wx', 0o600); } catch (error) { fail(error.code === 'EEXIST' ? 'JOURNAL_EXISTS' : 'JOURNAL_UNAVAILABLE', 'Journal initialization requires a new writable path; existing authority is never overwritten.', error); }
    closeSync(descriptor);
    let db;
    try {
      db = new DatabaseSync(realpathSync(path));
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE; ${Object.values(SCHEMA).join(';')}; PRAGMA user_version=2;`);
      db.prepare('INSERT INTO meta VALUES (1,?,?,?)').run(VERSION, canonicalStringify(binding), digest(binding));
      db.exec('COMMIT');
      db.close();
    } catch (error) {
      try { db?.close(); } catch {}
      fail('JOURNAL_UNAVAILABLE', 'Journal initialization failed; preserve the file for inspection rather than recreating it.', error);
    }
    return new SQLiteBudgetJournal(options);
  }

  constructor(options) {
    this.path = resolve(options.path);
    this.context = context(options);
    this.owner = randomUUID(); // Public fencing identity, never a signing key.
    this.closed = false;
    this.file = this.inspectFile();
    try {
      // Parent-directory aliases must resolve to one SQLite database/WAL path.
      this.db = new DatabaseSync(this.file.realpath);
      this.assertFile();
      this.db.exec('PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
      this.transact(() => {});
    } catch (error) {
      try { this.db?.close(); } catch {}
      this.closed = true;
      if (error instanceof JournalError) throw error;
      fail(/malformed|not a database|no such table|no such column/i.test(error.message) ? 'JOURNAL_CORRUPT' : 'JOURNAL_UNAVAILABLE', 'Unable to open the existing journal; no fallback or reset is permitted.', error);
    }
  }

  inspectFile() {
    try {
      const stat = lstatSync(this.path);
      check(stat.isFile() && !stat.isSymbolicLink(), 'JOURNAL_UNAVAILABLE', 'Journal must be a regular, non-symlink file.');
      check(stat.nlink === 1, 'JOURNAL_UNAVAILABLE', 'Hard-linked journals are forbidden because aliases can split SQLite WAL authority.');
      check((stat.mode & 0o222) !== 0, 'JOURNAL_UNAVAILABLE', 'Read-only journals cannot authorize or reconcile spending.');
      accessSync(this.path, constants.R_OK | constants.W_OK);
      accessSync(dirname(this.path), constants.R_OK | constants.W_OK);
      return { dev: stat.dev, ino: stat.ino, realpath: realpathSync(this.path) };
    } catch (error) {
      if (error instanceof JournalError) throw error;
      fail(error.code === 'ENOENT' ? 'JOURNAL_MISSING' : 'JOURNAL_UNAVAILABLE', 'The existing journal is unavailable; explicit initialization is never an automatic recovery step.', error);
    }
  }
  assertFile() {
    check(!this.closed, 'JOURNAL_UNAVAILABLE', 'Journal is closed.');
    const actual = this.inspectFile();
    check(actual.dev === this.file.dev && actual.ino === this.file.ino && actual.realpath === this.file.realpath, 'JOURNAL_FILE_CHANGED', 'Journal file identity changed; spending is stopped.');
    let descriptor;
    try {
      descriptor = openSync(this.path, 'r');
      const stat = fstatSync(descriptor);
      check(stat.dev === this.file.dev && stat.ino === this.file.ino, 'JOURNAL_FILE_CHANGED', 'Journal changed while being checked.');
      const header = Buffer.alloc(16);
      check(readSync(descriptor, header, 0, 16, 0) === 16 && header.equals(Buffer.from('SQLite format 3\0')), 'JOURNAL_CORRUPT', 'Journal header is missing or corrupt.');
    } catch (error) {
      if (error instanceof JournalError) throw error;
      fail('JOURNAL_UNAVAILABLE', 'Journal bytes are unavailable; spending is stopped.', error);
    } finally { if (descriptor !== undefined) closeSync(descriptor); }
  }
  validate() {
    check(this.db.prepare('PRAGMA user_version').get().user_version === VERSION, 'JOURNAL_CORRUPT', 'Unrecognized journal schema version.');
    check(this.db.prepare('PRAGMA quick_check').all().every((row) => Object.values(row)[0] === 'ok'), 'JOURNAL_CORRUPT', 'SQLite integrity check failed.');
    const tables = this.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    check(same(tables.map((row) => row.name), ['entries', 'fees', 'gate', 'meta']) && tables.every((row) => sqlShape(row.sql) === sqlShape(SCHEMA[row.name])), 'JOURNAL_CORRUPT', 'Unexpected journal schema or missing constraints.');
    const rows = this.db.prepare('SELECT * FROM meta').all();
    check(rows.length === 1 && rows[0].id === 1 && rows[0].schema_version === VERSION, 'JOURNAL_CORRUPT', 'Missing or invalid journal identity.');
    let stored;
    try { stored = JSON.parse(rows[0].context); } catch { fail('JOURNAL_CORRUPT', 'Invalid journal context.'); }
    check(digest(stored) === rows[0].context_hash, 'JOURNAL_CORRUPT', 'Journal context checksum failed.');
    check(same(stored, this.context), 'JOURNAL_IDENTITY_MISMATCH', 'Policy ID, policy limits/destinations or chain instance differs from the initialized journal.');
    const entries = this.db.prepare('SELECT * FROM entries').all().map((row) => this.decode(row));
    const gate = this.db.prepare('SELECT * FROM gate').all();
    check(gate.length <= 1 && gate.every((item) => item.id === 1 && entries.some((row) => row.quoteId === item.quote_id && !TERMINAL.has(row.phase))), 'JOURNAL_CORRUPT', 'Invalid wallet submission gate.');
    for (const row of entries) if (!TERMINAL.has(row.phase)) check(gate[0]?.quote_id === row.quoteId, 'JOURNAL_CORRUPT', 'An unfinished reservation lost its wallet gate.');
    check(this.db.prepare('PRAGMA foreign_key_check').all().length === 0, 'JOURNAL_CORRUPT', 'Journal references are inconsistent.');
    const fees = this.db.prepare('SELECT * FROM fees').all();
    for (const fee of fees) {
      hash(fee.transaction_hash, 'stored transaction hash'); uint(fee.fee_wei, 'stored fee');
      check(['approval', 'payment', 'observed_payment'].includes(fee.step), 'JOURNAL_CORRUPT', 'Invalid fee step.');
      const evidence = JSON.parse(fee.proof);
      check(digest(evidence) === fee.proof_hash && evidence.transactionHash === fee.transaction_hash && evidence.feeWei === fee.fee_wei, 'JOURNAL_CORRUPT', 'Fee evidence differs from its accounting row or checksum.');
      const entry = entries.find((row) => row.quoteId === fee.quote_id);
      const source = fee.step === 'observed_payment' ? entry?.observedPayment : entry?.[`${fee.step}Proof`];
      check(source && same(source, evidence), 'JOURNAL_CORRUPT', 'Fee accounting lost its entry evidence.');
    }
    for (const row of entries) for (const evidence of [row.approvalProof, row.paymentProof, row.observedPayment].filter(Boolean)) {
      const fee = fees.find((item) => item.transaction_hash === evidence.transactionHash);
      check(fee && fee.quote_id === row.quoteId && fee.fee_wei === evidence.feeWei && same(JSON.parse(fee.proof).transaction, evidence.transaction), 'JOURNAL_CORRUPT', 'Entry evidence lost its exact fee accounting.');
    }
  }
  transact(action) {
    this.assertFile();
    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.validate();
      const result = action();
      this.validate();
      this.assertFile();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      if (error instanceof JournalError) throw error;
      fail(/malformed|not a database|no such table|no such column/i.test(error.message) ? 'JOURNAL_CORRUPT' : 'JOURNAL_UNAVAILABLE', 'Journal operation failed closed; reservations were not reset.', error);
    }
  }
  validateOffer(offer) {
    object(offer, OFFER_FIELDS, 'offer');
    object(offer.quote, ['quoteId', 'requestHash', 'payer', 'amount', 'deadline'], 'quote');
    object(offer.domain, ['name', 'version', 'chainId', 'verifyingContract'], 'domain');
    const p = this.context.policy;
    check(offer.protocol === 'mote-local-v1' && offer.service === 'json.audit' && offer.asset === 'MOTE' && offer.decimals === 6 && offer.localOnly === true && offer.chainId === p.chainId, 'JOURNAL_INVALID_INPUT', 'Offer must identify the local Mote service and asset.');
    for (const key of ['token', 'router', 'recipient']) check(address(offer[key], key) === p[key], 'JOURNAL_IDENTITY_MISMATCH', 'Offer destination differs from journal policy.');
    check(address(offer.quote.payer, 'payer') === p.payer && address(offer.quoteSigner, 'quoteSigner') === this.context.chainIdentity.quoteSigner, 'JOURNAL_IDENTITY_MISMATCH', 'Offer payer or quote signer differs from journal identity.');
    check(offer.domain.name === 'MotePayments' && offer.domain.version === '1' && offer.domain.chainId === p.chainId && address(offer.domain.verifyingContract, 'domain router') === p.router, 'JOURNAL_IDENTITY_MISMATCH', 'Offer domain differs from the journal.');
    hash(offer.quote.quoteId, 'quoteId'); hash(offer.quote.requestHash, 'requestHash'); hash(offer.resultHash, 'resultHash');
    uint(offer.quote.deadline, 'deadline');
    const amount = uint(offer.quote.amount, 'amount');
    check(amount > 0n, 'JOURNAL_INVALID_INPUT', 'Quote amount must be positive.');
    for (const key of ['signature', 'offerSignature']) check(typeof offer[key] === 'string' && /^0x[0-9a-fA-F]{130}$/.test(offer[key]), 'JOURNAL_INVALID_INPUT', 'Only public EVM signatures belong in an offer.');
    check(typeof offer.expiresAt === 'string' && Number.isFinite(Date.parse(offer.expiresAt)) && Number.isSafeInteger(offer.inputBytes) && offer.inputBytes >= 0, 'JOURNAL_INVALID_INPUT', 'Invalid offer metadata.');
    return clone(offer);
  }
  decode(stored) {
    try {
      const row = JSON.parse(stored.data);
      check(digest(row) === stored.data_hash, 'JOURNAL_CORRUPT', 'Journal entry checksum failed.');
      object(row, ROW_FIELDS, 'stored entry');
      check(Object.keys(row).length === ROW_FIELDS.length && row.quoteId === stored.quote_id && hash(row.quoteId, 'stored quote ID') === row.quoteId, 'JOURNAL_CORRUPT', 'Malformed journal entry.');
      this.validateOffer(row.offer);
      check(row.quoteId === row.offer.quote.quoteId.toLowerCase() && Number.isSafeInteger(row.revision) && row.revision >= 0 && PHASES.has(row.phase) && typeof row.owner === 'string' && row.owner.length === 36 && /^[A-Za-z0-9._:-]{8,128}$/.test(row.idempotencyKey), 'JOURNAL_CORRUPT', 'Invalid entry identity, revision or phase.');
      const amount = uint(row.offer.quote.amount, 'stored amount');
      const reserved = uint(row.tokenReserved, 'stored token reservation');
      const spent = uint(row.tokenSpent, 'stored token spend');
      check([0n, amount].includes(reserved) && [0n, amount].includes(spent) && reserved + spent <= amount, 'JOURNAL_CORRUPT', 'Invalid token accounting.');
      const cap = BigInt(this.context.policy.maxGasPerTransactionWei);
      for (const field of ['approvalReservedWei', 'paymentReservedWei']) check([0n, cap].includes(uint(row[field], field)), 'JOURNAL_CORRUPT', 'Invalid gas reservation.');
      for (const step of ['approval', 'payment']) {
        if (row[`${step}Hash`] !== null) hash(row[`${step}Hash`], `${step}Hash`);
        if (row[`${step}Intent`] !== null) transaction(row[`${step}Intent`], this.context.policy);
        if (row[`${step}Proof`] !== null) proof(row[`${step}Proof`], this.context.policy);
        if (row[`${step}Intent`]) this.validateIntent(row, step, row[`${step}Intent`]);
        if (row[`${step}Proof`]) check(row[`${step}Hash`] === row[`${step}Proof`].transactionHash && same(row[`${step}Intent`], row[`${step}Proof`].transaction), 'JOURNAL_CORRUPT', 'Receipt does not resolve its exact original intent.');
      }
      if (row.observedPayment !== null) proof(row.observedPayment, this.context.policy);
      const observed = row.observedPayment !== null;
      if (observed) check(row.observedPayment.success && row.observedPayment.quoteId === row.quoteId && row.observedPayment.requestHash === row.offer.quote.requestHash.toLowerCase() && row.observedPayment.payer === this.context.policy.payer && row.observedPayment.amount === row.offer.quote.amount && spent === amount && reserved === 0n, 'JOURNAL_CORRUPT', 'Observed payment has inconsistent token accounting.');
      if (!TERMINAL.has(row.phase)) check(observed ? spent === amount && reserved === 0n : spent === 0n && reserved === amount, 'JOURNAL_CORRUPT', 'Unresolved token authority lost its reservation.');
      if (row.phase === 'reserved' || row.phase === 'cancelled') check(!row.approvalIntent && !row.paymentIntent && !row.approvalHash && !row.paymentHash && !row.approvalProof && !row.paymentProof && !row.observedPayment && !row.response && spent === 0n, 'JOURNAL_CORRUPT', 'Pre-intent state contains transaction evidence.');
      if (row.phase === 'reserved') check(BigInt(row.approvalReservedWei) === cap && BigInt(row.paymentReservedWei) === cap, 'JOURNAL_CORRUPT', 'New reservation lost its fee caps.');
      if (row.phase.startsWith('approval_')) check(row.approvalIntent && !row.approvalProof && !row.paymentIntent && !row.paymentHash && !row.paymentProof && !observed && !row.response && BigInt(row.approvalReservedWei) === cap && BigInt(row.paymentReservedWei) === cap, 'JOURNAL_CORRUPT', 'Approval phase accounting is inconsistent.');
      if (row.phase === 'approved') check(row.approvalProof?.success === true && !row.paymentIntent && !row.paymentHash && !row.paymentProof && !observed && !row.response && row.approvalReservedWei === '0' && BigInt(row.paymentReservedWei) === cap, 'JOURNAL_CORRUPT', 'Confirmed approval lacks reserved payment authority.');
      if (row.phase.startsWith('payment_')) check(row.approvalProof?.success === true && row.paymentIntent && !row.paymentProof && row.approvalReservedWei === '0' && BigInt(row.paymentReservedWei) === cap, 'JOURNAL_CORRUPT', 'Payment phase accounting is inconsistent.');
      if (row.phase.endsWith('_submitted')) check(row[row.phase.startsWith('approval_') ? 'approvalHash' : 'paymentHash'], 'JOURNAL_CORRUPT', 'Submitted transaction has no hash.');
      if (TERMINAL.has(row.phase)) check(row.tokenReserved === '0' && row.approvalReservedWei === '0' && row.paymentReservedWei === '0', 'JOURNAL_CORRUPT', 'Terminal state has unresolved reservations.');
      if (['settled', 'complete'].includes(row.phase)) check(spent === amount && row.paymentProof?.success === true && row.approvalProof?.success === true, 'JOURNAL_CORRUPT', 'Settled state lacks exact successful payment evidence.');
      if (row.phase === 'complete') check(row.response, 'JOURNAL_CORRUPT', 'Completed delivery has no recorded response.');
      if (row.phase === 'failed') check((row.approvalProof?.success === false && !row.paymentProof) || (row.approvalProof?.success === true && row.paymentProof?.success === false), 'JOURNAL_CORRUPT', 'Failed attempt lacks a definitive reverted original transaction.');
      if (row.phase === 'failed' && !observed) check(spent === 0n, 'JOURNAL_CORRUPT', 'Failed attempt contains unexplained token spending.');
      return row;
    } catch (error) { if (error.code === 'JOURNAL_CORRUPT') throw error; fail('JOURNAL_CORRUPT', 'Journal entry failed validation.', error); }
  }
  internalRead(id) { const value = this.db.prepare('SELECT * FROM entries WHERE quote_id=?').get(hash(id, 'quoteId')); return value ? this.decode(value) : null; }
  enriched(row) {
    if (!row) return null;
    const fees = this.db.prepare('SELECT fee_wei FROM fees WHERE quote_id=?').all(row.quoteId);
    return { ...clone(row), gasReservedWei: (BigInt(row.approvalReservedWei) + BigInt(row.paymentReservedWei)).toString(), gasSpentWei: fees.reduce((sum, fee) => sum + BigInt(fee.fee_wei), 0n).toString() };
  }
  save(row) { row.revision++; this.db.prepare('UPDATE entries SET data=?,data_hash=? WHERE quote_id=?').run(canonicalStringify(row), digest(row), row.quoteId); }
  requireRow(id) { const row = this.internalRead(id); check(row, 'JOURNAL_UNTRACKED', 'No durable reservation exists for this quote.'); return row; }
  requireOwner(row) { check(row.owner === this.owner, 'JOURNAL_OWNER_MISMATCH', 'A different process owns this attempt; reconciliation cannot acquire send authority.'); }
  requireGate(row) { check(this.db.prepare('SELECT quote_id FROM gate WHERE id=1').get()?.quote_id === row.quoteId, 'JOURNAL_GATE_MISMATCH', 'This quote does not own the wallet submission gate.'); }
  releaseGate(row) { this.requireGate(row); this.db.prepare('DELETE FROM gate WHERE id=1 AND quote_id=?').run(row.quoteId); }
  totals() {
    const entries = this.db.prepare('SELECT * FROM entries').all().map((row) => this.decode(row));
    return { tokenReserved: entries.reduce((sum, row) => sum + BigInt(row.tokenReserved), 0n).toString(), tokenSpent: entries.reduce((sum, row) => sum + BigInt(row.tokenSpent), 0n).toString(), gasReservedWei: entries.reduce((sum, row) => sum + BigInt(row.approvalReservedWei) + BigInt(row.paymentReservedWei), 0n).toString(), gasSpentWei: this.db.prepare('SELECT fee_wei FROM fees').all().reduce((sum, row) => sum + BigInt(row.fee_wei), 0n).toString() };
  }
  assertContext({ policy, chainIdentity }) {
    const binding = context({ policyId: this.context.policyId, policy, chainIdentity });
    return this.transact(() => { check(same(binding, this.context), 'JOURNAL_IDENTITY_MISMATCH', 'Client context does not match the journal authority.'); return true; });
  }
  budget() { return this.transact(() => this.totals()); }
  read(id) { return this.transact(() => this.enriched(this.internalRead(id))); }
  list() { return this.transact(() => this.db.prepare('SELECT * FROM entries ORDER BY quote_id').all().map((row) => this.enriched(this.decode(row)))); }
  reserve(offer, idempotencyKey) {
    const savedOffer = this.validateOffer(offer);
    check(typeof idempotencyKey === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey), 'JOURNAL_INVALID_INPUT', 'Invalid durable idempotency key.');
    return this.transact(() => {
      const id = hash(offer.quote.quoteId, 'quoteId');
      const previous = this.internalRead(id);
      if (previous) { check(same(previous.offer, savedOffer) && previous.idempotencyKey === idempotencyKey, 'QUOTE_CONFLICT', 'A recorded quote cannot change offer or operation identity.'); return { created: false, row: this.enriched(previous) }; }
      const p = this.context.policy; const amount = BigInt(offer.quote.amount); const cap = BigInt(p.maxGasPerTransactionWei); const budget = this.totals();
      check(p.enabled, 'SPENDING_DISABLED', 'The journal policy disables spending.');
      check(amount <= BigInt(p.maxSingleSpend), 'SINGLE_LIMIT', 'Quote exceeds the durable single-payment cap.');
      check(BigInt(budget.tokenSpent) + BigInt(budget.tokenReserved) + amount <= BigInt(p.maxTotalSpend), 'TOTAL_LIMIT', 'Shared durable token reservations exceed the total cap.');
      check(BigInt(budget.gasSpentWei) + BigInt(budget.gasReservedWei) + cap * 2n <= BigInt(p.maxGasTotalWei), 'GAS_TOTAL_LIMIT', 'Shared durable fee reservations exceed the total cap.');
      check(!this.db.prepare('SELECT quote_id FROM gate WHERE id=1').get(), 'WALLET_BUSY', 'Another durable attempt holds the wallet gate; reconcile it without sending again.');
      const row = { quoteId: id, offer: savedOffer, idempotencyKey, revision: 0, phase: 'reserved', owner: this.owner, tokenReserved: amount.toString(), tokenSpent: '0', approvalReservedWei: cap.toString(), paymentReservedWei: cap.toString(), approvalHash: null, paymentHash: null, approvalIntent: null, paymentIntent: null, approvalProof: null, paymentProof: null, observedPayment: null, response: null };
      this.db.prepare('INSERT INTO entries VALUES (?,?,?)').run(id, canonicalStringify(row), digest(row));
      this.db.prepare('INSERT INTO gate VALUES (1,?)').run(id);
      return { created: true, row: this.enriched(row) };
    });
  }
  validateIntent(row, step, tx) {
    const p = this.context.policy;
    const expected = step === 'approval' ? APPROVE.encodeFunctionData('approve', [p.router, row.offer.quote.amount]) : PAY.encodeFunctionData('pay', [row.offer.quote, row.offer.signature]);
    check(tx.to === p[step === 'approval' ? 'token' : 'router'] && tx.data === expected.toLowerCase(), 'JOURNAL_INVALID_INPUT', 'Intent calldata must exactly approve the quote amount or pay the original signed quote.');
    if (step === 'payment') check(row.approvalIntent && BigInt(tx.nonce) === BigInt(row.approvalIntent.nonce) + 1n, 'JOURNAL_INVALID_INPUT', 'Payment must use the next nonce after its original approval.');
  }
  beginIntent(id, expectedPhase, step, request) {
    check(['approval', 'payment'].includes(step), 'JOURNAL_INVALID_INPUT', 'Invalid transaction step.');
    const tx = transaction(request, this.context.policy);
    return this.transact(() => {
      const row = this.requireRow(id); this.requireOwner(row);
      const required = step === 'approval' ? 'reserved' : 'approved';
      check(expectedPhase === required && row.phase === required, 'JOURNAL_PHASE_CONFLICT', 'Send intent no longer has its original authorized phase.');
      this.requireGate(row);
      check(tx.to === this.context.policy[step === 'approval' ? 'token' : 'router'], 'JOURNAL_INVALID_INPUT', 'Send intent destination differs from the pinned contract.');
      this.validateIntent(row, step, tx);
      check(row[`${step}Intent`] === null, 'JOURNAL_PHASE_CONFLICT', 'A send intent can only be created once.');
      row[`${step}Intent`] = tx; row.phase = `${step}_intent`; this.save(row);
      return this.enriched(row);
    });
  }
  markSubmitted(id, step, transactionHash) {
    check(['approval', 'payment'].includes(step), 'JOURNAL_INVALID_INPUT', 'Invalid transaction step.');
    const txHash = hash(transactionHash, 'transactionHash');
    return this.transact(() => {
      const row = this.requireRow(id); this.requireOwner(row);
      const field = `${step}Hash`;
      if (row[field]) { check(row[field] === txHash, 'TRANSACTION_CONFLICT', 'Original transaction hash cannot change.'); return this.enriched(row); }
      this.requireGate(row);
      check([`${step}_intent`, `${step}_unknown`].includes(row.phase) && row[`${step}Intent`], 'JOURNAL_PHASE_CONFLICT', 'Submission has no matching durable intent.');
      row[field] = txHash; row.phase = `${step}_submitted`; this.save(row); return this.enriched(row);
    });
  }
  markUnknown(id, step) {
    check(['approval', 'payment'].includes(step), 'JOURNAL_INVALID_INPUT', 'Invalid transaction step.');
    return this.transact(() => {
      const row = this.requireRow(id); this.requireOwner(row);
      if (row[`${step}Proof`]) return this.enriched(row);
      this.requireGate(row);
      check([`${step}_intent`, `${step}_submitted`, `${step}_unknown`].includes(row.phase), 'JOURNAL_PHASE_CONFLICT', 'Unknown state has no matching intent.');
      row.phase = `${step}_unknown`; this.save(row); return this.enriched(row);
    });
  }
  addFee(row, step, evidence) {
    const previous = this.db.prepare('SELECT * FROM fees WHERE transaction_hash=?').get(evidence.transactionHash);
    if (previous) {
      check(previous.quote_id === row.quoteId && previous.fee_wei === evidence.feeWei && same(JSON.parse(previous.proof).transaction, evidence.transaction), 'JOURNAL_PROOF_MISMATCH', 'Transaction fee was already accounted with different evidence.');
      if (previous.step === 'observed_payment' && step === 'payment') this.db.prepare('UPDATE fees SET step=?, proof=?, proof_hash=? WHERE transaction_hash=?').run(step, canonicalStringify(evidence), digest(evidence), evidence.transactionHash);
      return;
    }
    this.db.prepare('INSERT INTO fees VALUES (?,?,?,?,?,?)').run(evidence.transactionHash, row.quoteId, step, evidence.feeWei, canonicalStringify(evidence), digest(evidence));
  }
  recordStep(id, step, receiptProof) {
    const evidence = proof(receiptProof, this.context.policy);
    return this.transact(() => {
      const row = this.requireRow(id); const prior = row[`${step}Proof`];
      if (prior) { check(same(prior, evidence), 'JOURNAL_PROOF_MISMATCH', 'Recorded receipt evidence cannot be replaced.'); return this.enriched(row); }
      this.requireGate(row);
      check(row[`${step}Intent`] && same(row[`${step}Intent`], evidence.transaction), 'JOURNAL_PROOF_MISMATCH', 'Canonical transaction does not match the exact original durable intent.');
      check(row[`${step}Hash`] && row[`${step}Hash`] === evidence.transactionHash, 'TRANSACTION_CONFLICT', 'Receipt must resolve a durably recorded original transaction hash; an unrecorded send remains uncertain.');
      check([`${step}_intent`, `${step}_submitted`, `${step}_unknown`].includes(row.phase), 'JOURNAL_PHASE_CONFLICT', 'Receipt does not match an unresolved transaction step.');
      row[`${step}Hash`] = evidence.transactionHash; row[`${step}Proof`] = evidence; row[`${step}ReservedWei`] = '0';
      this.addFee(row, step, evidence);
      if (step === 'approval' && evidence.success) row.phase = 'approved';
      else {
        row.tokenReserved = '0'; row.approvalReservedWei = '0'; row.paymentReservedWei = '0';
        if (step === 'payment' && evidence.success) row.tokenSpent = row.offer.quote.amount;
        row.phase = step === 'payment' && evidence.success ? (row.response ? 'complete' : 'settled') : 'failed';
        this.releaseGate(row);
      }
      this.save(row); return this.enriched(row);
    });
  }
  recordApproval(id, receiptProof) { return this.recordStep(id, 'approval', receiptProof); }
  recordPayment(id, receiptProof) { return this.recordStep(id, 'payment', receiptProof); }
  recordObservedPayment(id, receiptProof) {
    const evidence = proof(receiptProof, this.context.policy);
    return this.transact(() => {
      const row = this.requireRow(id); this.requireGate(row);
      check(['payment_intent', 'payment_unknown'].includes(row.phase) && !row.paymentHash, 'JOURNAL_PHASE_CONFLICT', 'Observed payment cannot replace a recorded submission or acquire send authority.');
      check(evidence.success && evidence.quoteId === row.quoteId && evidence.requestHash === row.offer.quote.requestHash.toLowerCase() && evidence.payer === this.context.policy.payer && evidence.amount === row.offer.quote.amount && evidence.transaction.to === this.context.policy.router, 'JOURNAL_PROOF_MISMATCH', 'Observed payment does not match the tracked quote.');
      if (row.observedPayment) check(same(row.observedPayment, evidence), 'JOURNAL_PROOF_MISMATCH', 'Observed payment evidence cannot change.');
      row.tokenReserved = '0'; row.tokenSpent = row.offer.quote.amount; row.observedPayment = evidence;
      this.addFee(row, 'observed_payment', evidence); this.save(row); return this.enriched(row);
    });
  }
  markComplete(id, response) {
    object(response, ['result', 'receipt', 'receiptSignature', 'receiptSigner'], 'delivery response');
    check(Object.keys(response).length === 4, 'JOURNAL_INVALID_INPUT', 'Only the verified service result and receipt can be recorded.');
    object(response.result, ['service', 'version', 'dialect', 'canonicalization', 'digestAlgorithm', 'valid', 'errors', 'canonicalJson', 'sha256', 'bytes', 'inputNodes'], 'service result');
    object(response.receipt, ['protocol', 'quoteId', 'requestHash', 'resultHash', 'payer', 'amount', 'asset', 'chainId', 'token', 'router', 'recipient', 'quoteSigner', 'transactionHash', 'blockNumber', 'blockHash', 'logIndex', 'settledAt', 'localOnly'], 'service receipt');
    check(typeof response.result.canonicalJson === 'string' && Array.isArray(response.result.errors), 'JOURNAL_INVALID_INPUT', 'Invalid deterministic service result.');
    for (const item of response.result.errors) object(item, ['instancePath', 'keyword', 'message', 'expected', 'observedType'], 'validation error');
    check(typeof response.receiptSignature === 'string' && /^0x[0-9a-fA-F]{130}$/.test(response.receiptSignature), 'JOURNAL_INVALID_INPUT', 'Receipt signature must be public EVM signature data.');
    address(response.receiptSigner, 'receiptSigner');
    check(Buffer.byteLength(canonicalStringify(response)) <= 1048576, 'JOURNAL_INVALID_INPUT', 'Result exceeds journal response limit.');
    return this.transact(() => {
      const row = this.requireRow(id);
      check(row.tokenSpent === row.offer.quote.amount && (row.paymentProof?.success || row.observedPayment?.success), 'JOURNAL_PHASE_CONFLICT', 'No verified payment exists for this result.');
      if (row.response) check(same(row.response, response), 'JOURNAL_PROOF_MISMATCH', 'Recorded delivery response cannot change.');
      row.response = clone(response); if (row.phase === 'settled') row.phase = 'complete';
      this.save(row); return this.enriched(row);
    });
  }
  cancelReserved(id) {
    return this.transact(() => {
      const row = this.requireRow(id);
      check(row.phase === 'reserved' && row.approvalIntent === null && row.paymentIntent === null, 'JOURNAL_PHASE_CONFLICT', 'Only a reservation with no send intent can be cancelled.');
      this.requireGate(row); row.tokenReserved = '0'; row.approvalReservedWei = '0'; row.paymentReservedWei = '0'; row.phase = 'cancelled';
      this.releaseGate(row); this.save(row); return this.enriched(row);
    });
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
}
