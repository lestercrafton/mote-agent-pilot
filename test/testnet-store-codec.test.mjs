import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalStringify, hashJson, hashText, prepareAudit } from '../src/json.mjs';
import { decodeTestnetStoreRow, encodeTestnetStoreRow, initializeTestnetStore, normalizeTestnetStoreIdentity, TestnetStore, TESTNET_STORE_ROW_ENCODING } from '../src/testnet-store.mjs';

const hex = n => `0x${n.toString(16).padStart(64, '0')}`;
const address = n => `0x${n.toString(16).padStart(40, '0')}`;
const identity = normalizeTestnetStoreIdentity({ origin: 'https://codec.example.invalid', chainId: 84532, genesisHash: null, token: address(1), router: address(2), recipient: address(3), quoteSigner: address(4), checkpoint: { blockNumber: '123', blockHash: hex(5) }, configHash: hex(6) });
function fixture(input = { document: { z: 1, a: 'instructions stay data' } }, settled = true) {
  const prepared = prepareAudit(input), id = hex(100), payer = address(100);
  const binding = Object.fromEntries(['chainId', 'origin', 'token', 'router', 'recipient', 'quoteSigner', 'configHash'].map(key => [key, identity[key]]));
  const draft = { ...binding, protocol: 'mote-base-sepolia-test-v1', domain: { name: 'MotePayments', version: '1', chainId: identity.chainId, verifyingContract: identity.router }, publicSynthetic: true, testOnly: true, resultHash: prepared.resultHash, quote: { quoteId: id, requestHash: prepared.requestHash, payer, amount: prepared.amount, deadline: '1900000000' } };
  const offer = { ...draft, signature: 'storage-only-public-fixture', offerSignature: 'storage-only-public-fixture' };
  const transactionHash = settled ? hex(1000) : null;
  const response = settled ? { result: structuredClone(prepared.result), receipt: { ...binding, protocol: draft.protocol, transactionHash, quoteId: id, requestHash: prepared.requestHash, resultHash: prepared.resultHash }, receiptSignature: 'retained-unchanged-public-fixture', receiptSigner: identity.quoteSigner } : null;
  return { id, key: 'codec-order-key', fingerprint: hashJson({ payer, requestHash: prepared.requestHash, publicSynthetic: true }), payer, input, result: prepared.result, draft, offer, response, transactionHash };
}
function raw(row, data = encodeTestnetStoreRow(row, identity)) { return { id: row.id, idem: row.key, fingerprint: row.fingerprint, payer: row.payer, transaction_hash: row.transactionHash, data, data_hash: hashText(data) }; }
const decode = (row, data) => decodeTestnetStoreRow(raw(row, data), identity);
const entropy = length => Array.from({ length: Math.ceil(length / 64) }, (_, i) => createHash('sha256').update(`public-storage-fixture-${i}`).digest('hex')).join('').slice(0, length);

test('compact rows retain exact full response bytes, signed commitments and caller objects', () => {
  const row = fixture(), original = JSON.stringify(row), data = encodeTestnetStoreRow(row, identity), stored = JSON.parse(data);
  assert.equal(stored.encoding, TESTNET_STORE_ROW_ENCODING);
  assert.equal(stored.row.result.canonicalJson, null);
  assert.equal(stored.row.response.result, null);
  const restored = decode(row, data);
  assert.deepEqual(restored, row);
  assert.equal(JSON.stringify(restored), original);
  assert.equal(JSON.stringify(restored.response), JSON.stringify(row.response));
  assert.equal(hashJson(restored.result), row.draft.resultHash);
  assert.equal(JSON.stringify(row), original);
  assert.notEqual(restored.response.result, restored.result);
});

test('near-limit high-entropy documents use one stored copy without compression assumptions', () => {
  const row = fixture({ document: { payload: entropy(65_200) } });
  const full = JSON.stringify(row), compact = encodeTestnetStoreRow(row, identity);
  assert.ok(Buffer.byteLength(canonicalStringify(row.input)) > 65_200);
  assert.ok(Buffer.byteLength(compact) < Buffer.byteLength(full) * 0.36);
  assert.equal(compact.split(row.input.document.payload).length - 1, 1);
  assert.equal(JSON.stringify(decode(row, compact)), full);
});

test('null, primitive, escaped Unicode, invalid schema results and unsigned drafts round-trip', () => {
  for (const input of [
    { document: null }, { document: false }, { document: -0 }, { document: '' },
    { document: { '\ud800': '\udfff\n"\\', 'é': ['😀', null, 0.125] } },
    { document: { n: 0 }, schema: { type: 'object', properties: { n: { minimum: 1 } } } },
  ]) {
    const row = fixture(input, false); row.offer = null;
    // JSON serialization is the existing store's representation of negative zero.
    assert.equal(JSON.stringify(decode(row)), JSON.stringify(row));
  }
});

