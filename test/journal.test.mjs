import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, chmodSync, writeFileSync, existsSync, renameSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Interface } from 'ethers';
import { SQLiteBudgetJournal } from '../src/journal.mjs';
import { canonicalStringify } from '../src/json.mjs';

// Journal unit proofs represent already-verified public chain evidence. Actual
// local EVM verification and crash/process integration live in durable-client.test.
const addr = (digit) => `0x${digit.repeat(40)}`;
const hash = (digit) => `0x${digit.repeat(64)}`;
const sig = `0x${'11'.repeat(65)}`;
const policy = { enabled: true, chainId: 31337, payer: addr('1'), token: addr('2'), router: addr('3'), recipient: addr('4'), quoteSigner: addr('5'), serviceOrigin: 'http://127.0.0.1:8787', maxSingleSpend: '100', maxTotalSpend: '150', maxGasPerTransactionWei: '1000', maxGasTotalWei: '10000' };
const chainIdentity = { chainId: 31337, genesisHash: hash('a'), quoteSigner: addr('5'), tokenCodeHash: hash('b'), routerCodeHash: hash('c') };
const approvalAbi = new Interface(['function approve(address,uint256) returns (bool)']);
const paymentAbi = new Interface(['function pay((bytes32 quoteId,bytes32 requestHash,address payer,uint256 amount,uint256 deadline),bytes)']);
function offer(digit = '1', amount = '100') {
  return { protocol: 'mote-local-v1', quote: { quoteId: hash(digit), requestHash: hash('d'), payer: policy.payer, amount, deadline: '9999999999' }, domain: { name: 'MotePayments', version: '1', chainId: 31337, verifyingContract: policy.router }, signature: sig, offerSignature: sig, chainId: 31337, token: policy.token, router: policy.router, recipient: policy.recipient, quoteSigner: policy.quoteSigner, decimals: 6, asset: 'MOTE', service: 'json.audit', resultHash: hash('e'), expiresAt: '2286-11-20T17:46:39.000Z', inputBytes: 1, localOnly: true };
}
function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mote-journal-test-'));
  const options = { path: join(directory, 'authority.sqlite'), policyId: 'test-policy-v2', policy, chainIdentity, ...overrides };
  const journal = SQLiteBudgetJournal.initialize(options);
  t.after(() => { try { journal.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  return { journal, options, directory };
}
function tx(step, currentOffer = offer(), nonce = step === 'approval' ? '0' : '1') {
  return { nonce, to: step === 'approval' ? policy.token : policy.router, from: policy.payer, data: step === 'approval' ? approvalAbi.encodeFunctionData('approve', [policy.router, currentOffer.quote.amount]) : paymentAbi.encodeFunctionData('pay', [currentOffer.quote, currentOffer.signature]), gasLimit: '10', gasPrice: '10', chainId: '31337', value: '0' };
}
function receipt(step, success = true, currentOffer = offer()) {
  return { transactionHash: hash(step === 'approval' ? '6' : '7'), feeWei: '50', success, blockNumber: step === 'approval' ? 1 : 2, blockHash: hash('f'), transaction: tx(step, currentOffer) };
}
function approve(journal, currentOffer = offer()) {
  const id = currentOffer.quote.quoteId;
  journal.beginIntent(id, 'reserved', 'approval', tx('approval', currentOffer));
  journal.markSubmitted(id, 'approval', receipt('approval').transactionHash);
  return journal.recordApproval(id, receipt('approval', true, currentOffer));
}
function settle(journal, currentOffer = offer()) {
  const id = currentOffer.quote.quoteId;
  journal.reserve(currentOffer, 'test-order-0001'); approve(journal, currentOffer);
  journal.beginIntent(id, 'approved', 'payment', tx('payment', currentOffer));
  journal.markSubmitted(id, 'payment', receipt('payment').transactionHash);
  journal.recordPayment(id, receipt('payment', true, currentOffer));
}

test('explicit initialization pins full policy and chain identity; opening never creates or resets authority', (t) => {
  const { journal, options, directory } = fixture(t);
  assert.throws(() => SQLiteBudgetJournal.initialize(options), { code: 'JOURNAL_EXISTS' });
  for (const changed of [
    { ...options, policyId: 'other-policy-v2' },
    { ...options, policy: { ...policy, maxTotalSpend: '151' } },
    { ...options, chainIdentity: { ...chainIdentity, genesisHash: hash('9') } },
  ]) assert.throws(() => new SQLiteBudgetJournal(changed), { code: 'JOURNAL_IDENTITY_MISMATCH' });
  const missing = join(directory, 'missing.sqlite');
  assert.throws(() => new SQLiteBudgetJournal({ ...options, path: missing }), { code: 'JOURNAL_MISSING' });
  assert.equal(existsSync(missing), false);
  const empty = join(directory, 'empty.sqlite'); writeFileSync(empty, '');
  assert.throws(() => new SQLiteBudgetJournal({ ...options, path: empty }), { code: 'JOURNAL_CORRUPT' });
  assert.deepEqual(journal.budget(), { tokenReserved: '0', tokenSpent: '0', gasReservedWei: '0', gasSpentWei: '0' });
});

test('policy, offer and unsigned intent reject unknown fields and unbounded approval calldata', (t) => {
  const { journal, options, directory } = fixture(t);
  const path = join(directory, 'secret.sqlite');
  assert.throws(() => SQLiteBudgetJournal.initialize({ ...options, path, policy: { ...policy, privateKey: 'not-a-real-key' } }), { code: 'JOURNAL_INVALID_INPUT' });
  assert.equal(existsSync(path), false);
  assert.throws(() => journal.reserve({ ...offer(), privateKey: 'not-a-real-key' }, 'test-order-0001'), { code: 'JOURNAL_INVALID_INPUT' });
  const { row } = journal.reserve(offer(), 'test-order-0001');
  assert.throws(() => journal.beginIntent(row.quoteId, 'reserved', 'approval', { ...tx('approval'), privateKey: 'not-a-real-key' }), { code: 'JOURNAL_INVALID_INPUT' });
  const unlimited = { ...tx('approval'), data: approvalAbi.encodeFunctionData('approve', [policy.router, (1n << 256n) - 1n]) };
  assert.throws(() => journal.beginIntent(row.quoteId, 'reserved', 'approval', unlimited), { code: 'JOURNAL_INVALID_INPUT' });
  assert.equal(journal.read(row.quoteId).phase, 'reserved');
});

test('shared reservations enforce totals, preserve ownership, and retain cancelled tombstones', (t) => {
  const { journal, options } = fixture(t); const other = new SQLiteBudgetJournal(options); t.after(() => other.close());
  const first = journal.reserve(offer(), 'test-order-0001');
  assert.equal(first.created, true);
  assert.throws(() => other.reserve(offer('2'), 'test-order-0002'), { code: 'TOTAL_LIMIT' });
  assert.equal(other.reserve(offer(), 'test-order-0001').created, false);
  assert.throws(() => other.beginIntent(first.row.quoteId, 'reserved', 'approval', tx('approval')), { code: 'JOURNAL_OWNER_MISMATCH' });
  other.cancelReserved(first.row.quoteId);
  assert.throws(() => journal.beginIntent(first.row.quoteId, 'reserved', 'approval', tx('approval')), { code: 'JOURNAL_PHASE_CONFLICT' });
  assert.equal(journal.reserve(offer(), 'test-order-0001').created, false);
  assert.equal(journal.read(first.row.quoteId).phase, 'cancelled');
  assert.equal(other.reserve(offer('2'), 'test-order-0002').created, true);
});

test('separate processes cannot reserve more than one shared budget under a simultaneous start', async (t) => {
  const { journal, options } = fixture(t); journal.close();
  const moduleUrl = new URL('../src/journal.mjs', import.meta.url).href;
  const worker = `import {SQLiteBudgetJournal} from ${JSON.stringify(moduleUrl)}; process.stdin.once('data',()=>{ let j; try { j=new SQLiteBudgetJournal(JSON.parse(process.argv[1])); const r=j.reserve(JSON.parse(process.argv[2]),process.argv[3]); process.stdout.write(JSON.stringify({created:r.created})); } catch(e) { process.stdout.write(JSON.stringify({code:e.code})); } finally {j?.close();} });`;
  const launch = (number) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker, JSON.stringify(options), JSON.stringify(offer(String(number))), `process-order-000${number}`], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', (data) => { output += data; });
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(output))); });
    return { child, done };
  };
  const children = [launch(1), launch(2)]; for (const { child } of children) child.stdin.end('go');
  const results = await Promise.all(children.map(({ done }) => done));
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.ok(results.filter((result) => !result.created).every((result) => ['TOTAL_LIMIT', 'JOURNAL_UNAVAILABLE'].includes(result.code)));
  const reopened = new SQLiteBudgetJournal(options); t.after(() => reopened.close());
  assert.equal(reopened.budget().tokenReserved, '100');
  assert.equal(reopened.list().length, 1);
});

