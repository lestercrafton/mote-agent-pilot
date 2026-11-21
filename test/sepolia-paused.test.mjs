import test from 'node:test';
import assert from 'node:assert/strict';
import { freeAudit } from '../legacy/src/public.mjs';
import { startPausedLegacyHttp } from '../src/legacy-sepolia-disabled.mjs';
import { startCombinedFromEnvironment } from '../src/startup.mjs';
import { PRODUCTION_ACTIVATION } from '../src/production-policy.mjs';
import { USDC_MANIFEST, USDC_PATH } from '../src/combined.mjs';
import { fixture, input } from './fixtures.mjs';

const origin = 'https://mote.example';
const legacyFactory = () => startPausedLegacyHttp({ origin, port: 0, host: '127.0.0.1' });
const localUrl = app => `http://127.0.0.1:${app.legacy.transport.server.address().port}`;
const post = (base, path, body = input) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

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
      const manifest = await (await fetch(base + path)).json();
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

test('an invalid pause flag or live testnet USDC activation fails before opening any listener', async () => {
  const deps = { legacyFactory: () => assert.fail('listener opened') };
  await assert.rejects(startCombinedFromEnvironment({ MOTE_LEGACY_SEPOLIA_DISABLED: 'maybe' }, deps), /SEPOLIA_PAUSE_FLAG/);
  await assert.rejects(startCombinedFromEnvironment({ MOTE_LEGACY_SEPOLIA_DISABLED: 'true', MOTE_USDC_ENABLED: 'true', MOTE_USDC_ACTIVATION: 'base-sepolia-beta-v1' }, deps), /SEPOLIA_PAUSE_MAINNET_ONLY/);
});
