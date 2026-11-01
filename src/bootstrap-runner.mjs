import { R1, assertRecoveryTime } from './recovery-r1-policy.mjs';
import { DatabaseSync } from 'node:sqlite';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Transaction, getAddress } from 'ethers';
import { BootstrapError, validateBootstrapPlan } from './bootstrap-plan.mjs';
import { canonicalStringify, hashJson } from './json.mjs';
import { createEthereumSepoliaReader } from './testnet-rpc.mjs';
import { verifyBootstrapStep, createLoopbackBootstrapVerifier, bootstrapGasRequirements } from './bootstrap-verifier.mjs';

const HASH = /^0x[0-9a-f]{64}$/;
const STATES = new Set(['pending', 'intent', 'signed', 'submitted', 'unknown', 'finalized', 'failed']);
const SCHEMA = {
  meta: 'CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL, checksum TEXT NOT NULL)',
  steps: 'CREATE TABLE steps (idx INTEGER PRIMARY KEY CHECK(idx>=0 AND idx<5), data TEXT NOT NULL, checksum TEXT NOT NULL)',
};
const LOCK_SCHEMA = 'CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), binding TEXT NOT NULL)';
const check = (ok, code, message) => { if (!ok) throw new BootstrapError(code, message); };
const same = (a, b) => canonicalStringify(a) === canonicalStringify(b);
const clone = (value) => structuredClone(value);
function exact(value, keys, code) { check(value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)), code, 'Only exact supported public fields are accepted'); }
function integer(value) { check(typeof value === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value), 'BOOTSTRAP_EVIDENCE', 'Malformed RPC quantity'); return BigInt(value); }
function unsigned(tx) { const { from, ...request } = tx; return request; }
function transactionEncoding(tx) { return Transaction.from({ ...unsigned(tx), nonce: Number(tx.nonce), gasLimit: BigInt(tx.gasLimit),
  maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas), value: BigInt(tx.value) }).unsignedSerialized; }
