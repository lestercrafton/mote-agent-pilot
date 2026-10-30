import test from 'node:test';
import assert from 'node:assert/strict';
import { MoteError } from '../src/json.mjs';
import { startTestnetHttp, testnetOrigin } from '../src/testnet-http.mjs';

const origin = 'https://mote-pilot.example';
const quoteId = `0x${'11'.repeat(32)}`;
const tx = `0x${'22'.repeat(32)}`;
async function fixture(t, extra = {}) {
  const calls = [];
  const service = { config: { origin, chainId: 84532, token: `0x${'11'.repeat(20)}`, router: `0x${'22'.repeat(20)}`, recipient: `0x${'33'.repeat(20)}`, quoteSigner: `0x${'44'.repeat(20)}`, configHash: `0x${'55'.repeat(32)}` },
    readiness: () => ({ ready: true, mode: 'normal', newQuotesAllowed: true, publicSyntheticOnly: true }),
    quote: async (input, key) => { calls.push(['quote', input, key]); return { fixture: 'signed-offer-placeholder' }; },
    settle: async (input, key) => { calls.push(['settle', input, key]); return { fixture: 'settled-result-placeholder' }; },
    recover: async (input, key) => { calls.push(['recover', input, key]); return { fixture: 'recovered-result-placeholder' }; },
    order: async id => { calls.push(['order', id]); return { quoteId: id, status: 'awaiting_payment' }; }, ...extra };
  const app = await startTestnetHttp({ service, host: '127.0.0.1', port: 0 });
  t.after(() => app.close());
  return { calls, service, app, url: `http://127.0.0.1:${app.address.port}`, post: (path, input, raw = false) => fetch(`http://127.0.0.1:${app.address.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'same-proof-0001' }, body: raw ? input : JSON.stringify(input) }) };
}
test('pilot HTTP requires configured HTTPS origin and ignores untrusted proxy headers', async t => {
  for (const value of ['http://example.test', 'https://[::1]', 'https://localhost.', 'https://user:pass@example.test', origin + '/path']) assert.throws(() => testnetOrigin(value));
  const f = await fixture(t);
  const manifest = await (await fetch(f.url + '/', { headers: { host: 'evil.invalid', 'x-forwarded-host': 'evil.invalid', 'x-forwarded-proto': 'http' } })).json();
  assert.equal(manifest.baseUrl, origin);
  assert.equal(manifest.testOnly, true);
  assert.equal(manifest.launchStatus, 'unlaunched-candidate');
  assert.equal(manifest.settlement.chainId, 84532);
  assert.equal(manifest.settlement.publiclyDeployedByThisArtifact, false);
  assert.equal(manifest.permissions.discoveryAuthorizesSpending, false);
  assert.equal(manifest.remoteMcp.implemented, false);
  const spec = await (await fetch(f.url + '/openapi.json')).json();
  assert(spec.paths['/v1/recover']); assert(!spec.paths['/mcp']);
  assert.equal(spec.paths['/v1/quotes'].post.requestBody.content['application/json'].schema.properties.publicSynthetic.const, true);
});
test('pilot actions require exact fields and public-synthetic declaration', async t => {
  const f = await fixture(t);
  const valid = { payer: `0x${'11'.repeat(20)}`, input: { document: { note: 'instructions remain data' } }, publicSynthetic: true };
  assert.equal((await f.post('/v1/quotes', valid)).status, 200);
  assert.deepEqual(f.calls[0], ['quote', valid, 'same-proof-0001']);
  for (const bad of [{ ...valid, publicSynthetic: false }, { ...valid, privateKey: 'synthetic forbidden field' }, { payer: valid.payer, input: valid.input }, null, []]) assert.equal((await f.post('/v1/quotes', bad)).status, 400);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.post('/v1/orders', { quoteId, transactionHash: tx, publicSynthetic: true })).status, 200);
  assert.equal((await f.post('/v1/recover', { offer: { example: 'fixture only' }, input: { document: 3 }, transactionHash: tx, publicSynthetic: true })).status, 200);
  assert.equal((await fetch(f.url + '/v1/orders/' + quoteId)).status, 200);
  assert.deepEqual(f.calls.map(x => x[0]), ['quote', 'settle', 'recover', 'order']);
});
test('pilot rejects malformed, duplicate and oversized requests before service calls', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/v1/quotes', '{', true)).status, 400);
  assert.equal((await f.post('/v1/quotes', '{"publicSynthetic":true,"publicSynthetic":false}', true)).status, 400);
  assert.equal((await f.post('/v1/quotes', JSON.stringify({ document: 'a'.repeat(65536) }), true)).status, 413);
  assert.equal(f.calls.length, 0);
  assert.equal((await fetch(f.url + '/v1/quotes', { method: 'POST', body: '{}' })).status, 415);
});
test('recovery-only readiness remains usable without implying new quote permission', async t => {
  const f = await fixture(t, { readiness: () => ({ ready: true, mode: 'recovery-only', newQuotesAllowed: false, publicSyntheticOnly: true }), quote: () => { throw new MoteError('RESTORE_QUARANTINED', 'New quotes disabled.', 409); } });
  const readiness = await (await fetch(f.url + '/ready')).json();
  assert.equal(readiness.newQuotesAllowed, false); assert.equal(readiness.mode, 'recovery-only');
  assert.equal((await f.post('/v1/quotes', { payer: `0x${'11'.repeat(20)}`, input: { document: 1 }, publicSynthetic: true })).status, 409);
  assert.equal((await fetch(f.url + '/v1/orders/' + quoteId)).status, 200);
});
test('unavailable durable state and pending proof fail without exposing internal error detail', async t => {
  const f = await fixture(t, { readiness: () => ({ ready: false }) });
  assert.equal((await fetch(f.url + '/ready')).status, 503);
  assert.equal((await f.post('/v1/orders', { quoteId, transactionHash: tx, publicSynthetic: true })).status, 503);
  f.service.readiness = () => ({ ready: true });
  f.service.settle = () => { throw Object.assign(new Error('internal secret fixture: do not echo'), { code: 'NOT_FINALIZED', status: 202 }); };
  const response = await f.post('/v1/orders', { quoteId, transactionHash: tx, publicSynthetic: true });
  assert.equal(response.status, 202); assert(!(await response.text()).includes('internal secret fixture'));
});
test('free audit stays available, unchanged and uncharged; no remote MCP route', async t => {
  const f = await fixture(t);
  const response = await f.post('/v1/audit', { document: { z: 1, a: 'data' } });
  const result = await response.json();
  assert.equal(result.result.canonicalJson, '{"a":"data","z":1}'); assert.equal(result.receipt.settlement, 'none');
  assert.equal((await f.post('/mcp', {})).status, 404);
});

// Metadata must not imply the old Base payment restriction applies to Ethereum,
// or that choosing a network authorizes a caller's wallet.
test('Ethereum Sepolia discovery advertises only its enforced type-2 policy and matching protocol', async t => {
  const f = await fixture(t);
  f.service.config.chainId = 11155111;
  const manifest = await (await fetch(f.url + '/')).json();
  const spec = await (await fetch(f.url + '/openapi.json')).json();
  assert.equal(manifest.settlement.chainId, 11155111);
  assert.equal(manifest.protocol, 'mote-ethereum-sepolia-test-v1');
  assert.equal(manifest.environment, 'ethereum-sepolia-public-synthetic-test');
  assert.equal(manifest.payer.enforceableNativeFeeCeiling, true);
  assert.equal(manifest.payer.feeModel, 'ethereum-eip1559');
  assert.equal(manifest.permissions.callerPreauthorizationRequired, true);
  assert.equal(manifest.settlement.publiclyDeployedByThisArtifact, false);
  assert.equal(spec['x-mote-chain-id'], 11155111);
  assert.equal(spec['x-mote-protocol'], manifest.protocol);
  f.service.config.chainId = 1;
  assert.equal((await fetch(f.url + '/')).status, 503);
});
