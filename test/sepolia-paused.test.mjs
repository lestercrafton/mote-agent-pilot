import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { appendPaymentIdentifierToExtensions } from '@x402/extensions/payment-identifier';
import { getBytes, verifyMessage } from 'ethers';
import { freeAudit } from '../legacy/src/public.mjs';
import { authorize, recoverAuthorization } from '../src/client.mjs';
import { hashJson } from '../src/core/json.mjs';
import { startPausedLegacyHttp } from '../src/legacy-sepolia-disabled.mjs';
import { startCombinedFromEnvironment } from '../src/startup.mjs';
import { PRODUCTION_ACTIVATION } from '../src/production-policy.mjs';
import { USDC_MANIFEST, USDC_PATH } from '../src/combined.mjs';
import { fixture, input, PUBLIC_FIXTURE_PAYER, signer } from './fixtures.mjs';

const origin = 'https://mote.example';
const legacyFactory = () => startPausedLegacyHttp({ origin, port: 0, host: '127.0.0.1' });
const localUrl = app => `http://127.0.0.1:${app.legacy.transport.server.address().port}`;
const post = (base, path, body = input, headers = {}) => fetch(base + path, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

test('explicit Sepolia pause keeps the free utility and suppresses every legacy chain route and advertisement', async () => {
  const app = await startCombinedFromEnvironment({ MOTE_LEGACY_SEPOLIA_DISABLED: 'true', MOTE_USDC_ENABLED: 'false' }, {
    legacyFactory,
    usdcFactory: () => assert.fail('disabled USDC tried to start'),
  });
  try {
    const base = localUrl(app);
    const ready = await fetch(base + '/ready');
    assert.equal(ready.status, 200);
    const state = await ready.json();
    assert.equal(state.freeAuditAvailable, true);
    assert.deepEqual(state.legacySepolia, { enabled: false, newAdmissionAllowed: false, recoveryAvailable: false, reason: 'SEPOLIA_PAUSED' });
    assert.equal(state.usdc.enabled, false);
    assert.equal((await fetch(base + '/health')).status, 200);
    assert.deepEqual(await (await post(base, '/v1/audit')).json(), freeAudit(input));
    for (const path of ['/', '/.well-known/mote.json']) {
      const response = await fetch(base + path);
      assert.equal(response.headers.get('link'), null);
      const manifest = await response.json();
      assert.deepEqual(manifest.operations.map(operation => operation.url), [origin + '/v1/audit']);
      assert.deepEqual(manifest.legacySepolia, state.legacySepolia);
      assert.equal(manifest.baseUrl, origin);
      assert.equal(manifest.mcp, undefined);
      assert.equal(manifest.settlement, undefined);
    }
    const openapi = await (await fetch(base + '/openapi.json')).json();
    assert.deepEqual(Object.keys(openapi.paths).sort(), ['/.well-known/mote.json', '/health', '/v1/audit']);
    for (const [method, path] of [['POST', '/v1/quotes'], ['POST', '/v1/orders'], ['GET', `/v1/orders/0x${'ab'.repeat(32)}`], ['POST', '/v1/recover'], ['GET', '/v1/dispenser']]) {
      const response = method === 'GET' ? await fetch(base + path) : await post(base, path, {});
      assert.equal(response.status, 503, path);
      assert.equal((await response.json()).error.code, 'SEPOLIA_PAUSED');
    }
    assert.equal((await post(base, '/mcp', {})).status, 404);
    assert.equal((await post(base, USDC_PATH)).status, 503);
  } finally { await app.close(); }
});

test('the paused listener independently serves the Base mainnet adapter when configured', async () => {
  const f = fixture({ config: { origin, path: USDC_PATH, network: 'eip155:8453', amount: '10000' } });
  const env = { MOTE_LEGACY_SEPOLIA_DISABLED: 'true', MOTE_USDC_ENABLED: 'true', MOTE_USDC_ACTIVATION: PRODUCTION_ACTIVATION };
  const app = await startCombinedFromEnvironment(env, { legacyFactory, usdcFactory: observed => {
    assert.equal(observed, env);
    return f.service;
  } });
  try {
    const base = localUrl(app);
    const ready = await (await fetch(base + '/ready')).json();
    assert.equal(ready.freeAuditAvailable, true);
    assert.equal(ready.legacySepolia.enabled, false);
    assert.equal(ready.usdc.enabled, true);
    assert.equal(ready.usdc.network, 'eip155:8453');
    const manifest = await (await fetch(base + USDC_MANIFEST)).json();
    assert.equal(manifest.network, 'eip155:8453');
    assert.equal(manifest.endpoint, origin + USDC_PATH);
    const offered = await post(base, USDC_PATH);
    assert.equal(offered.status, 402);
    assert.ok(offered.headers.has('payment-required'));
    assert.equal(f.facilitator.settleCalls, 0);
  } finally { await app.close(); f.close(); }
});

test('an agent can discover the paid quote from the origin, complete it with the linked helper and recover the receipt', async () => {
  const f = fixture({ config: { origin, path: USDC_PATH, amount: '10000' }, clientBudget: '10000' });
  const app = await startCombinedFromEnvironment({ MOTE_USDC_ENABLED: 'true' }, {
    legacyFactory,
    usdcFactory: () => f.service,
  });
  try {
    const base = localUrl(app);
    const home = await fetch(base + '/');
    const discoveryLink = home.headers.get('link');
    assert.equal((await home.json()).payment.supported, false);
    assert.equal((await fetch(base + '/.well-known/mote.json?probe=1')).headers.get('link'), discoveryLink);
    const [, discoveryPath] = /^<([^>]+)>; rel="service-desc"; type="application\/json";/.exec(discoveryLink);
    assert.equal(discoveryPath, USDC_MANIFEST);
    const offerDocument = await (await fetch(base + discoveryPath)).json();
    assert.match(offerDocument.client.profileUrl, /\/docs\/PROFILE\.md$/);
    assert.match(offerDocument.client.sourceUrl, /\/src\/client\.mjs$/);
    const { example } = offerDocument.request;
    const endpoint = new URL(offerDocument.endpoint).pathname;
    const offered = await post(base, endpoint, example);
    assert.equal(offered.status, offerDocument.responses.quote.httpStatus);
    const quote = decodePaymentRequiredHeader(offered.headers.get(offerDocument.responses.quote.header));
    assert.deepEqual(quote, await offered.json());
    assert.equal(f.facilitator.settleCalls, 0);

    const account = signer(PUBLIC_FIXTURE_PAYER);
    const standard = await new ExactEvmScheme(account).createPaymentPayload(quote.x402Version, quote.accepts[0]);
    const standardOnly = {
      ...standard, resource: quote.resource, accepted: quote.accepts[0],
      extensions: appendPaymentIdentifierToExtensions({
        'payment-identifier': structuredClone(quote.extensions['payment-identifier']),
      }, 'standard-only-fixture-01'),
    };
    const header = offerDocument.retry.authorizationHeader;
    assert.equal(offerDocument.retry.samePaymentSignature, true);
    const rejected = await post(base, endpoint, example, { [header]: encodePaymentSignatureHeader(standardOnly) });
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { error: 'BINDING_REQUIRED' });
    assert.equal(f.facilitator.verifyCalls, 0);

    const paymentId = 'agent-discovery-fixture-01';
    const payment = await authorize({ config: f.c, input: example, offerResponse: quote, paymentId,
      signer: account, journal: f.clientJournal, policy: f.policy, now: f.chain.now });
    f.chain.finalized = 79n;
    const pending = await post(base, endpoint, example, { [header]: encodePaymentSignatureHeader(payment) });
    assert.equal(pending.status, offerDocument.responses.pending.httpStatus);
    assert.equal((await pending.json()).status, offerDocument.responses.pending.status);

    f.chain.finalized = 100n;
    const original = recoverAuthorization(f.clientJournal, paymentId);
    const paid = await post(base, endpoint, example, { [header]: encodePaymentSignatureHeader(original) });
    assert.equal(paid.status, offerDocument.responses.complete.httpStatus);
    const result = await paid.json();
    assert.equal(result.status, offerDocument.responses.complete.status);
    assert.equal(result.receipt.paymentId, paymentId);
    assert.equal(verifyMessage(getBytes(hashJson(result.receipt)), result.signature).toLowerCase(), offerDocument.offerSigner);
    const recovered = await post(base, endpoint, example, { [header]: encodePaymentSignatureHeader(original) });
    assert.equal(recovered.status, paid.status);
    assert.deepEqual(await recovered.json(), result);
    assert.equal(f.facilitator.settleCalls, 1);
  } finally { await app.close(); f.close(); }
});

test('an invalid pause flag or live testnet USDC activation fails before opening any listener', async () => {
  const deps = { legacyFactory: () => assert.fail('listener opened') };
  await assert.rejects(startCombinedFromEnvironment({ MOTE_LEGACY_SEPOLIA_DISABLED: 'maybe' }, deps), /SEPOLIA_PAUSE_FLAG/);
  await assert.rejects(startCombinedFromEnvironment({ MOTE_LEGACY_SEPOLIA_DISABLED: 'true', MOTE_USDC_ENABLED: 'true', MOTE_USDC_ACTIVATION: 'base-sepolia-beta-v1' }, deps), /SEPOLIA_PAUSE_MAINNET_ONLY/);
});