test('exact original intent and receipt accounting survive restart without charging twice', (t) => {
  const { journal, options } = fixture(t);
  journal.reserve(offer(), 'test-order-0001'); approve(journal);
  assert.throws(() => journal.beginIntent(hash('1'), 'approved', 'payment', tx('payment', offer(), '2')), { code: 'JOURNAL_INVALID_INPUT' });
  assert.throws(() => journal.beginIntent(hash('1'), 'approved', 'payment', tx('payment', offer('2'))), { code: 'JOURNAL_INVALID_INPUT' });
  journal.beginIntent(hash('1'), 'approved', 'payment', tx('payment'));
  journal.markSubmitted(hash('1'), 'payment', hash('7'));
  const expected = journal.recordPayment(hash('1'), receipt('payment'));
  assert.equal(expected.phase, 'settled');
  journal.recordPayment(hash('1'), receipt('payment'));
  journal.close();
  const reopened = new SQLiteBudgetJournal(options); t.after(() => reopened.close());
  assert.deepEqual(reopened.budget(), { tokenReserved: '0', tokenSpent: '100', gasReservedWei: '0', gasSpentWei: '100' });
  assert.equal(reopened.reserve(offer(), 'test-order-0001').created, false);
  assert.throws(() => reopened.reserve(offer('2', '60'), 'test-order-0002'), { code: 'TOTAL_LIMIT' });
});