function binding(plan, mode, genesisHash) { return { schema: 'mote-bootstrap-journal-v1', planHash: plan.planHash, policyHash: plan.policyHash, operator: plan.roles.operator, chainId: 11155111, mode, genesisHash }; }
function fixtureCheck(ack, genesisHash) { check(ack === 'LOCAL_EVM_ONLY' && typeof genesisHash === 'string' && HASH.test(genesisHash), 'BOOTSTRAP_FIXTURE', 'Explicit local fixture acknowledgement and genesis are required'); }
function inspect(path) {
  let fd;
  try {
    const parent = lstatSync(dirname(path)), file = lstatSync(path);
    check(parent.isDirectory() && !parent.isSymbolicLink() && realpathSync(dirname(path)) === dirname(path)
      && file.isFile() && !file.isSymbolicLink() && file.nlink === 1 && (file.mode & 0o600) === 0o600,
    'BOOTSTRAP_STORAGE', 'Journal must be a canonical, writable, single-link regular file');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd), header = Buffer.alloc(16);
    check(opened.ino === file.ino && opened.dev === file.dev && readSync(fd, header, 0, 16, 0) === 16 && header.equals(Buffer.from('SQLite format 3\0')),
      'BOOTSTRAP_STORAGE', 'Journal changed while opening or is not SQLite');
    return { ino: file.ino, dev: file.dev, parentIno: parent.ino, parentDev: parent.dev };
  } catch (error) { if (error instanceof BootstrapError) throw error; throw new BootstrapError('BOOTSTRAP_STORAGE', 'Existing journal and process gate are required; never initialize automatically'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
function schema(db, expected) {
  const shape = (sql) => sql.replace(/\s+/g, ' ').trim();
  const rows = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name").all();
  const names = Object.keys(expected).sort();
  check(rows.length === names.length && rows.every((row, i) => row.name === names[i] && shape(row.sql) === shape(expected[row.name]))
    && db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type IN ('trigger','view') OR (type='index' AND sql IS NOT NULL)").get().n === 0
    && db.prepare('PRAGMA user_version').get().user_version === 1
    && db.prepare('PRAGMA quick_check').all().every((row) => Object.values(row)[0] === 'ok'), 'BOOTSTRAP_CORRUPT', 'Journal schema or integrity changed');
}
function initialize({ path, plan: rawPlan }, mode, genesisHash) {
  const plan = validateBootstrapPlan(rawPlan), filename = resolve(path), meta = binding(plan, mode, genesisHash ?? plan.genesisHash);
  check(realpathSync(dirname(filename)) === dirname(filename), 'BOOTSTRAP_STORAGE', 'Canonical authority directory required');
  for (const name of [filename, `${filename}.lock.sqlite`]) {
    try { lstatSync(name); throw new BootstrapError('BOOTSTRAP_EXISTS', 'Existing authority must never be overwritten or reset'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const [name, lock] of [[filename, false], [`${filename}.lock.sqlite`, true]]) {
    const fd = openSync(name, 'wx', 0o600); closeSync(fd);
    const db = new DatabaseSync(name, { allowExtension: false, defensive: true });
    try {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
      if (lock) { db.exec(LOCK_SCHEMA); db.prepare('INSERT INTO meta VALUES (1,?)').run(canonicalStringify(meta)); }
      else {
        for (const sql of Object.values(SCHEMA)) db.exec(sql);
        db.prepare('INSERT INTO meta VALUES (1,?,?)').run(canonicalStringify(meta), hashJson(meta));
        for (let index = 0; index < 5; index++) {
          const row = { index, state: 'pending', intent: plan.transactions[index].transaction, transactionHash: null, proof: null };
          db.prepare('INSERT INTO steps VALUES (?,?,?)').run(index, canonicalStringify(row), hashJson(row));
        }
      }
      db.exec('PRAGMA user_version=1; COMMIT;');
    } finally { db.close(); }
  }
  return { path: filename, ...meta };
}
export function initializeBootstrapJournal(options) { exact(options, ['path', 'plan'], 'BOOTSTRAP_CONFIG'); return initialize(options, 'public', null); }
export function initializeLocalBootstrapJournal({ ack, genesisHash, ...options }) { fixtureCheck(ack, genesisHash); exact(options, ['path', 'plan'], 'BOOTSTRAP_CONFIG'); return initialize(options, 'local-fixture', genesisHash); }

class Journal {
  constructor(path, plan, mode, genesisHash) {
    this.path = resolve(path); this.lockPath = `${this.path}.lock.sqlite`; this.plan = plan;
    this.binding = binding(plan, mode, genesisHash); this.failed = false; this.closed = false;
    this.file = inspect(this.path); this.lockFile = inspect(this.lockPath);
    try {
      this.gate = new DatabaseSync(this.lockPath, { allowExtension: false, defensive: true });
      this.gate.exec('PRAGMA busy_timeout=50; BEGIN IMMEDIATE;'); schema(this.gate, { meta: LOCK_SCHEMA });
      this.db = new DatabaseSync(this.path, { allowExtension: false, defensive: true });
      this.db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL;'); this.read();
    } catch (error) { this.db?.close(); this.gate?.close(); if (error instanceof BootstrapError) throw error; throw new BootstrapError('BOOTSTRAP_LOCKED', 'Exclusive operator journal gate is unavailable'); }
  }
  guard() {
    check(!this.closed && !this.failed, 'BOOTSTRAP_STORAGE', 'Journal is closed or failed');
    try {
      check(same(inspect(this.path), this.file) && same(inspect(this.lockPath), this.lockFile), 'BOOTSTRAP_STORAGE', 'Journal or authority directory was replaced');
      schema(this.db, SCHEMA);
      const meta = this.db.prepare('SELECT * FROM meta').all(), lock = this.gate.prepare('SELECT * FROM meta').all();
      check(meta.length === 1 && meta[0].data === canonicalStringify(this.binding) && meta[0].checksum === hashJson(this.binding)
        && lock.length === 1 && lock[0].binding === canonicalStringify(this.binding), 'BOOTSTRAP_IDENTITY', 'Journal does not bind this operator, plan, policy and chain');
    } catch (error) { this.failed = true; throw error; }
  }
  read() {
    this.guard(); const raw = this.db.prepare('SELECT * FROM steps ORDER BY idx').all();
    check(raw.length === 5, 'BOOTSTRAP_CORRUPT', 'Journal must contain exactly five immutable bootstrap steps');
    let unfinished = false;
    const rows = raw.map((stored, index) => {
      let row; try { row = JSON.parse(stored.data); } catch { throw new BootstrapError('BOOTSTRAP_CORRUPT', 'Malformed journal row'); }
      exact(row, ['index', 'state', 'intent', 'transactionHash', 'proof'], 'BOOTSTRAP_CORRUPT');
      check(stored.idx === index && row.index === index && hashJson(row) === stored.checksum && STATES.has(row.state)
        && same(row.intent, this.plan.transactions[index].transaction), 'BOOTSTRAP_CORRUPT', 'Step checksum, state or exact transaction changed');
      check(row.transactionHash === null || HASH.test(row.transactionHash), 'BOOTSTRAP_CORRUPT', 'Malformed transaction hash');
      check(!unfinished || row.state === 'pending', 'BOOTSTRAP_CORRUPT', 'A later step advanced before its predecessor finalized');
      if (row.state !== 'finalized') unfinished = true;
      if (['pending', 'intent'].includes(row.state)) check(row.transactionHash === null && row.proof === null, 'BOOTSTRAP_CORRUPT', 'Unsigned state contains submitted evidence');
      if (['signed', 'submitted'].includes(row.state)) check(row.transactionHash !== null && row.proof === null, 'BOOTSTRAP_CORRUPT', 'Signed state lacks its immutable hash');
      if (row.state === 'unknown') check(row.proof === null, 'BOOTSTRAP_CORRUPT', 'Unknown state contains terminal evidence');
      if (['finalized', 'failed'].includes(row.state)) check(row.transactionHash && row.proof?.transactionHash === row.transactionHash
        && row.proof.planHash === this.plan.planHash && row.proof.index === index && row.proof.success === (row.state === 'finalized')
        && same(row.proof.transaction, row.intent), 'BOOTSTRAP_CORRUPT', 'Terminal state lacks exact original evidence');
      return row;
    });
    return clone(rows);
  }
  change(index, expected, changes) {
    this.guard(); this.db.exec('BEGIN IMMEDIATE;');
    try {
      const row = this.read()[index]; check(expected.includes(row.state), 'BOOTSTRAP_STATE', 'State changed; never repeat an old signing or broadcast intent');
      Object.assign(row, changes);
      this.db.prepare('UPDATE steps SET data=?,checksum=? WHERE idx=?').run(canonicalStringify(row), hashJson(row), index);
      this.read(); this.db.exec('COMMIT;'); return clone(row);
    } catch (error) { try { this.db.exec('ROLLBACK;'); } catch {} throw error; }
  }
  close() { if (this.closed) return; this.closed = true; try { this.db?.close(); } finally { this.gate?.close(); } }
}

function authorization(raw, plan) {
  exact(raw, ['schema', 'enabled', 'planHash', 'policyHash', 'chainId', 'operator', 'maximumTotalNativeWei', 'expiresAt'], 'BOOTSTRAP_AUTHORIZATION');
  check(raw.schema === 'mote-bootstrap-authorization-v1' && raw.enabled === true && raw.planHash === plan.planHash && raw.policyHash === plan.policyHash
    && raw.chainId === 11155111 && raw.operator === plan.roles.operator && raw.maximumTotalNativeWei === plan.policy.maxTotalNativeWei
    && Number.isSafeInteger(raw.expiresAt) && raw.expiresAt > 0, 'BOOTSTRAP_AUTHORIZATION', 'An explicit caller authorization must bind this exact reviewed plan and policy');
  return Object.freeze(clone(raw));
}
let rpcId = 1;
async function bootstrapRpc(endpoint, method, params) {
  const id = rpcId++;
  check(Number.isSafeInteger(id), 'BOOTSTRAP_RPC', 'RPC identifier exhausted');
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(10000) });
  check(response.ok && !response.redirected && (!response.url || response.url === endpoint || response.url === `${endpoint}/`), 'BOOTSTRAP_BROADCAST_UNKNOWN', 'Submission response was unavailable or redirected; do not resubmit');
  const stream = response.body?.getReader(); check(stream, 'BOOTSTRAP_BROADCAST_UNKNOWN', 'Missing submission response');
  let size = 0; const chunks = [];
  try { for (;;) { const { done, value } = await stream.read(); if (done) break; size += value.byteLength;
    if (size > 262144) { await stream.cancel(); throw new BootstrapError('BOOTSTRAP_BROADCAST_UNKNOWN', 'Oversized submission response; do not resubmit'); } chunks.push(value); } }
  finally { stream.releaseLock(); }
  let reply; try { reply = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new BootstrapError('BOOTSTRAP_BROADCAST_UNKNOWN', 'Malformed submission response; do not resubmit'); }
  check(reply?.jsonrpc === '2.0' && reply.id === id && !reply.error && Object.hasOwn(reply, 'result')
    && Object.keys(reply).every((key) => ['jsonrpc', 'id', 'result'].includes(key)), 'BOOTSTRAP_RPC', 'RPC evidence is unavailable or its request identity differs');
  return reply.result;
}

const hex = (value) => `0x${BigInt(value).toString(16)}`;
async function estimate(plan, index, reader, genesisHash) {
  check(Number.isInteger(index) && index >= 0 && index < 5, 'BOOTSTRAP_CONFIG', 'Invalid bootstrap step');
  check(integer(await reader.send('eth_chainId', [])) === 11155111n, 'BOOTSTRAP_CHAIN', 'Wrong estimator network');
  const genesis = await reader.send('eth_getBlockByNumber', ['0x0', false]);
  check(genesis?.hash?.toLowerCase() === genesisHash && integer(genesis.number) === 0n, 'BOOTSTRAP_CHAIN', 'Estimator genesis changed');
  const tx = plan.transactions[index].transaction, head = await reader.send('eth_getBlockByNumber', ['latest', false]);
  check(head && typeof head.hash === 'string' && HASH.test(head.hash), 'BOOTSTRAP_EVIDENCE', 'Malformed estimator anchor');
  const headNumber = integer(head.number);
  const requirements = bootstrapGasRequirements({ plan, index, timestamp: integer(head.timestamp).toString() });
  check(requirements.knownWorkFits && BigInt(requirements.knownWorkFloorGas) <= BigInt(tx.gasLimit), 'BOOTSTRAP_GAS', 'Signed ceiling cannot cover the reviewed minimum work; no automatic increase is allowed');
  check(integer(head.baseFeePerGas) <= BigInt(tx.maxFeePerGas), 'BOOTSTRAP_BASE_FEE', 'Current base fee exceeds the exact signed ceiling');
  const request = { type: '0x2', chainId: hex(tx.chainId), from: tx.from, ...(tx.to === null ? {} : { to: tx.to }),
    nonce: hex(tx.nonce), value: hex(tx.value), data: tx.data, gas: hex(tx.gasLimit), maxFeePerGas: hex(tx.maxFeePerGas),
    maxPriorityFeePerGas: hex(tx.maxPriorityFeePerGas), accessList: [] };
  const gas = integer(await bootstrapRpc(reader.endpoint, 'eth_estimateGas', [request, head.number]));
  check(gas >= BigInt(requirements.knownWorkFloorGas) && gas <= BigInt(tx.gasLimit), 'BOOTSTRAP_GAS', 'RPC estimate is below reviewed necessary work or exceeds the fixed signed limit');
  const anchor = await reader.send('eth_getBlockByNumber', [head.number, false]);
  check(anchor?.hash === head.hash && integer(anchor.number) === headNumber, 'BOOTSTRAP_REORG', 'Estimation anchor changed');
  return { planHash: plan.planHash, index, gasEstimate: gas.toString(), gasLimit: tx.gasLimit, requirements,
    blockNumber: headNumber.toString(), blockHash: head.hash, authorization: false };
}
/** Separate read-only estimator; existing payment RPC allowlist is unchanged. */
export function estimateBootstrapTransaction({ plan: raw, index }) {
  const plan = validateBootstrapPlan(raw); return estimate(plan, index, createEthereumSepoliaReader(), plan.genesisHash);
}

async function open(options, fixture, recovery = null) {
  const allowed = ['plan', 'authorization', 'path', 'signer'];
  check(options && Object.keys(options).every((key) => allowed.includes(key)), 'BOOTSTRAP_CONFIG', 'Unknown runner option');
  const plan = validateBootstrapPlan(options.plan), permission = authorization(options.authorization, plan);
  if (recovery) {
    check(permission.expiresAt === Math.floor(R1.expiresAt/1000), 'BOOTSTRAP_RECOVERY_SCOPE', 'Recovery expiry is fixed by original approval');
    check(plan.roles.operator === recovery.operator && plan.roles.merchant === recovery.operator && plan.roles.quoteSigner === recovery.quoteSigner
      && plan.roles.payer !== recovery.originalPayer && plan.operatorNonce === '0' && plan.payerNativeWei === '7000000000000000'
      && plan.policy.combinedMaximumWei === R1.combinedCeilingWei, 'BOOTSTRAP_RECOVERY_SCOPE', 'Recovery may change only the payer');
  }
  // Capture opaque custody once: caller mutation across awaits cannot redirect
  // signing after the checked address or replace a method on the same object.
  const suppliedSigner = options.signer;
  const signer = suppliedSigner && typeof suppliedSigner.getAddress === 'function' && typeof suppliedSigner.signTransaction === 'function'
    ? Object.freeze({ getAddress: suppliedSigner.getAddress.bind(suppliedSigner), signTransaction: suppliedSigner.signTransaction.bind(suppliedSigner) }) : null;
  const reader = fixture?.reader ?? createEthereumSepoliaReader(), genesisHash = fixture?.genesisHash ?? plan.genesisHash;
  const verifier = fixture ? createLoopbackBootstrapVerifier(fixture) : verifyBootstrapStep;
  const journal = new Journal(options.path, plan, fixture ? 'local-fixture' : 'public', genesisHash);
  let busy = false, closed = false;
  const exclusive = async (fn) => { check(!closed && !busy, 'BOOTSTRAP_IN_FLIGHT', 'Runner is closed or another operation is in flight'); busy = true; try { return await fn(); } finally { busy = false; } };
  const identity = async () => {
    check(integer(await reader.send('eth_chainId', [])) === 11155111n, 'BOOTSTRAP_CHAIN', 'Wrong bootstrap network');
    const genesis = await reader.send('eth_getBlockByNumber', ['0x0', false]);
    check(genesis?.hash?.toLowerCase() === genesisHash && integer(genesis.number) === 0n, 'BOOTSTRAP_CHAIN', 'Bootstrap genesis changed');
  };
  const reconcile = async () => {
    await identity(); const rows = journal.read(); const proofs = [];
    for (const row of rows) {
      if (row.state === 'pending') break;
      check(row.transactionHash, 'BOOTSTRAP_UNKNOWN', 'An interrupted signing intent has no known hash; do not sign, replace, reset or resume it');
      const proof = await verifier({ plan, index: row.index, transactionHash: row.transactionHash, reader,
        ...(row.proof ? { finalizedAnchor: row.proof.finalized } : recovery && row.index < 2 ? { finalizedAnchor: recovery.adopted[row.index].finalizedAnchor } : {}) });
      if (recovery && row.index < 2) check(row.transactionHash === recovery.adopted[row.index].transactionHash && proof.feeWei === recovery.adopted[row.index].feeWei, 'BOOTSTRAP_RECOVERY_PROOF', 'Adoption differs from approved original receipt');
      check(proof.planHash === plan.planHash && proof.index === row.index && proof.transactionHash === row.transactionHash && same(proof.transaction, row.intent), 'BOOTSTRAP_PROOF', 'Verifier did not bind the original step');
      if (row.proof) check(proof.blockHash === row.proof.blockHash && proof.blockNumber === row.proof.blockNumber && proof.feeWei === row.proof.feeWei && proof.success === row.proof.success,
        'BOOTSTRAP_REORG', 'Previously accounted finalized evidence changed; retain the original authority');
      else journal.change(row.index, ['signed', 'submitted', 'unknown'], { state: proof.success ? 'finalized' : 'failed', proof });
      proofs.push(proof);
      check(proof.success, 'BOOTSTRAP_REVERTED', 'Original bootstrap transaction reverted; no replacement or later step is authorized');
    }
    return { complete: journal.read().every((row) => row.state === 'finalized'), proofs, steps: journal.read() };
  };
  const advance = async () => {
    const status = await reconcile(); if (status.complete) return status;
    const index = status.steps.findIndex((row) => row.state === 'pending');
    if (recovery) { assertRecoveryTime(); check(index >= 2, 'BOOTSTRAP_ADOPTION_REQUIRED', 'Both existing transactions must be verified; never re-sign or resend them'); }
    check(index >= 0, 'BOOTSTRAP_UNKNOWN', 'Unresolved original intent blocks all new steps');
    if (recovery) assertRecoveryTime();
    check(Math.floor(Date.now() / 1000) <= permission.expiresAt, 'BOOTSTRAP_AUTHORIZATION_EXPIRED', 'Authorization expired; read-only reconciliation remains available');
    check(signer, 'BOOTSTRAP_SIGNER', 'An explicitly provisioned opaque operator signer is required');
    check(getAddress(await signer.getAddress()).toLowerCase() === plan.roles.operator, 'BOOTSTRAP_SIGNER', 'Signer does not match the exact operator role');
    const intent = plan.transactions[index].transaction;
    const preflight = async () => {
      await identity();
      check(await reader.send('eth_getCode', [plan.roles.operator, 'latest']) === '0x', 'BOOTSTRAP_OPERATOR', 'Operator must be an undelegated EOA');
      const [pending, latest] = await Promise.all(['pending', 'latest'].map((tag) => reader.send('eth_getTransactionCount', [plan.roles.operator, tag])));
      check(integer(pending) === BigInt(intent.nonce) && integer(latest) === BigInt(intent.nonce), 'BOOTSTRAP_NONCE', 'Operator nonce changed or another transaction is pending');
      const head = await reader.send('eth_getBlockByNumber', ['latest', false]);
      check(integer(head.baseFeePerGas) <= BigInt(intent.maxFeePerGas), 'BOOTSTRAP_BASE_FEE', 'Current base fee exceeds the fixed signed ceiling; never increase it automatically');
      const remaining = plan.transactions.slice(index).reduce((sum, { transaction: tx }) => sum + BigInt(tx.gasLimit) * BigInt(tx.maxFeePerGas) + BigInt(tx.value), 0n);
      check(integer(await reader.send('eth_getBalance', [plan.roles.operator, 'latest'])) >= remaining, 'BOOTSTRAP_BALANCE', 'Operator cannot cover all remaining signed ceilings and the fixed allocation');
      if (index === 4) check(await reader.send('eth_getCode', [plan.roles.payer, 'latest']) === '0x', 'BOOTSTRAP_PAYER', 'Controlled payer has code or delegation');
    };
    await preflight();
    await estimate(plan, index, reader, genesisHash);
    journal.change(index, ['pending'], { state: 'intent' });
    let hash = null;
    try {
      await fixture?.hooks?.afterIntent?.(index);
      if (recovery) assertRecoveryTime();
    check(Math.floor(Date.now() / 1000) <= permission.expiresAt, 'BOOTSTRAP_AUTHORIZATION_EXPIRED', 'Authorization expired before custody; do not sign');
      journal.read();
      const raw = await signer.signTransaction(unsigned(intent));
      check(typeof raw === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(raw) && raw.length <= 262144, 'BOOTSTRAP_SIGNATURE', 'Signer did not return bounded serialized transaction bytes');
      const signed = Transaction.from(raw);
      check(signed.type === 2 && signed.from?.toLowerCase() === plan.roles.operator && signed.unsignedSerialized === transactionEncoding(intent)
        && signed.hash && signed.serialized.toLowerCase() === raw.toLowerCase(), 'BOOTSTRAP_SIGNATURE', 'Signer changed the exact nonce, source, destination, value or fee limits');
      hash = signed.hash;
      journal.change(index, ['intent'], { state: 'signed', transactionHash: hash });
      await fixture?.hooks?.afterSigned?.(index, hash);
      await preflight();
      await estimate(plan, index, reader, genesisHash);
      if (recovery) assertRecoveryTime();
    check(Math.floor(Date.now() / 1000) <= permission.expiresAt, 'BOOTSTRAP_AUTHORIZATION_EXPIRED', 'Authorization expired before submission; do not re-sign');
      journal.change(index, ['signed'], { state: 'submitted' });
      await fixture?.hooks?.beforeBroadcast?.(index, hash);
      if (recovery) assertRecoveryTime();
    check(Math.floor(Date.now() / 1000) <= permission.expiresAt, 'BOOTSTRAP_AUTHORIZATION_EXPIRED', 'Authorization expired immediately before submission; do not resubmit');
      journal.read();
      const returned = await bootstrapRpc(reader.endpoint, 'eth_sendRawTransaction', [raw]);
      check(returned === hash, 'BOOTSTRAP_BROADCAST_UNKNOWN', 'RPC returned a different transaction hash; reconcile only the original signed hash');
      await fixture?.hooks?.afterBroadcast?.(index, hash);
      return await reconcile();
    } catch (cause) {
      try { const row = journal.read()[index]; if (!['finalized', 'failed'].includes(row.state)) journal.change(index, ['intent', 'signed', 'submitted', 'unknown'], { state: 'unknown' }); } catch {}
      const error = cause instanceof Error ? cause : new BootstrapError('BOOTSTRAP_UNKNOWN', 'Custody or submission failed with an unsupported error; reconcile only');
      error.doNotResubmit = true; error.transactionHash = hash; throw error;
    }
  };
  const adoptNext = async () => {
    check(recovery, 'BOOTSTRAP_RECOVERY_DISABLED', 'Only the explicit R1 runner can adopt');
    assertRecoveryTime();
    const status = await reconcile();
    const index = status.steps.findIndex(row => row.state === 'pending');
    check(index === 0 || index === 1, 'BOOTSTRAP_ADOPTION_COMPLETE', 'Only the two approved hashes may be adopted');
    const adopted = recovery.adopted[index];
    // Atomically retain the known hash before any fallible evidence query. A
    // failed query can only be reconciled read-only; advance cannot re-sign it.
    assertRecoveryTime();
    journal.change(index, ['pending'], { state: 'submitted', transactionHash: adopted.transactionHash });
    await fixture?.hooks?.afterAdoptionIntent?.(index);
    const result = await reconcile();
    await fixture?.hooks?.afterAdoptionFinalized?.(index);
    return result;
  };
  try { await identity(); } catch (error) { journal.close(); throw error; }
  return Object.freeze({ plan, authorization: permission, advance: () => exclusive(advance), reconcile: () => exclusive(reconcile),
    ...(recovery ? { adoptNext: () => exclusive(adoptNext) } : {}),
    status: () => ({ binding: clone(journal.binding), steps: journal.read() }),
    close() { if (closed) return; closed = true; journal.close(); } });
}
/** Requires explicit reviewed authorization. Never generates keys or defaults it on. */
export function createBootstrapRunner(options) { return open(options, null); }
/** Explicit loopback-only test seam; cannot open a public-mode journal. */
export function createLoopbackBootstrapRunner({ ack, genesisHash, reader, hooks, ...options }) {
  fixtureCheck(ack, genesisHash); let url; try { url = new URL(reader?.endpoint); } catch { throw new BootstrapError('BOOTSTRAP_FIXTURE', 'Loopback RPC endpoint required'); }
  check(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) && !url.username && !url.password
    && (url.pathname === '/' || url.pathname === '') && !url.search && !url.hash && typeof reader.send === 'function', 'BOOTSTRAP_FIXTURE', 'Only an explicit HTTP loopback EVM reader may be injected');
  return open(options, { reader, genesisHash, hooks });
}

/** R1-only recovery: fixed original receipts, original verifier, no old sends. */
export function createRecoveryBootstrapRunner(options) { return open(options, null, R1); }
/** Public local-chain fixture seam, unavailable to public-mode journals. */
export function createLoopbackRecoveryBootstrapRunner({ ack, genesisHash, reader, hooks, recovery, ...options }) {
  fixtureCheck(ack, genesisHash);
  check(process.env.NODE_TEST_CONTEXT && recovery && recovery.adopted?.length === 2, 'BOOTSTRAP_FIXTURE', 'Explicit test-only recovery fixture required');
  const u = new URL(reader?.endpoint);
  check(u.protocol === 'http:' && ['127.0.0.1','[::1]','localhost'].includes(u.hostname) && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash, 'BOOTSTRAP_FIXTURE', 'Loopback only');
  return open(options, {reader,genesisHash,hooks}, structuredClone(recovery));
}
