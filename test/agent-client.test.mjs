import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Interface } from 'ethers';
import { createEoaSigner, discoverPaidService, payAndAudit } from '../src/agent-client.mjs';
import { startPausedLegacyHttp } from '../src/legacy-sepolia-disabled.mjs';
import { startCombinedFromEnvironment } from '../src/startup.mjs';
import { USDC_MANIFEST, USDC_PATH } from '../src/combined.mjs';
import { fixture, PUBLIC_FIXTURE_PAYER } from './fixtures.mjs';

const BALANCE_ABI = new Interface(['function balanceOf(address) view returns (uint256)']);

function withBalanceRpc(chain, balanceMicroUsdc = 50000n) {
  return async (method, params) => {
    if (method === 'eth_call' && typeof params?.[0]?.data === 'string' && params[0].data.startsWith('0x70a08231')) {
      return BALANCE_ABI.encodeFunctionResult('balanceOf', [balanceMicroUsdc]);
    }
    return chain.rpc(method, params);
  };
}

async function startLocalCombined({ amount = '10000', network = 'eip155:8453' } = {}) {
  const probe = await startPausedLegacyHttp({ origin: 'https://mote.local.invalid', port: 0, host: '127.0.0.1' });
  const livePort = probe.transport.server.address().port;
  const liveOrigin = `http://127.0.0.1:${livePort}`;
  const f = fixture({ config: { origin: liveOrigin, path: USDC_PATH, network, amount }, clientBudget: '50000' });
  const app = await startCombinedFromEnvironment({ MOTE_USDC_ENABLED: 'true' }, {
    legacyFactory: async () => probe,
    usdcFactory: () => f.service,
  });
  return { app, f, origin: liveOrigin };
}

test('autonomous agent discovers via Link header, pays, polls 202 finality, verifies receipt, and recovers identically once', async () => {
  const { app, f, origin } = await startLocalCombined({ amount: '10000', network: 'eip155:8453' });
  try {
    const rpc = withBalanceRpc(f.chain, 50000n);
    const journalPath = join(f.dir, 'agent-client.sqlite');
    const events = [];
    let pollCount = 0;

    // Start with unfinalized chain so the agent must exercise 202 pending -> poll -> 200 complete
    f.chain.finalized = 79n;

    const result = await payAndAudit({
      origin,
      signer: createEoaSigner(PUBLIC_FIXTURE_PAYER),
      journalPath,
      paymentId: 'agent-e2e-payment-01',
      maxPerPayment: '10000',
      maxTotal: '20000',
      rpc,
      verifyFinality: true,
      verifyRecovery: true,
      pollIntervalMs: 1,
      maxPolls: 5,
      now: () => f.chain.now,
      sleep: async () => {
        pollCount++;
        if (pollCount >= 1) f.chain.finalized = 100n;
      },
      onEvent: (event) => events.push(event.stage),
    });

    assert.equal(result.status, 'complete');
    assert.equal(result.dryRun, false);
    assert.equal(result.finalityVerified, true);
    assert.equal(result.recoveryVerified, true);
    assert.equal(result.polls, 1);
    assert.equal(f.facilitator.settleCalls, 1);
    assert.equal(f.facilitator.verifyCalls, 1);
    assert.ok(events.includes('waiting_finality'));
    assert.ok(events.includes('recovery_verified'));

    // Separate recovery-only call from the same persisted SQLite journal must NOT sign or settle again
    const recovered = await payAndAudit({
      origin,
      signer: createEoaSigner(PUBLIC_FIXTURE_PAYER),
      journalPath,
      paymentId: 'agent-e2e-payment-01',
      maxPerPayment: '10000',
      maxTotal: '20000',
      rpc,
      recoverOnly: true,
      now: () => f.chain.now,
    });
    assert.equal(recovered.status, 'complete');
    assert.equal(recovered.fromJournal, true);
    assert.deepEqual(recovered.response, result.response);
    assert.equal(f.facilitator.settleCalls, 1);
  } finally {
    await app.close();
    f.close();
  }
});

test('autonomous agent enforces spending cap and USDC balance guardrails before signing', async () => {
  const { app, f, origin } = await startLocalCombined({ amount: '10000', network: 'eip155:8453' });
  try {
    await assert.rejects(
      payAndAudit({
        origin,
        signer: createEoaSigner(PUBLIC_FIXTURE_PAYER),
        journalPath: join(f.dir, 'cap-reject.sqlite'),
        maxPerPayment: '5000',
        maxTotal: '10000',
        rpc: withBalanceRpc(f.chain, 50000n),
        now: () => f.chain.now,
      }),
      { code: 'PRICE_EXCEEDS_MAX_PER_PAYMENT' },
    );
    assert.equal(f.facilitator.verifyCalls, 0);
    assert.equal(f.facilitator.settleCalls, 0);

    await assert.rejects(
      payAndAudit({
        origin,
        signer: createEoaSigner(PUBLIC_FIXTURE_PAYER),
        journalPath: join(f.dir, 'balance-reject.sqlite'),
        maxPerPayment: '10000',
        maxTotal: '10000',
        rpc: withBalanceRpc(f.chain, 9999n),
        now: () => f.chain.now,
      }),
      { code: 'INSUFFICIENT_USDC_BALANCE' },
    );
    assert.equal(f.facilitator.verifyCalls, 0);
    assert.equal(f.facilitator.settleCalls, 0);
  } finally {
    await app.close();
    f.close();
  }
});

test('autonomous agent dry-run discovers, fetches 402 quote, signs locally in ms, and never submits payment', async () => {
  const { app, f, origin } = await startLocalCombined({ amount: '10000', network: 'eip155:8453' });
  try {
    const dry = await payAndAudit({
      origin,
      signer: createEoaSigner(PUBLIC_FIXTURE_PAYER),
      journalPath: join(f.dir, 'dry-run.sqlite'),
      maxPerPayment: '10000',
      maxTotal: '10000',
      dryRun: true,
      now: () => f.chain.now,
    });
    assert.equal(dry.status, 'dry-run');
    assert.equal(dry.dryRun, true);
    assert.equal(dry.discovery.discoveredVia, 'link-header');
    assert.equal(dry.discovery.manifestPath, USDC_MANIFEST);
    assert.ok(dry.paymentHeaderBytes > 100);
    assert.equal(f.facilitator.verifyCalls, 0);
    assert.equal(f.facilitator.settleCalls, 0);
  } finally {
    await app.close();
    f.close();
  }
});

test('discoverPaidService falls back cleanly to /.well-known/mote-usdc.json when Link header is absent', async () => {
  const { app, f, origin } = await startLocalCombined({ amount: '10000', network: 'eip155:8453' });
  try {
    const fetchWithoutLink = async (url, init) => {
      const res = await fetch(url, init);
      if (new URL(url).pathname === '/') {
        return new Response(await res.text(), { status: res.status, headers: { 'content-type': 'application/json' } });
      }
      return res;
    };
    const found = await discoverPaidService({ origin, fetchImpl: fetchWithoutLink });
    assert.equal(found.discoveredVia, 'fallback');
    assert.equal(found.manifestPath, USDC_MANIFEST);
    assert.equal(found.config.amount, '10000');
  } finally {
    await app.close();
    f.close();
  }
});