test('crashed unrecorded submission keeps authority reserved and cannot be resumed by another process', (t) => {
  const { journal, options } = fixture(t, { policy: { ...policy, maxTotalSpend: '300' } });
  journal.reserve(offer(), 'test-order-0001');
  journal.beginIntent(hash('1'), 'reserved', 'approval', tx('approval'));
  journal.close();
  const reopened = new SQLiteBudgetJournal(options); t.after(() => reopened.close());
  assert.throws(() => reopened.markSubmitted(hash('1'), 'approval', hash('6')), { code: 'JOURNAL_OWNER_MISMATCH' });
  assert.throws(() => reopened.cancelReserved(hash('1')), { code: 'JOURNAL_PHASE_CONFLICT' });
  assert.throws(() => reopened.recordApproval(hash('1'), receipt('approval')), { code: 'TRANSACTION_CONFLICT' });
  assert.throws(() => reopened.reserve(offer('2'), 'test-order-0002'), { code: 'WALLET_BUSY' });
  assert.deepEqual(reopened.budget(), { tokenReserved: '100', tokenSpent: '0', gasReservedWei: '2000', gasSpentWei: '0' });
});

test('observed payment accounts once but cannot release an unknown original fee or wallet gate', (t) => {
  const { journal, options } = fixture(t, { policy: { ...policy, maxTotalSpend: '300' } });
  journal.reserve(offer(), 'test-order-0001'); approve(journal);
  journal.beginIntent(hash('1'), 'approved', 'payment', tx('payment'));
  journal.markUnknown(hash('1'), 'payment');
  const evidence = { ...receipt('payment'), quoteId: hash('1'), requestHash: hash('d'), payer: policy.payer, amount: '100' };
  journal.recordObservedPayment(hash('1'), evidence); journal.recordObservedPayment(hash('1'), evidence);
  assert.deepEqual(journal.budget(), { tokenReserved: '0', tokenSpent: '100', gasReservedWei: '1000', gasSpentWei: '100' });
  const other = new SQLiteBudgetJournal(options); t.after(() => other.close());
  assert.throws(() => other.reserve(offer('2'), 'test-order-0002'), { code: 'WALLET_BUSY' });
  assert.throws(() => other.recordPayment(hash('1'), receipt('payment')), { code: 'TRANSACTION_CONFLICT' });
  // If the original live sender later receives and durably records its hash,
  // exact recovery can resolve it without duplicating observed fee accounting.
  journal.markSubmitted(hash('1'), 'payment', hash('7'));
  other.recordPayment(hash('1'), receipt('payment'));
  assert.deepEqual(other.budget(), { tokenReserved: '0', tokenSpent: '100', gasReservedWei: '0', gasSpentWei: '100' });
});