test('legacy direct rows remain readable and unusual legacy result key order stays byte-identical', () => {
  const row = fixture(), direct = JSON.stringify(row);
  assert.equal(JSON.stringify(decode(row, direct)), direct);
  row.response.result = Object.fromEntries(Object.entries(row.response.result).reverse());
  const reordered = JSON.stringify(row);
  assert.equal(encodeTestnetStoreRow(row, identity), reordered);
  assert.equal(JSON.stringify(decode(row)), reordered);
});

test('encoding rejects mismatched canonical bytes, delivery and identity before elision', () => {
  for (const mutate of [
    row => { row.result.canonicalJson = '"changed"'; },
    row => { row.response.result.canonicalJson = '"changed"'; },
    row => { row.response.result.valid = false; },
    row => { row.draft.resultHash = hex(777); },
    row => { row.input.document.z = 999; },
    row => { row.response.receipt.configHash = hex(777); },
  ]) {
    const row = fixture(); mutate(row);
    assert.throws(() => encodeTestnetStoreRow(row, identity), { code: 'STORE_CORRUPT' });
  }
  assert.throws(() => encodeTestnetStoreRow(fixture(), { ...identity, router: address(99) }), { code: 'STORE_CORRUPT' });
});

test('unknown versions, extra fields and non-null placeholders fail even with rewritten checksums', () => {
  const row = fixture(), original = JSON.parse(encodeTestnetStoreRow(row, identity));
  for (const mutate of [
    data => { data.encoding = 'mote-order-elision-v2'; },
    data => { delete data.encoding; },
    data => { data.extra = true; },
    data => { data.row.result.canonicalJson = row.result.canonicalJson; },
    data => { delete data.row.result.canonicalJson; },
    data => { data.row.response.result = row.result; },
    data => { delete data.row.response.result; },
    data => { data.row.result.valid = false; },
    data => { data.row.input.document.z = 999; },
    data => { data.row.result.sha256 = hex(999); },
    data => { data.row.draft.resultHash = hex(999); },
    data => { data.row.response.receipt.quoteId = hex(999); },
    data => { data.row.response.receiptSignature = null; data.row.response.extra = true; data.row.result.extra = true; },
  ]) {
    const changed = structuredClone(original); mutate(changed);
    assert.throws(() => decode(row, JSON.stringify(changed)), { code: 'STORE_CORRUPT' });
  }
  const damaged = raw(row); damaged.data_hash = hex(999);
  assert.throws(() => decodeTestnetStoreRow(damaged, identity), { code: 'STORE_CORRUPT' });
  const wrongIndex = raw(row); wrongIndex.transaction_hash = hex(999);
  assert.throws(() => decodeTestnetStoreRow(wrongIndex, identity), { code: 'STORE_CORRUPT' });
});

test('expanded and encoded record caps are both enforced', () => {
  const row = fixture({ document: { payload: entropy(65_000) } });
  row.response.note = 'x'.repeat(400_000);
  assert.ok(Buffer.byteLength(JSON.stringify(row)) > 524288);
  assert.throws(() => encodeTestnetStoreRow(row, identity), { code: 'STORE_LIMIT' });
  const stored = structuredClone(row); stored.result.canonicalJson = null; stored.response.result = null;
  const compact = JSON.stringify({ encoding: TESTNET_STORE_ROW_ENCODING, row: stored });
  assert.ok(Buffer.byteLength(compact) < 524288);
  assert.throws(() => decode(row, compact), { code: 'STORE_CORRUPT' });
  const oversized = JSON.stringify({ encoding: TESTNET_STORE_ROW_ENCODING, row: { ...stored, note: 'x'.repeat(524288) } });
  assert.throws(() => decode(row, oversized), { code: 'STORE_CORRUPT' });
});

test('production writes use the codec and reading a legacy row does not rewrite it', t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'mote-codec-'))), path = join(directory, 'orders.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  initializeTestnetStore({ path, identity });
  const row = fixture(), store = new TestnetStore({ path, identity });
  t.after(() => store.close());
  store.saveDraft(row); store.saveOffer(row.id, row.offer); store.saveResponse(row.id, row.transactionHash, row.response);
  let saved = store.db.prepare('SELECT * FROM quotes').get();
  assert.equal(JSON.parse(saved.data).encoding, TESTNET_STORE_ROW_ENCODING);
  assert.equal(JSON.stringify(store.byId(row.id).response), JSON.stringify(row.response));
  const direct = JSON.stringify(row);
  store.db.prepare('UPDATE quotes SET data=?,data_hash=?').run(direct, hashText(direct));
  assert.equal(JSON.stringify(store.byId(row.id)), direct);
  saved = store.db.prepare('SELECT * FROM quotes').get();
  assert.equal(saved.data, direct);
  assert.equal(saved.data_hash, hashText(direct));
});
