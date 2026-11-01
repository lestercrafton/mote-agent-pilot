import { DatabaseSync } from 'node:sqlite';
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getAddress, Interface } from 'ethers';
import { canonicalStringify, hashJson } from './json.mjs';
import { normalizeEthereumFeeTransaction } from './ethereum-fees.mjs';

const CLAIM = new Interface(['function claim()']);
export const CLAIM_CALLDATA = CLAIM.encodeFunctionData('claim').toLowerCase();
const HASH = /^0x[0-9a-f]{64}$/;
const KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const TX_FIELDS = ['type', 'chainId', 'from', 'to', 'nonce', 'gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas', 'value', 'data'];
const POLICY_FIELDS = ['enabled', 'chainId', 'payer', 'serviceOrigin', 'baseConfigHash', 'dispenserConfigHash', 'dispenser', 'claimGasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas', 'maxClaimGasWei', 'maxPaymentGasWei', 'maxTotalGasWei'];
const TERMINAL = new Set(['complete', 'failed', 'cancelled']);
const SCHEMA = {
  meta: 'CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), context TEXT NOT NULL, context_hash TEXT NOT NULL)',
  state: 'CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL, data_hash TEXT NOT NULL)',
};
const shape = sql => sql.replace(/\s+/g, ' ').trim().replace(/;$/, '');
const same = (a, b) => canonicalStringify(a) === canonicalStringify(b);
const clone = value => structuredClone(value);
export class ClaimJournalError extends Error {
  constructor(code, message, cause) { super(message, { cause }); this.name = 'ClaimJournalError'; this.code = code; this.doNotRepay = true; }
}
const check = (value, code, message) => { if (!value) throw new ClaimJournalError(code, message); };
function fields(value, names, label) {
  check(value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name)), 'CLAIM_INPUT_INVALID', `${label} requires exactly the supported public fields.`);
}
function uint(value) { check(typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value) && BigInt(value) < 1n << 256n, 'CLAIM_INPUT_INVALID', 'Use bounded unsigned decimal integer strings.'); return BigInt(value); }
function hash(value) { check(typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value), 'CLAIM_INPUT_INVALID', 'Expected a 32-byte public hash.'); return value.toLowerCase(); }
function address(value) { try { return getAddress(value).toLowerCase(); } catch { throw new ClaimJournalError('CLAIM_INPUT_INVALID', 'Expected an EVM address.'); } }
function fileIdentity(path) {
  const stat = lstatSync(path);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o222) !== 0, 'CLAIM_JOURNAL_UNAVAILABLE', 'Journal must be a writable regular file without aliases or hardlinks.');
  accessSync(path, constants.R_OK | constants.W_OK); accessSync(dirname(path), constants.R_OK | constants.W_OK);
  return { path: realpathSync(path), dev: stat.dev, ino: stat.ino };
}
function binding({ policyId, policy, dispenserIdentity: i, paymentJournal }) {
  check(typeof policyId === 'string' && KEY.test(policyId), 'CLAIM_INPUT_INVALID', 'Use an explicit public policy ID.');
  fields(policy, POLICY_FIELDS, 'Claim policy');
  const p = clone(policy);
  check(typeof p.enabled === 'boolean' && p.chainId === 11155111, 'CLAIM_INPUT_INVALID', 'Claim authority supports only Ethereum Sepolia.');
  p.payer = address(p.payer); p.dispenser = address(p.dispenser);
  for (const key of ['baseConfigHash', 'dispenserConfigHash']) p[key] = hash(p[key]);
  const origin = new URL(p.serviceOrigin);
  check(origin.origin === p.serviceOrigin && origin.protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname), 'CLAIM_INPUT_INVALID', 'Pin the exact non-loopback HTTPS service origin.');
  for (const key of ['claimGasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas', 'maxClaimGasWei', 'maxPaymentGasWei', 'maxTotalGasWei']) p[key] = uint(p[key]).toString();
  check(BigInt(p.claimGasLimit) >= 21000n && BigInt(p.claimGasLimit) <= 500000n && BigInt(p.maxFeePerGas) > 0n && BigInt(p.maxPriorityFeePerGas) <= BigInt(p.maxFeePerGas), 'CLAIM_INPUT_INVALID', 'Claim execution gas/fee limits are invalid.');
  check(BigInt(p.claimGasLimit) * BigInt(p.maxFeePerGas) <= BigInt(p.maxClaimGasWei) && BigInt(p.maxClaimGasWei) + BigInt(p.maxPaymentGasWei) <= BigInt(p.maxTotalGasWei), 'CLAIM_BUDGET_INVALID', 'Fixed claim and payment allocations must fit the aggregate authorization.');
  check(paymentJournal?.context && typeof paymentJournal.budget === 'function', 'CLAIM_PAYMENT_JOURNAL_REQUIRED', 'An explicitly initialized existing payment journal is required.');
  paymentJournal.assertContext({ policy: paymentJournal.context.policy, chainIdentity: paymentJournal.context.chainIdentity });
  const pp = paymentJournal.context.policy;
  check(pp.chainId === p.chainId && pp.payer === p.payer && pp.serviceOrigin === p.serviceOrigin && pp.configHash === p.baseConfigHash && pp.maxGasTotalWei === p.maxPaymentGasWei, 'CLAIM_IDENTITY_MISMATCH', 'Payment policy must use the same payer/deployment and exact fixed fee allocation.');
  check(i?.schema === 'mote-dispenser-identity-v1' && i.chainId === p.chainId && i.origin === p.serviceOrigin && i.baseConfigHash === p.baseConfigHash && i.dispenserConfigHash === p.dispenserConfigHash && address(i.dispenser) === p.dispenser && address(i.token) === pp.token && address(i.router) === pp.router && address(i.recipient) === pp.recipient && address(i.quoteSigner) === pp.quoteSigner && i.genesisHash === paymentJournal.context.chainIdentity.genesisHash, 'CLAIM_IDENTITY_MISMATCH', 'Verified dispenser identity differs from the pinned payment deployment.');
  // Store only public projections and hashes, never arbitrary caller objects.
  const identity = { identityHash: hashJson(i), genesisHash: hash(i.genesisHash), runtimeCodeHash: hash(i.runtimeCodeHash), deploymentHash: hashJson(i.deployment), fundingHash: hashJson(i.funding), checkpointHash: hashJson(i.checkpoint), claimAmount: uint(i.claimAmount).toString(), distributionCap: uint(i.distributionCap).toString() };
  return { version: 1, policyId, policy: p, identity, payment: { ...fileIdentity(paymentJournal.path), contextHash: hashJson(paymentJournal.context) } };
}
function fresh() { return { revision: 0, gate: null, claim: { phase: 'none', operation: null, intent: null, transactionHash: null, proof: null, inspection: null }, operations: [], paymentSpentFloorWei: '0' }; }
function proofProjection(input) {
  fields(input, ['transactionHash', 'feeWei', 'success', 'blockNumber', 'blockHash', 'transaction', 'claimEvidenceHash'], 'Canonical claim proof');
  check(typeof input.success === 'boolean', 'CLAIM_INPUT_INVALID', 'Claim proof requires receipt status.');
  return { transactionHash: hash(input.transactionHash), feeWei: uint(input.feeWei).toString(), success: input.success, blockNumber: uint(input.blockNumber).toString(), blockHash: hash(input.blockHash), transaction: normalizeEthereumFeeTransaction(input.transaction), claimEvidenceHash: input.success ? hash(input.claimEvidenceHash) : (check(input.claimEvidenceHash === null, 'CLAIM_INPUT_INVALID', 'Reverted claim cannot contain success evidence.'), null) };
}