test('read-only, deleted, replaced and locked journals fail closed without fallback', (t) => {
  const { journal, options, directory } = fixture(t);
  chmodSync(options.path, 0o400);
  assert.throws(() => journal.reserve(offer(), 'test-order-0001'), { code: 'JOURNAL_UNAVAILABLE' });
  chmodSync(options.path, 0o600);
  const locker = new DatabaseSync(options.path); locker.exec('BEGIN IMMEDIATE');
  assert.throws(() => journal.budget(), { code: 'JOURNAL_UNAVAILABLE' });
  locker.exec('ROLLBACK'); locker.close();
  renameSync(options.path, join(directory, 'old.sqlite'));
  writeFileSync(options.path, 'not a journal');
  assert.throws(() => journal.budget(), { code: 'JOURNAL_FILE_CHANGED' });
  rmSync(options.path);
  assert.throws(() => journal.budget(), { code: 'JOURNAL_MISSING' });
  assert.equal(existsSync(options.path), false);
});

test('valid SQLite corruption cannot erase an active reservation even with a recomputed row checksum', (t) => {
  const { journal, options } = fixture(t);
  journal.reserve(offer(), 'test-order-0001'); journal.close();
  const db = new DatabaseSync(options.path);
  const row = JSON.parse(db.prepare('SELECT data FROM entries').get().data); row.tokenReserved = '0';
  const serialized = canonicalStringify(row);
  const checksum = createHash('sha256').update(serialized).digest('hex');
  db.prepare('UPDATE entries SET data=?,data_hash=?').run(serialized, checksum); db.close();
  assert.throws(() => new SQLiteBudgetJournal(options), { code: 'JOURNAL_CORRUPT' });
});

test('active handle detects an in-place corrupted SQLite header before authorizing a send', (t) => {
  const { journal, options } = fixture(t);
  journal.reserve(offer(), 'test-order-0001');
  writeFileSync(options.path, 'not a SQLite authority database');
  assert.throws(() => journal.beginIntent(hash('1'), 'reserved', 'approval', tx('approval')), { code: 'JOURNAL_CORRUPT' });
});

test('hard-linked journal aliases cannot split wallet authority into separate WAL paths', (t) => {
  const { journal, options, directory } = fixture(t);
  const alias = join(directory, 'alias.sqlite'); linkSync(options.path, alias);
  assert.throws(() => journal.reserve(offer(), 'test-order-0001'), { code: 'JOURNAL_UNAVAILABLE' });
  assert.throws(() => new SQLiteBudgetJournal({ ...options, path: alias }), { code: 'JOURNAL_UNAVAILABLE' });
  rmSync(alias);
  assert.equal(journal.reserve(offer(), 'test-order-0001').created, true);
});

test('missing fee accounting is corruption rather than silently freed native budget', (t) => {
  const { journal, options } = fixture(t); settle(journal); journal.close();
  const db = new DatabaseSync(options.path); db.prepare('DELETE FROM fees WHERE step=?').run('approval'); db.close();
  assert.throws(() => new SQLiteBudgetJournal(options), { code: 'JOURNAL_CORRUPT' });
});

test('changed receipt evidence cannot overwrite monotonic spending or replace an original hash', (t) => {
  const { journal } = fixture(t); settle(journal);
  assert.throws(() => journal.recordPayment(hash('1'), { ...receipt('payment'), feeWei: '1' }), { code: 'JOURNAL_PROOF_MISMATCH' });
  assert.throws(() => journal.markSubmitted(hash('1'), 'payment', hash('8')), { code: 'TRANSACTION_CONFLICT' });
  assert.deepEqual(journal.budget(), { tokenReserved: '0', tokenSpent: '100', gasReservedWei: '0', gasSpentWei: '100' });
});
