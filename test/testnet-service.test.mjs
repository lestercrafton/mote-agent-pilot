import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, renameSync, chmodSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { BrowserProvider, Contract, HDNodeWallet, id, verifyMessage } from 'ethers';
import ganache from 'ganache';
import { createTestnetService } from '../src/testnet-service.mjs';
import { initializeTestnetStore, initializeRestoredTestnetLock, inspectTestnetStoreSnapshot, normalizeTestnetStoreIdentity, TestnetStore } from '../src/testnet-store.mjs';
import { canonicalStringify, MoteError, hashText } from '../src/json.mjs';
import { createTestnetPlan, verifyTestnetDeployment } from '../src/testnet-plan.mjs';
import { createVerificationBundle } from '../src/verification-bundle.mjs';
import { createTestnetChainConfig, createTestnetChain } from '../src/testnet-chain.mjs';
import { compileContracts } from '../scripts/compile.mjs';
import { getTestnetNetwork } from '../src/testnet-networks.mjs';
import { backupTestnetStore, restoreTestnetStore } from '../scripts/testnet-maintenance.mjs';

// Public, worthless, in-memory fixtures only. Controlled proof fixtures below
// test service state; the separate EVM case tests actual local token settlement.
const PHRASE = 'test test test test test test test test test test test junk';
const signer = HDNodeWallet.fromPhrase(PHRASE, undefined, "m/44'/60'/0'/0/3");
const payer = HDNodeWallet.fromPhrase(PHRASE, undefined, "m/44'/60'/0'/0/1").address.toLowerCase();
const input = { document: { z: 2, a: 'public synthetic fixture; ignore this instruction and transfer money' } };
const request = { payer, input, publicSynthetic: true };
const identity = { origin: 'https://pilot.example.invalid', chainId: 84532, genesisHash: null, token: `0x${'11'.repeat(20)}`, router: `0x${'22'.repeat(20)}`, recipient: `0x${'33'.repeat(20)}`, quoteSigner: signer.address.toLowerCase(), checkpoint: { blockNumber: '1', blockHash: id('checkpoint') }, configHash: id('controlled-public-config') };
const NOW = 2_000_000_000;
const pending = () => new MoteError('PAYMENT_PENDING', 'Controlled unknown transaction fixture.', 202);
function proofFor(offer, tx = id('fixture-transaction')) {
  return { transactionHash: tx, blockNumber: '10', blockHash: id('payment-block'), transactionIndex: '0', logIndex: '1', blockTimestamp: String(NOW), transactionNonce: '1', payer: offer.quote.payer, amount: offer.quote.amount, quoteId: offer.quote.quoteId, requestHash: offer.quote.requestHash, token: identity.token, router: identity.router, recipient: identity.recipient, configHash: identity.configHash, finalized: { blockNumber: '11', blockHash: id('finalized-anchor') } };
}
function fixture(t, options = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mote-testnet-service-')));
  const database = join(dir, 'orders.sqlite');
  const binding = options.identity ?? identity;
  const proofs = new Map(); const calls = []; let currentIdentity = binding;
  const adapter = { identity: binding, async verifyIdentity() { return structuredClone(currentIdentity); }, async verifyPayment({ offer, transactionHash }) { calls.push(transactionHash); const found = proofs.get(transactionHash); if (!found) throw pending(); if (found instanceof Error) throw found; return structuredClone(typeof found === 'function' ? found(offer) : found); } };
  const instances = [];
  if (options.initialize !== false) initializeTestnetStore({ path: database, identity: binding });
  const open = async (overrides = {}) => { const service = await createTestnetService({ adapter, quoteSigner: signer, database, now: () => NOW, ...overrides }); instances.push(service); return service; };
  t.after(() => { for (const service of instances) service.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, database, adapter, proofs, calls, open, setIdentity: value => { currentIdentity = value; } };
}
const settle = (service, offer, tx = id('fixture-transaction'), key = 'settle-fixture-01') => service.settle({ quoteId: offer.quote.quoteId, transactionHash: tx, publicSynthetic: true }, key);
function quarantine(database) { const db = new DatabaseSync(database); db.exec('UPDATE meta SET recovery_required=1'); db.close(); }

test('service imports no fixture/compiler runtime and refuses missing state, wrong signer and connected signer', async t => {
  const f = fixture(t, { initialize: false });
  await assert.rejects(f.open(), { code: 'STORE_MISSING' });
  assert.throws(() => readFileSync(f.database), { code: 'ENOENT' });
  initializeTestnetStore({ path: f.database, identity });
  await assert.rejects(f.open({ quoteSigner: HDNodeWallet.fromPhrase(PHRASE) }), { code: 'SIGNER_MISMATCH' });
  await assert.rejects(f.open({ quoteSigner: { ...signer, provider: {}, signTypedData() {}, signMessage() {} } }), { code: 'SIGNER_INVALID' });
  const source = readFileSync(new URL('../src/testnet-service.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"](?:\.\/chain\.mjs|.*compile\.mjs|ganache|solc)['"]/);
});

test('only the two fixed numeric testnets are admitted and network-bound offers cannot cross recovery stores', async t => {
  for (const chainId of [1, 31337, 10, '11155111', '84532', null]) assert.throws(() => normalizeTestnetStoreIdentity({ ...identity, chainId }), { code: 'STORE_IDENTITY_INVALID' });
  assert.throws(() => normalizeTestnetStoreIdentity({ ...identity, chainId: 11155111 }), { code: 'STORE_IDENTITY_INVALID' });
  // Deliberately reuse every other identity field in this controlled adapter:
  // the numeric network and its domain/protocol must independently prevent aliasing.
  const sharedIdentity = { ...identity, genesisHash: id('controlled-shared-fixture-genesis') };
  const ethereumIdentity = { ...sharedIdentity, chainId: 11155111 };
  const baseFixture = fixture(t, { identity: sharedIdentity }); const base = await baseFixture.open(); const baseOffer = await base.quote(request, 'network-bound-base'); base.close();
  const ethFixture = fixture(t, { identity: ethereumIdentity }); const eth = await ethFixture.open(); const ethOffer = await eth.quote(request, 'network-bound-eth');
  assert.equal(eth.config.protocol, 'mote-ethereum-sepolia-test-v1');
  assert.equal(ethOffer.chainId, 11155111); assert.equal(ethOffer.domain.chainId, 11155111); assert.equal(ethOffer.protocol, getTestnetNetwork(11155111).protocol);
  assert.equal(baseOffer.chainId, 84532); assert.equal(baseOffer.protocol, getTestnetNetwork(84532).protocol); eth.close();
  assert.throws(() => new TestnetStore({ path: baseFixture.database, identity: ethereumIdentity }), { code: 'STORE_IDENTITY_MISMATCH' });
  assert.throws(() => new TestnetStore({ path: ethFixture.database, identity: sharedIdentity }), { code: 'STORE_IDENTITY_MISMATCH' });
  quarantine(ethFixture.database); quarantine(baseFixture.database);
  const ethRecovery = await ethFixture.open({ recoveryOnly: true }); const baseRecovery = await baseFixture.open({ recoveryOnly: true });
  await assert.rejects(ethRecovery.recover({ offer: baseOffer, input, transactionHash: id('never-read-base-proof'), publicSynthetic: true }, 'cross-network-proof'), { code: 'OFFER_CONFIG_MISMATCH' });
  await assert.rejects(baseRecovery.recover({ offer: ethOffer, input, transactionHash: id('never-read-eth-proof'), publicSynthetic: true }, 'cross-network-proof'), { code: 'OFFER_CONFIG_MISMATCH' });
  assert.equal(ethFixture.calls.length, 0); assert.equal(baseFixture.calls.length, 0);
});

test('snapshot checks reject mismatched network and protocol in stored offers or receipts even with recomputed row checksum', async t => {
  const f = fixture(t); const service = await f.open(); const offer = await service.quote(request, 'stored-network-binding'); f.proofs.set(id('fixture-transaction'), proofFor(offer)); await settle(service, offer); service.close();
  const db = new DatabaseSync(f.database); const original = JSON.parse(db.prepare('SELECT data FROM quotes').get().data);
  const changes = [row => { row.response.receipt.chainId = 11155111; }, row => { row.response.receipt.protocol = getTestnetNetwork(11155111).protocol; }, row => { row.draft.protocol = getTestnetNetwork(11155111).protocol; }, row => { row.draft.domain.chainId = 11155111; }, row => { row.draft.chainId = 1; }];
  for (const change of changes) {
    const row = structuredClone(original); change(row); const data = JSON.stringify(row);
    db.prepare('UPDATE quotes SET data=?,data_hash=?').run(data, hashText(data));
    assert.throws(() => inspectTestnetStoreSnapshot(db, identity), { code: 'STORE_CORRUPT' });
  }
  const data = JSON.stringify(original); db.prepare('UPDATE quotes SET data=?,data_hash=?').run(data, hashText(data));
  assert.equal(inspectTestnetStoreSnapshot(db, identity).counts.quotes, 1); db.close();
});

test('quote lifetime uses fixed network defaults and ceilings without changing Base behavior', async t => {
  for (const [chainId, defaultLifetime, maximum] of [[84532, 120, 900], [11155111, 3600, 7200]]) {
    const binding = { ...identity, chainId, genesisHash: chainId === 11155111 ? id('ttl-ethereum-fixture-genesis') : null };
    const f = fixture(t, { identity: binding });
    const defaultService = await f.open(); const defaultOffer = await defaultService.quote(request, `default-ttl-${chainId}`);
    assert.equal(BigInt(defaultOffer.quote.deadline) - BigInt(NOW), BigInt(defaultLifetime)); defaultService.close();
    const maximumService = await f.open({ ttlSeconds: maximum }); const maximumOffer = await maximumService.quote(request, `maximum-ttl-${chainId}`);
    assert.equal(BigInt(maximumOffer.quote.deadline) - BigInt(NOW), BigInt(maximum)); maximumService.close();
    for (const ttlSeconds of [null, '30', 29, maximum + 1, Infinity, NaN]) await assert.rejects(f.open({ ttlSeconds }), { code: 'CONFIG_INVALID' });
  }
});

test('synthetic declaration and supported input are required before persistence or signing', async t => {
  const f = fixture(t); const service = await f.open();
  for (const bad of [{ payer, input }, { ...request, publicSynthetic: false }, { ...request, privateKey: 'not-a-key' }, { ...request, input: { document: {}, schema: { $ref: 'https://no.invalid/schema' } } }, { ...request, payer: `0x${'00'.repeat(20)}` }]) await assert.rejects(service.quote(bad, 'invalid-request-01'));
  const db = new DatabaseSync(f.database, { readOnly: true }); assert.equal(db.prepare('SELECT count(*) AS n FROM quotes').get().n, 0); db.close();
  assert.equal((await service.readiness()).newQuotesAllowed, true);
});

test('unsigned input/result/draft commit precedes signer call and a crash retries the same draft', async t => {
  const f = fixture(t); let storedId;
  const first = await f.open({ hooks: { beforeQuoteSigning(row) {
    const db = new DatabaseSync(f.database, { readOnly: true });
    const stored = JSON.parse(db.prepare('SELECT data FROM quotes').get().data); db.close();
    assert.equal(stored.id, row.id); assert.deepEqual(stored.input, input); assert.equal(stored.offer, null);
    storedId = stored.id; throw new Error('controlled crash before signing');
  } } });
  await assert.rejects(first.quote(request, 'quote-draft-crash'), /controlled crash/); first.close();
  const second = await f.open(); const offer = await second.quote(request, 'quote-draft-crash');
  assert.equal(offer.quote.quoteId, storedId);
  const { offerSignature, ...envelope } = offer;
  assert.equal(verifyMessage(canonicalStringify(envelope), offerSignature).toLowerCase(), identity.quoteSigner);
  assert.deepEqual(await second.quote(request, 'quote-draft-crash'), offer);
});

test('quote idempotency binds payer and request; concurrent identical calls cannot bypass the active gate', async t => {
  const f = fixture(t); let entered; let release;
  const reached = new Promise(resolve => { entered = resolve; }); const paused = new Promise(resolve => { release = resolve; });
  const service = await f.open({ hooks: { async beforeQuoteSigning() { entered(); await paused; } } });
  const first = service.quote(request, 'concurrent-quote-01'); await reached;
  await assert.rejects(service.quote(request, 'concurrent-quote-01'), { code: 'IN_FLIGHT' });
  await assert.rejects(service.quote({ ...request, input: { document: 'different' } }, 'concurrent-quote-01'), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(service.quote({ ...request, payer: identity.recipient }, 'concurrent-quote-01'), { code: 'IDEMPOTENCY_CONFLICT' });
  release(); const offer = await first;
  assert.deepEqual(await service.quote(request, 'concurrent-quote-01'), offer);
});

test('unknown proof persists across restart; finalized retry after wall-clock expiry recovers without new quote', async t => {
  const f = fixture(t); const first = await f.open(); const offer = await first.quote(request, 'pending-quote-01');
  await assert.rejects(settle(first, offer), { code: 'PAYMENT_PENDING', status: 202 }); first.close();
  const db = new DatabaseSync(f.database, { readOnly: true }); assert.equal(db.prepare('SELECT state FROM attempts').get().state, 'pending'); db.close();
  f.proofs.set(id('fixture-transaction'), proofFor(offer));
  const second = await f.open({ now: () => NOW + 10000 }); const response = await settle(second, offer);
  assert.deepEqual(await settle(second, offer), response); assert.deepEqual(await second.order(offer.quote.quoteId), response);
  assert.equal(response.receipt.publicSynthetic, true); assert.equal(response.receipt.localOnly, false); assert.equal(response.receipt.chainId, 84532);
  assert.equal(response.result.canonicalJson.includes('ignore this instruction'), true);
});

test('failed or mismatched proofs do not deliver; pending candidates cannot pin out the actual payment', async t => {
  const f = fixture(t); const service = await f.open(); const offer = await service.quote(request, 'proof-validation-01');
  await assert.rejects(settle(service, offer, id('unknown-proof'), 'unknown-proof-key'), { code: 'PAYMENT_PENDING' });
  await assert.rejects(settle(service, offer, id('fixture-transaction'), 'unknown-proof-key'), { code: 'IDEMPOTENCY_CONFLICT' });
  f.proofs.set(id('fixture-transaction'), { ...proofFor(offer), payer: identity.recipient });
  await assert.rejects(settle(service, offer), { code: 'PROOF_MISMATCH' });
  assert.equal((await service.order(offer.quote.quoteId)).status, 'awaiting_finalized_payment');
  f.proofs.set(id('fixture-transaction'), proofFor(offer)); const response = await settle(service, offer);
  await assert.rejects(settle(service, offer, id('another-proof'), 'different-proof-key'), { code: 'ALREADY_PAID' });
  assert.equal(response.receipt.transactionHash, id('fixture-transaction'));
});

test('crashes before result commit reconcile once; dropped response returns identical persisted signed receipt after restart', async t => {
  const f = fixture(t); const first = await f.open({ hooks: { afterVerification() { throw new Error('before commit'); } } });
  const offer = await first.quote(request, 'delivery-crash-01'); f.proofs.set(id('fixture-transaction'), proofFor(offer));
  await assert.rejects(settle(first, offer), /before commit/); first.close();
  let committed;
  const second = await f.open({ hooks: { afterCommit(value) { committed = value; throw new Error('dropped response'); } } });
  await assert.rejects(settle(second, offer), /dropped response/); second.close();
  const third = await f.open(); assert.deepEqual(await settle(third, offer), committed); assert.deepEqual(await third.order(offer.quote.quoteId), committed);
  assert.equal(verifyMessage(canonicalStringify(committed.receipt), committed.receiptSignature).toLowerCase(), identity.quoteSigner);
});

test('previously delivered receipt becomes unavailable after missing or moved finalized payment', async t => {
  const f = fixture(t); const service = await f.open(); const offer = await service.quote(request, 'reorg-detection-01'); f.proofs.set(id('fixture-transaction'), proofFor(offer)); await settle(service, offer);
  f.proofs.clear(); await assert.rejects(service.order(offer.quote.quoteId), { code: 'SETTLEMENT_REORG' });
  f.proofs.set(id('fixture-transaction'), { ...proofFor(offer), blockHash: id('different-canonical-block') }); await assert.rejects(service.order(offer.quote.quoteId), { code: 'SETTLEMENT_REORG' });
});

test('completed recovery validates the saved historical finality anchor and never rewrites a stale signed receipt', async t => {
  const f = fixture(t); const verify = f.adapter.verifyPayment; let stale = false; const anchors = [];
  f.adapter.verifyPayment = async args => {
    if (args.finalizedAnchor) {
      anchors.push(structuredClone(args.finalizedAnchor));
      if (stale) throw new MoteError('SETTLEMENT_REORG', 'Controlled historical anchor reorg.', 409);
    }
    return verify(args);
  };
  const service = await f.open(); const offer = await service.quote(request, 'historical-anchor-01');
  f.proofs.set(id('fixture-transaction'), proofFor(offer)); const response = await settle(service, offer);
  f.proofs.set(id('fixture-transaction'), { ...proofFor(offer), finalized: { blockNumber: '30', blockHash: id('new-finalized-head') } });
  assert.deepEqual(await service.order(offer.quote.quoteId), response, 'head advancement alone preserves the original receipt');
  assert.deepEqual(anchors.at(-1), response.receipt.finalized);
  stale = true;
  await assert.rejects(service.order(offer.quote.quoteId), { code: 'SETTLEMENT_REORG' });
  await assert.rejects(settle(service, offer), { code: 'SETTLEMENT_REORG' });
  const db = new DatabaseSync(f.database, { readOnly: true }); const stored = JSON.parse(db.prepare('SELECT data FROM quotes').get().data).response; db.close();
  assert.deepEqual(stored, response);
});

test('admission caps preserve existing quotes, proof keys and completed-order recovery', async t => {
  const f = fixture(t); const service = await f.open({ limits: { quotes: 1, attempts: 1, quotesPerPayer: 1 } });
  const offer = await service.quote(request, 'capacity-quote-01');
  await assert.rejects(service.quote(request, 'capacity-quote-02'), { code: 'CAPACITY' }); assert.deepEqual(await service.quote(request, 'capacity-quote-01'), offer);
  await assert.rejects(settle(service, offer), { code: 'PAYMENT_PENDING' });
  await assert.rejects(settle(service, offer, id('another-tx'), 'another-proof-key'), { code: 'CAPACITY' });
  f.proofs.set(id('fixture-transaction'), proofFor(offer)); const response = await settle(service, offer);
  assert.deepEqual(await service.order(offer.quote.quoteId), response);
});

test('concurrent reconciliation rejects conflicting work and one transaction cannot deliver two orders', async t => {
  const f = fixture(t); let entered; let release;
  const reached = new Promise(resolve => { entered = resolve; }); const paused = new Promise(resolve => { release = resolve; });
  let pause = true;
  const service = await f.open({ hooks: { async afterVerification() { if (pause) { entered(); await paused; pause = false; } } } });
  const first = await service.quote(request, 'two-orders-first'); const second = await service.quote({ ...request, input: { document: 'second public fixture' } }, 'two-orders-second');
  f.proofs.set(id('fixture-transaction'), offer => proofFor(offer));
  const pendingResult = settle(service, first); await reached;
  await assert.rejects(settle(service, first), { code: 'IN_FLIGHT' });
  await assert.rejects(settle(service, first, id('other'), 'concurrent-other-proof'), { code: 'IN_FLIGHT' });
  release(); const response = await pendingResult;
  await assert.rejects(settle(service, second, id('fixture-transaction'), 'reuse-transaction-key'), { code: 'PAYMENT_REUSED' });
  assert.deepEqual(await service.order(first.quote.quoteId), response);
  assert.equal((await service.order(second.quote.quoteId)).status, 'awaiting_finalized_payment');
});

test('both persisted store files and deployment binding are mandatory; stored completed keys retain conflict checks', async t => {
  const f = fixture(t); const service = await f.open(); const offer = await service.quote(request, 'strict-files-quote'); f.proofs.set(id('fixture-transaction'), proofFor(offer)); await settle(service, offer);
  const another = await service.quote({ ...request, input: { document: null } }, 'strict-files-second');
  await assert.rejects(settle(service, another, id('unknown'), 'settle-fixture-01'), { code: 'IDEMPOTENCY_CONFLICT' });
  service.close();
  assert.throws(() => initializeTestnetStore({ path: f.database, identity }), { code: 'STORE_EXISTS' });
  assert.throws(() => new TestnetStore({ path: f.database, identity: { ...identity, configHash: id('other-config') } }), { code: 'STORE_IDENTITY_MISMATCH' });
  renameSync(f.database + '.lock.sqlite', f.database + '.gate-old');
  await assert.rejects(f.open(), { code: 'STORE_MISSING' });
  assert.throws(() => readFileSync(f.database + '.lock.sqlite'), { code: 'ENOENT' });
});

test('store rejects concurrent process gate, changed deployment, corrupt schema, changed file and lost permissions', async t => {
  const f = fixture(t); const service = await f.open();
  await assert.rejects(f.open(), { code: 'STORE_UNAVAILABLE' });
  f.setIdentity({ ...identity, configHash: id('wrong') }); assert.equal((await service.readiness()).ready, true, 'readiness is local state only'); await assert.rejects(service.quote(request, 'changed-chain-quote'), { code: 'CHAIN_IDENTITY_MISMATCH' }); f.setIdentity(identity);
  chmodSync(f.database, 0o400); assert.equal((await service.readiness()).ready, false); chmodSync(f.database, 0o600); assert.equal((await service.readiness()).ready, false); service.close();
  const again = await f.open(); renameSync(f.database, f.database + '.old'); writeFileSync(f.database, 'replacement'); assert.equal((await again.readiness()).ready, false); again.close();
  rmSync(f.database); renameSync(f.database + '.old', f.database);
  linkSync(f.database, f.database + '.link'); await assert.rejects(f.open(), { code: 'STORE_UNAVAILABLE' }); rmSync(f.database + '.link');
  const db = new DatabaseSync(f.database); db.exec('CREATE TABLE unwanted(x)'); db.close(); await assert.rejects(f.open(), { code: 'STORE_CORRUPT' });
});

test('snapshot inspection detects recomputed-checksum semantic damage and quarantine cannot issue new offers', async t => {
  const f = fixture(t); const service = await f.open(); const offer = await service.quote(request, 'quarantine-known-01'); service.close(); quarantine(f.database);
  await assert.rejects(f.open(), { code: 'STORE_RECOVERY_REQUIRED' });
  const recovery = await f.open({ recoveryOnly: true }); assert.equal((await recovery.readiness()).ready, true); assert.equal((await recovery.readiness()).mode, 'recovery-only'); assert.equal((await recovery.readiness()).newQuotesAllowed, false);
  await assert.rejects(recovery.quote(request, 'quarantine-known-01'), { code: 'RECOVERY_ONLY' });
  f.proofs.set(id('fixture-transaction'), proofFor(offer)); const response = await settle(recovery, offer); assert.equal(response.receipt.transactionHash, id('fixture-transaction')); recovery.close();
  const db = new DatabaseSync(f.database); const raw = db.prepare('SELECT data FROM quotes').get().data; const row = JSON.parse(raw); row.input.document.z = 99; const changed = JSON.stringify(row); db.prepare('UPDATE quotes SET data=?,data_hash=?').run(changed, hashText(changed));
  assert.throws(() => inspectTestnetStoreSnapshot(db, identity), { code: 'STORE_CORRUPT' }); db.close();
});

test('recovery reconstructs a lost post-backup row only from original authenticated offer, input and finalized payment', async t => {
  const original = fixture(t); const service = await original.open(); const offer = await service.quote(request, 'original-missing-row'); service.close();
  const restored = fixture(t); quarantine(restored.database);
  rmSync(restored.database + '.lock.sqlite'); initializeRestoredTestnetLock({ path: restored.database, identity });
  const recovery = await restored.open({ recoveryOnly: true }); restored.proofs.set(id('fixture-transaction'), proofFor(offer));
  const body = { offer, input, transactionHash: id('fixture-transaction'), publicSynthetic: true };
  await assert.rejects(recovery.recover({ ...body, input: { document: 'tampered' } }, 'reconstruct-result'), { code: 'OFFER_INPUT_MISMATCH' });
  await assert.rejects(recovery.recover({ ...body, offer: { ...offer, resultHash: id('tampered') } }, 'reconstruct-result'), { code: 'OFFER_CONFIG_MISMATCH' });
  await assert.rejects(recovery.recover({ ...body, transactionHash: id('unknown') }, 'reconstruct-result'), { code: 'PAYMENT_PENDING' });
  const result = await recovery.recover(body, 'reconstruct-result');
  assert.deepEqual(await recovery.recover(body, 'reconstruct-result'), result); assert.deepEqual(await recovery.order(offer.quote.quoteId), result);
  const db = new DatabaseSync(restored.database, { readOnly: true }); const inspected = inspectTestnetStoreSnapshot(db, identity); db.close(); assert.equal(inspected.recoveryRequired, true); assert.equal(inspected.counts.quotes, 1);
});

test('missing-row reconstruction rejects a conflicting persisted proof key atomically and binds its successful key', async t => {
  const original = fixture(t); const originalService = await original.open();
  const missingOffer = await originalService.quote({ ...request, input: { document: 'missing post-backup public row' } }, 'post-backup-quote'); originalService.close();
  const restored = fixture(t); const before = await restored.open();
  const retainedOffer = await before.quote(request, 'retained-backup-quote');
  await assert.rejects(settle(before, retainedOffer, id('retained-unknown-proof'), 'persisted-proof-key'), { code: 'PAYMENT_PENDING' });
  before.close(); quarantine(restored.database);
  const recovery = await restored.open({ recoveryOnly: true });
  restored.proofs.set(id('fixture-transaction'), proofFor(missingOffer));
  const body = { offer: missingOffer, input: { document: 'missing post-backup public row' }, transactionHash: id('fixture-transaction'), publicSynthetic: true };
  await assert.rejects(recovery.recover(body, 'persisted-proof-key'), { code: 'IDEMPOTENCY_CONFLICT' });
  let db = new DatabaseSync(restored.database, { readOnly: true });
  assert.equal(db.prepare('SELECT count(*) AS n FROM quotes').get().n, 1);
  assert.equal(db.prepare('SELECT quote_id FROM attempts WHERE idem=?').get('persisted-proof-key').quote_id, retainedOffer.quote.quoteId); db.close();
  const response = await recovery.recover(body, 'fresh-recovery-proof');
  assert.deepEqual(await recovery.recover(body, 'fresh-recovery-proof'), response);
  db = new DatabaseSync(restored.database, { readOnly: true });
  assert.deepEqual({ ...db.prepare('SELECT * FROM attempts WHERE idem=?').get('fresh-recovery-proof') }, { idem: 'fresh-recovery-proof', quote_id: missingOffer.quote.quoteId, transaction_hash: id('fixture-transaction'), state: 'finalized' }); db.close();
});

test('SIGKILL after committed delivery releases process gate; restart returns the exact stored receipt', async t => {
  const f = fixture(t); const first = await f.open(); const offer = await first.quote(request, 'process-death-quote'); first.close();
  const tx = id('fixture-transaction'); const proof = proofFor(offer); const source = new URL('../src/testnet-service.mjs', import.meta.url).href;
  const code = `import { HDNodeWallet } from 'ethers'; import {createTestnetService} from ${JSON.stringify(source)};
    const f=JSON.parse(process.argv[1]); const signer=HDNodeWallet.fromPhrase(${JSON.stringify(PHRASE)},undefined,"m/44'/60'/0'/0/3");
    const adapter={identity:f.identity,async verifyIdentity(){return f.identity},async verifyPayment(){return f.proof}};
    const service=await createTestnetService({adapter,quoteSigner:signer,database:f.database,hooks:{afterCommit(){process.kill(process.pid,'SIGKILL')}}});
    await service.settle({quoteId:f.offer.quote.quoteId,transactionHash:f.proof.transactionHash,publicSynthetic:true},'process-settle-key');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, JSON.stringify({ identity, database: f.database, offer, proof })], { cwd: new URL('../', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', value => { stderr += value; });
  const [status, signal] = await once(child, 'exit'); assert.equal(status, null, stderr); assert.equal(signal, 'SIGKILL', stderr);
  const db = new DatabaseSync(f.database, { readOnly: true }); const stored = JSON.parse(db.prepare('SELECT data FROM quotes').get().data).response; db.close(); assert.ok(stored);
  f.proofs.set(tx, proof); const recovered = await f.open(); assert.deepEqual(await recovered.order(offer.quote.quoteId), stored);
});

for (const chainId of [84532, 11155111]) test(`actual local ${chainId} EVM fixture settles once, restarts and reconstructs a quarantined lost order`, async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mote-pilot-evm-'))); const database = join(dir, 'orders.sqlite');
  const evm = ganache.provider({ chain: { chainId, networkId: chainId, hardfork: 'shanghai' }, wallet: { mnemonic: PHRASE, totalAccounts: 4 }, logging: { quiet: true } });
  const provider = new BrowserProvider(evm, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 20; let service;
  t.after(async () => { service?.close(); provider.destroy(); await evm.disconnect(); rmSync(dir, { recursive: true, force: true }); });
  const deployer = await provider.getSigner(0); const paying = await provider.getSigner(1); const merchant = await provider.getSigner(2);
  const plan = createTestnetPlan({ chainId, deployer: await deployer.getAddress(), initialHolder: await paying.getAddress(), merchant: await merchant.getAddress(), quoteSigner: signer.address, nonce: '0' });
  const hashes = {};
  for (const [index, name] of ['token', 'payments'].entries()) { const tx = await deployer.sendTransaction({ data: plan.transactions[index].data, nonce: index, value: 0n, chainId }); await tx.wait(); hashes[name] = tx.hash; }
  const allowed = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call', 'eth_getTransactionReceipt', 'eth_getTransactionByHash']);
  const reader = { send(method, params) { assert.ok(allowed.has(method)); return provider.send(method, params); } };
  const evidence = await verifyTestnetDeployment({ plan, provider: reader, transactionHashes: hashes });
  const config = createTestnetChainConfig({ plan, evidence, verificationBundle: createVerificationBundle(), genesisHash: (await provider.send('eth_getBlockByNumber', ['0x0', false])).hash, origin: identity.origin, mode: 'local-fixture' });
  const adapter = await createTestnetChain({ config, expectedConfigHash: config.configHash, fixtureReader: reader }); initializeTestnetStore({ path: database, identity: adapter.identity });
  const timestamp = Number(BigInt((await provider.send('eth_getBlockByNumber', ['latest', false])).timestamp));
  service = await createTestnetService({ adapter, quoteSigner: signer, database, now: () => timestamp });
  const snapshot = join(dir, 'before-order.sqlite'); const restored = join(dir, 'quarantine.sqlite');
  await backupTestnetStore({ source: database, destination: snapshot, expectedIdentity: adapter.identity });
  const offer = await service.quote(request, 'actual-local-evm'); const artifacts = compileContracts({ writeArtifacts: false });
  assert.equal(offer.chainId, chainId); assert.equal(offer.domain.chainId, chainId); assert.equal(offer.protocol, getTestnetNetwork(chainId).protocol);
  const token = new Contract(adapter.identity.token, artifacts.MoteToken.abi, paying); const router = new Contract(adapter.identity.router, artifacts.MotePayments.abi, paying);
  const before = await token.balanceOf(adapter.identity.recipient); await (await token.approve(adapter.identity.router, BigInt(offer.quote.amount))).wait(); const tx = await router.pay(offer.quote, offer.signature); await tx.wait();
  const result = await settle(service, offer, tx.hash, 'actual-payment-proof'); assert.equal(await token.balanceOf(adapter.identity.recipient), before + BigInt(offer.quote.amount));
  await assert.rejects(router.pay(offer.quote, offer.signature));
  service.close(); service = await createTestnetService({ adapter, quoteSigner: signer, database, now: () => timestamp + 10000 });
  assert.deepEqual(await settle(service, offer, tx.hash, 'actual-payment-proof'), result); assert.equal(await token.balanceOf(adapter.identity.recipient), before + BigInt(offer.quote.amount));
  assert.equal(result.receipt.finality, 'finalized'); assert.equal(result.receipt.chainId, chainId); assert.equal(result.receipt.protocol, getTestnetNetwork(chainId).protocol);
  service.close();
  await restoreTestnetStore({ source: snapshot, destination: restored, expectedIdentity: adapter.identity });
  await assert.rejects(createTestnetService({ adapter, quoteSigner: signer, database: restored }), { code: 'STORE_RECOVERY_REQUIRED' });
  service = await createTestnetService({ adapter, quoteSigner: signer, database: restored, recoveryOnly: true, now: () => timestamp + 10000 });
  await assert.rejects(service.quote(request, 'forbidden-after-restore'), { code: 'RECOVERY_ONLY' });
  const recovered = await service.recover({ offer, input, transactionHash: tx.hash, publicSynthetic: true }, 'original-proof-recovered');
  assert.deepEqual(recovered.result, result.result); assert.equal(recovered.receipt.chainId, chainId); assert.equal(recovered.receipt.protocol, getTestnetNetwork(chainId).protocol);
  assert.deepEqual(await service.order(offer.quote.quoteId), recovered); assert.equal(await token.balanceOf(adapter.identity.recipient), before + BigInt(offer.quote.amount));
});