/** One non-expiring outer wallet gate spans claim and paid work. Both journal
 * files are trusted local authority: copying/rolling back valid databases or
 * using the raw signer outside this wrapper is outside the protection. */
export class ClaimBudgetJournal {
  static initialize(options) {
    const context = binding(options), path = resolve(options.path);
    check(options.paymentJournal.list().length === 0, 'CLAIM_PAYMENT_HISTORY_EXISTS', 'Initialize onboarding authority before this payment journal has any attempts.');
    let fd;
    try { fd = openSync(path, 'wx', 0o600); closeSync(fd); } catch (cause) { throw new ClaimJournalError(cause.code === 'EEXIST' ? 'CLAIM_JOURNAL_EXISTS' : 'CLAIM_JOURNAL_UNAVAILABLE', 'Initialization requires an unused path and never overwrites authority.', cause); }
    let db;
    try {
      db = new DatabaseSync(realpathSync(path));
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE; ${Object.values(SCHEMA).join(';')}; PRAGMA user_version=1;`);
      db.prepare('INSERT INTO meta VALUES(1,?,?)').run(canonicalStringify(context), hashJson(context));
      const state = fresh(); db.prepare('INSERT INTO state VALUES(1,?,?)').run(canonicalStringify(state), hashJson(state));
      db.exec('COMMIT'); db.close();
    } catch (cause) { try { db?.close(); } catch {} throw new ClaimJournalError('CLAIM_JOURNAL_UNAVAILABLE', 'Initialization failed; preserve the file, never recreate automatically.', cause); }
    return new ClaimBudgetJournal(options);
  }
  constructor(options) {
    this.path = resolve(options.path); this.context = binding(options); this.paymentJournal = options.paymentJournal;
    this.owner = randomUUID(); this.closed = false;
    try {
      this.file = fileIdentity(this.path); this.db = new DatabaseSync(this.file.path);
      this.db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL;'); this.transact(() => {});
    } catch (cause) { try { this.db?.close(); } catch {} this.closed = true; if (cause instanceof ClaimJournalError) throw cause; throw new ClaimJournalError('CLAIM_JOURNAL_UNAVAILABLE', 'Existing journal could not be opened; no fallback or reset is permitted.', cause); }
  }
  assertFiles() {
    check(!this.closed, 'CLAIM_JOURNAL_UNAVAILABLE', 'Claim journal is closed.');
    try {
      check(same(fileIdentity(this.path), this.file) && same(fileIdentity(this.paymentJournal.path), { path: this.context.payment.path, dev: this.context.payment.dev, ino: this.context.payment.ino }), 'CLAIM_JOURNAL_FILE_CHANGED', 'An authority file was replaced or changed identity.');
      let fd;
      try { fd = openSync(this.path, 'r'); const stat = fstatSync(fd), bytes = Buffer.alloc(16); check(stat.ino === this.file.ino && stat.dev === this.file.dev && readSync(fd, bytes, 0, 16, 0) === 16 && bytes.equals(Buffer.from('SQLite format 3\0')), 'CLAIM_JOURNAL_CORRUPT', 'Authority file header is invalid.'); }
      finally { if (fd !== undefined) closeSync(fd); }
      check(hashJson(this.paymentJournal.context) === this.context.payment.contextHash, 'CLAIM_IDENTITY_MISMATCH', 'Payment journal context changed.');
    } catch (cause) { if (cause instanceof ClaimJournalError) throw cause; throw new ClaimJournalError('CLAIM_JOURNAL_UNAVAILABLE', 'An existing authority file is unavailable; spending stops.', cause); }
  }
  load() {
    check(this.db.prepare('PRAGMA user_version').get().user_version === 1 && this.db.prepare('PRAGMA quick_check').all().every(row => Object.values(row)[0] === 'ok'), 'CLAIM_JOURNAL_CORRUPT', 'SQLite integrity/schema version failed.');
    const tables = this.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    check(same(tables.map(t => t.name), ['meta', 'state']) && tables.every(t => t.type === 'table' && shape(t.sql) === shape(SCHEMA[t.name])), 'CLAIM_JOURNAL_CORRUPT', 'Authority schema, constraints or extra objects changed.');
    const metas = this.db.prepare('SELECT * FROM meta').all(), states = this.db.prepare('SELECT * FROM state').all();
    check(metas.length === 1 && states.length === 1 && metas[0].id === 1 && states[0].id === 1, 'CLAIM_JOURNAL_CORRUPT', 'Authority singleton is missing.');
    const context = JSON.parse(metas[0].context), state = JSON.parse(states[0].data);
    check(hashJson(context) === metas[0].context_hash && hashJson(state) === states[0].data_hash, 'CLAIM_JOURNAL_CORRUPT', 'Authority checksum failed.');
    check(same(context, this.context), 'CLAIM_IDENTITY_MISMATCH', 'Policy, limits, deployment or payment journal identity changed.');
    this.validateState(state); return state;
  }
  validateState(s) {
    fields(s, ['revision', 'gate', 'claim', 'operations', 'paymentSpentFloorWei'], 'Authority state');
    check(Number.isSafeInteger(s.revision) && s.revision >= 0 && Array.isArray(s.operations) && s.operations.length <= 1024, 'CLAIM_JOURNAL_CORRUPT', 'Authority state is malformed or exceeds bounded history.');
    const c = s.claim;
    fields(c, ['phase', 'operation', 'intent', 'transactionHash', 'proof', 'inspection'], 'Claim state');
    check(['none', 'intent', 'submitted', 'unknown', 'confirmed', 'failed', 'preexisting'].includes(c.phase), 'CLAIM_JOURNAL_CORRUPT', 'Unknown claim phase.');
    if (['none', 'preexisting'].includes(c.phase)) check(!c.operation && !c.intent && !c.transactionHash && !c.proof, 'CLAIM_JOURNAL_CORRUPT', 'Unattempted claim contains send evidence.');
    else { this.validateClaimIntent(c.intent); check(s.operations.some(op => op.key === c.operation), 'CLAIM_JOURNAL_CORRUPT', 'Claim lost its owning operation.'); }
    if (c.phase === 'none') check(c.inspection === null, 'CLAIM_JOURNAL_CORRUPT', 'Unattempted claim has unexpected inspection.');
    if (c.phase === 'preexisting') this.validateInspection(c.inspection);
    if (c.transactionHash !== null) hash(c.transactionHash);
    if (c.phase === 'submitted') check(c.transactionHash, 'CLAIM_JOURNAL_CORRUPT', 'Submitted claim has no hash.');
    if (['confirmed', 'failed'].includes(c.phase)) {
      check(c.proof && same(proofProjection(c.proof), c.proof) && c.transactionHash === c.proof.transactionHash && same(c.intent, c.proof.transaction) && c.proof.success === (c.phase === 'confirmed'), 'CLAIM_JOURNAL_CORRUPT', 'Resolved claim lost its exact original fee proof.');
    } else check(!c.proof, 'CLAIM_JOURNAL_CORRUPT', 'Unresolved claim contains a terminal proof.');
    check(new Set(s.operations.map(op => op.key)).size === s.operations.length, 'CLAIM_JOURNAL_CORRUPT', 'Duplicate operation keys.');
    for (const op of s.operations) {
      fields(op, ['key', 'requestHash', 'resultHash', 'owner', 'phase', 'quoteId', 'sends'], 'Operation');
      check(KEY.test(op.key) && HASH.test(op.requestHash) && HASH.test(op.resultHash) && /^[a-f0-9-]{36}$/.test(op.owner) && ['reserved', 'claim', 'payment', 'unknown', 'complete', 'failed', 'cancelled'].includes(op.phase), 'CLAIM_JOURNAL_CORRUPT', 'Operation identity is invalid.');
      check(op.quoteId === null || HASH.test(op.quoteId), 'CLAIM_JOURNAL_CORRUPT', 'Invalid operation quote.');
      fields(op.sends, ['approval', 'payment'], 'Payment sends');
      const row = op.quoteId ? this.paymentJournal.read(op.quoteId) : null;
      if (row) check(row.offer.quote.requestHash === op.requestHash && row.offer.resultHash === op.resultHash && row.idempotencyKey === op.key, 'CLAIM_JOURNAL_CORRUPT', 'Payment attempt differs from the operation.');
      for (const step of ['approval', 'payment']) if (op.sends[step]) {
        fields(op.sends[step], ['intentHash', 'transactionHash'], 'Payment send marker');
        check(HASH.test(op.sends[step].intentHash) && (op.sends[step].transactionHash === null || HASH.test(op.sends[step].transactionHash)) && row?.[`${step}Intent`] && hashJson(row[`${step}Intent`]) === op.sends[step].intentHash, 'CLAIM_JOURNAL_CORRUPT', 'Payment send lost its exact durable inner intent.');
        if (TERMINAL.has(op.phase)) check(row[`${step}Proof`] && op.sends[step].transactionHash === row[`${step}Hash`], 'CLAIM_JOURNAL_CORRUPT', 'Terminal operation retains unresolved send authority.');
      }
      if (!TERMINAL.has(op.phase)) check(s.gate === op.key, 'CLAIM_JOURNAL_CORRUPT', 'Unresolved operation lost the wallet gate.');
      if (op.phase === 'complete') check(row && ['complete', 'settled'].includes(row.phase), 'CLAIM_JOURNAL_CORRUPT', 'Completed operation has no finalized payment.');
    }
    check(s.gate === null || s.operations.some(op => op.key === s.gate && !TERMINAL.has(op.phase)), 'CLAIM_JOURNAL_CORRUPT', 'Wallet gate is invalid.');
    if (['intent', 'submitted', 'unknown'].includes(c.phase)) check(s.gate === c.operation, 'CLAIM_JOURNAL_CORRUPT', 'Unresolved claim lost its gate.');
    const budget = this.paymentJournal.budget();
    check(BigInt(budget.gasSpentWei) >= uint(s.paymentSpentFloorWei), 'CLAIM_JOURNAL_CORRUPT', 'Payment accounting regressed below durable observation.');
  }
  transact(action) {
    this.assertFiles();
    try {
      this.db.exec('BEGIN IMMEDIATE'); const state = this.load(); const result = action(state);
      this.validateState(state); this.assertFiles();
      state.paymentSpentFloorWei = this.paymentJournal.budget().gasSpentWei;
      state.revision++; this.db.prepare('UPDATE state SET data=?,data_hash=? WHERE id=1').run(canonicalStringify(state), hashJson(state));
      this.db.exec('COMMIT'); return clone(result);
    } catch (cause) { try { this.db.exec('ROLLBACK'); } catch {} if (cause instanceof ClaimJournalError || cause.code?.startsWith('JOURNAL_')) throw cause; throw new ClaimJournalError('CLAIM_JOURNAL_CORRUPT', 'Claim authority operation failed closed; preserve all reservations.', cause); }
  }
  assertContext({ policy, dispenserIdentity }) {
    const expected = binding({ policyId: this.context.policyId, policy, dispenserIdentity, paymentJournal: this.paymentJournal });
    return this.transact(() => { check(same(expected, this.context), 'CLAIM_IDENTITY_MISMATCH', 'Claim policy or verified deployment changed.'); return true; });
  }
  budget() {
    return this.transact(s => {
      const payment = this.paymentJournal.budget(), c = s.claim;
      const claimReservedWei = ['intent', 'submitted', 'unknown'].includes(c.phase) ? this.context.policy.maxClaimGasWei : '0';
      const claimSpentWei = c.proof?.feeWei ?? '0';
      return { claimReservedWei, claimSpentWei, paymentReservedWei: payment.gasReservedWei, paymentSpentWei: payment.gasSpentWei, totalReservedWei: (BigInt(claimReservedWei) + BigInt(payment.gasReservedWei)).toString(), totalSpentWei: (BigInt(claimSpentWei) + BigInt(payment.gasSpentWei)).toString(), maximumAuthorizedWei: this.context.policy.maxTotalGasWei };
    });
  }
  read(key) { return this.transact(s => s.operations.find(op => op.key === key) ?? null); }
  claim() { return this.transact(s => s.claim); }
  owned(s, key) { const op = s.operations.find(op => op.key === key); check(op && s.gate === key && op.owner === this.owner && !TERMINAL.has(op.phase), 'CLAIM_OWNER_MISMATCH', 'Only the original live operation owner can send; recovery never transfers authority.'); return op; }
  acquire({ key, requestHash, resultHash }) {
    check(KEY.test(key), 'CLAIM_INPUT_INVALID', 'Use an explicit 8–128 character operation key.'); requestHash = hash(requestHash); resultHash = hash(resultHash);
    return this.transact(s => {
      const previous = s.operations.find(op => op.key === key);
      if (previous) { check(previous.requestHash === requestHash && previous.resultHash === resultHash, 'CLAIM_OPERATION_CONFLICT', 'Operation key cannot change original input.'); return { created: false, operation: previous }; }
      check(this.context.policy.enabled && this.paymentJournal.context.policy.enabled, 'SPENDING_DISABLED', 'Both claim and payment policies must enable this operation.');
      check(s.gate === null, 'CLAIM_WALLET_BUSY', 'Another operation retains the wallet gate; reconcile without retransmitting.');
      check(this.paymentJournal.list().every(row => ['complete', 'settled', 'failed', 'cancelled'].includes(row.phase)), 'CLAIM_PAYMENT_BUSY', 'Existing payment authority is unresolved.');
      check(s.operations.length < 1024, 'CLAIM_HISTORY_FULL', 'Bounded journal history is full; no new authority is created.');
      const op = { key, requestHash, resultHash, owner: this.owner, phase: 'reserved', quoteId: null, sends: { approval: null, payment: null } };
      s.operations.push(op); s.gate = key; return { created: true, operation: op };
    });
  }
  validateClaimIntent(raw) {
    const tx = normalizeEthereumFeeTransaction(raw), p = this.context.policy;
    check(tx.from === p.payer && tx.to === p.dispenser && tx.data === CLAIM_CALLDATA && tx.gasLimit === p.claimGasLimit && tx.maxFeePerGas === p.maxFeePerGas && tx.maxPriorityFeePerGas === p.maxPriorityFeePerGas && BigInt(tx.gasLimit) * BigInt(tx.maxFeePerGas) <= BigInt(p.maxClaimGasWei), 'CLAIM_INTENT_DENIED', 'Claim must use the exact allowlisted selector, payer, contract and fee fields.'); return tx;
  }
  beginClaim(key, intent) {
    const tx = this.validateClaimIntent(intent);
    return this.transact(s => { const op = this.owned(s, key); check(s.claim.phase === 'none' && op.phase === 'reserved', 'CLAIM_PHASE_CONFLICT', 'A claim can be attempted only once for this authority.'); s.claim = { phase: 'intent', operation: key, intent: tx, transactionHash: null, proof: null, inspection: null }; op.phase = 'claim'; return s.claim; });
  }
  submittedClaim(key, transactionHash) {
    transactionHash = hash(transactionHash);
    return this.transact(s => { this.owned(s, key); check(s.claim.operation === key && ['intent', 'unknown', 'submitted'].includes(s.claim.phase), 'CLAIM_PHASE_CONFLICT', 'No original claim intent exists.'); check(!s.claim.transactionHash || s.claim.transactionHash === transactionHash, 'CLAIM_TRANSACTION_CONFLICT', 'Claim hash cannot change.'); s.claim.transactionHash = transactionHash; s.claim.phase = 'submitted'; return s.claim; });
  }
  unknown(key) { return this.transact(s => { const op = this.owned(s, key); op.phase = 'unknown'; if (['intent', 'submitted'].includes(s.claim.phase)) s.claim.phase = 'unknown'; return op; }); }
  recordClaim(input) {
    const proof = proofProjection(input);
    return this.transact(s => {
      const c = s.claim;
      if (c.proof) { check(same(c.proof, proof), 'CLAIM_PROOF_MISMATCH', 'Canonical claim fee evidence is immutable.'); return c; }
      check(c.transactionHash === proof.transactionHash && c.intent && same(c.intent, proof.transaction) && ['submitted', 'unknown'].includes(c.phase), 'CLAIM_PROOF_MISMATCH', 'Only a durably known original hash may resolve the claim intent.');
      c.proof = proof; c.phase = proof.success ? 'confirmed' : 'failed'; return c;
    });
  }
  validateInspection(i) {
    fields(i, ['payer', 'claimed', 'finalized', 'dispenserConfigHash'], 'Claim inspection');
    fields(i.finalized, ['blockNumber', 'blockHash'], 'Inspection anchor'); uint(i.finalized.blockNumber); hash(i.finalized.blockHash);
    check(i.claimed === true && address(i.payer) === this.context.policy.payer && i.dispenserConfigHash === this.context.policy.dispenserConfigHash, 'CLAIM_PROOF_MISMATCH', 'Inspection must bind a canonical preexisting claim to this payer.');
  }
  recordPreexisting(key, input) {
    const inspection = { payer: address(input.payer), claimed: input.claimed, finalized: { blockNumber: String(input.finalized?.blockNumber), blockHash: input.finalized?.blockHash }, dispenserConfigHash: input.dispenserConfigHash }; this.validateInspection(inspection);
    return this.transact(s => { this.owned(s, key); check(s.claim.phase === 'none', 'CLAIM_PHASE_CONFLICT', 'Inspection cannot erase an attempted or uncertain claim.'); s.claim.phase = 'preexisting'; s.claim.inspection = inspection; return s.claim; });
  }
  bindQuote(key, offer) {
    this.paymentJournal.validateOffer(offer);
    return this.transact(s => { const op = this.owned(s, key); check(['confirmed', 'preexisting'].includes(s.claim.phase) && (s.claim.proof === null || BigInt(s.claim.proof.feeWei) <= BigInt(this.context.policy.maxClaimGasWei)), 'CLAIM_NOT_FINALIZED', 'Payment requires finalized successful claim evidence within its allocation.'); check(op.quoteId === null && offer.quote.requestHash === op.requestHash && offer.resultHash === op.resultHash, 'CLAIM_OPERATION_CONFLICT', 'Quote must bind this original task exactly.'); op.quoteId = hash(offer.quote.quoteId); op.phase = 'payment'; return op; });
  }
  authorizePaymentSend(raw) {
    // Signer input has bigint/number numeric values; whitelist before conversion.
    fields(raw, TX_FIELDS, 'Payment signer request');
    const normalized = { ...raw }; for (const k of ['nonce', 'gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas', 'value']) normalized[k] = String(raw[k]);
    const tx = normalizeEthereumFeeTransaction(normalized);
    return this.transact(s => {
      const op = this.owned(s, s.gate), row = op.quoteId ? this.paymentJournal.read(op.quoteId) : null;
      check(op.phase === 'payment' && ['confirmed', 'preexisting'].includes(s.claim.phase), 'CLAIM_PHASE_CONFLICT', 'Outer wallet authority is not ready for payment.');
      const step = row?.phase === 'approval_intent' ? 'approval' : row?.phase === 'payment_intent' ? 'payment' : null;
      check(step && row.owner === this.paymentJournal.owner && same(row[`${step}Intent`], tx) && !op.sends[step], 'CLAIM_PAYMENT_INTENT_DENIED', 'Payment send must match one new durable inner intent and cannot repeat.');
      if (step === 'approval' && s.claim.intent) check(BigInt(tx.nonce) > BigInt(s.claim.intent.nonce), 'CLAIM_NONCE_CONFLICT', 'Payment nonce cannot reuse the claim nonce.');
      const b = this.paymentJournal.budget();
      check(BigInt(b.gasSpentWei) + BigInt(b.gasReservedWei) <= BigInt(this.context.policy.maxPaymentGasWei) && BigInt(s.claim.proof?.feeWei ?? '0') <= BigInt(this.context.policy.maxClaimGasWei), 'CLAIM_TOTAL_LIMIT', 'Fixed claim/payment fee allocation is exhausted.');
      op.sends[step] = { intentHash: hashJson(tx), transactionHash: null }; return { key: op.key, step };
    });
  }
  submittedPayment(key, step, transactionHash) {
    transactionHash = hash(transactionHash);
    return this.transact(s => { const op = this.owned(s, key), marker = op.sends[step]; check(marker && (!marker.transactionHash || marker.transactionHash === transactionHash), 'CLAIM_TRANSACTION_CONFLICT', 'Payment send marker cannot change.'); marker.transactionHash = transactionHash; return op; });
  }
  finish(key) {
    return this.transact(s => {
      const op = s.operations.find(op => op.key === key); check(op, 'CLAIM_UNTRACKED', 'Unknown operation.'); if (TERMINAL.has(op.phase)) return op;
      check(s.gate === key && !['intent', 'submitted', 'unknown'].includes(s.claim.phase), 'CLAIM_STATE_UNKNOWN', 'An unresolved claim retains the gate indefinitely.');
      const row = op.quoteId ? this.paymentJournal.read(op.quoteId) : null;
      // bindQuote is a durable handoff intent: the original async execute may
      // still reserve its inner row. Absence now cannot fence that future write.
      check(!op.quoteId || row, 'CLAIM_STATE_UNKNOWN', 'A begun payment handoff with no inner row remains unresolved; no new wallet operation is authorized.');
      check(!row || ['complete', 'settled', 'failed', 'cancelled'].includes(row.phase), 'CLAIM_STATE_UNKNOWN', 'An unresolved payment retains the outer gate.');
      for (const step of ['approval', 'payment']) if (op.sends[step]) check(row?.[`${step}Proof`] && row[`${step}Hash`] === op.sends[step].transactionHash, 'CLAIM_STATE_UNKNOWN', 'Unknown original payment submission retains the outer gate.');
      op.phase = row && ['complete', 'settled'].includes(row.phase) ? 'complete' : s.claim.phase === 'none' ? 'cancelled' : 'failed'; s.gate = null; return op;
    });
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
}
