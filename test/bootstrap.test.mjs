import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { renameSync } from 'node:fs';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { Contract } from 'ethers';
import { createBootstrapPlan, validateBootstrapPlan } from '../src/bootstrap-plan.mjs';
import { createBootstrapRunner, createLoopbackBootstrapRunner, initializeLocalBootstrapJournal } from '../src/bootstrap-runner.mjs';
import { hashJson } from '../src/json.mjs';
import { createBootstrapHarness } from './helpers/bootstrap-harness.mjs';

test('exact eight-step budget, roles, fixed source and immutable reserve cannot be broadened by rehashing', async () => {
  const h = await createBootstrapHarness();
  try {
    assert.deepEqual(validateBootstrapPlan(h.plan), h.plan);
    assert.equal(h.plan.policy.combinedMaximumWei, '44500000000000000');
    assert.equal(h.plan.policy.operatorFeeCapWei, '35000000000000000');
    assert.equal(h.plan.policy.payerFeeCapWei, '2500000000000000');
    assert.equal(h.plan.controlledPayerWork.maximumJournalReservationWei, '3000000000000000');
    assert.equal(h.plan.roles.operator, h.plan.roles.merchant);
    assert.deepEqual(h.plan.policy.gasLimits, ['5000000','7000000','5000000','250000','250000','500000','250000','500000']);
    for (const change of [(p) => { p.transactions[4].transaction.value = '8000000000000000'; }, (p) => { p.transactions[0].transaction.maxFeePerGas = '3000000000'; },
      (p) => { p.transactions[3].transaction.data = '0x00'; }, (p) => { p.contracts.dispenser.constructorArgs[2] = '10000000001'; }]) {
      const copy = structuredClone(h.plan); change(copy); const { planHash, ...body } = copy; copy.planHash = hashJson(body);
      assert.throws(() => validateBootstrapPlan(copy), { code: 'BOOTSTRAP_PLAN' });
    }
    assert.throws(() => createBootstrapPlan({ chainId: 84532, ...h.plan.roles, operatorNonce: '0', payerNativeWei: h.plan.payerNativeWei }), { code: 'BOOTSTRAP_CHAIN' });
    assert.throws(() => createBootstrapPlan({ chainId: 11155111, ...h.plan.roles, payer: h.plan.roles.operator, operatorNonce: '0', payerNativeWei: h.plan.payerNativeWei }), { code: 'BOOTSTRAP_ROLES' });
    assert.throws(() => createBootstrapPlan({ chainId: 11155111, ...h.plan.roles, operatorNonce: '0', payerNativeWei: '2500000000000000' }), { code: 'BOOTSTRAP_BUDGET' });
  } finally { await h.close(); }
});

test('actual five-step local bootstrap is finalized once, allocates exact reserve/native amount, and recovers without a signer', async () => {
  const h = await createBootstrapHarness();
  try {
    assert.equal(await h.provider.getBalance(h.payer.address), 0n);
    const result = await h.bootstrap(); assert.equal(result.complete, true); assert.equal(result.proofs.length, 5); assert.equal(h.signCalls, 5);
    const token = new Contract(h.plan.contracts.token.address, h.plan.contracts.token.abi, h.provider);
    const dispenser = new Contract(h.plan.contracts.dispenser.address, h.plan.contracts.dispenser.abi, h.provider);
    assert.equal(await token.balanceOf(h.plan.contracts.dispenser.address), 10000000000n);
    assert.equal(await token.balanceOf(h.payer.address), 0n);
    assert.equal(await dispenser.distributed(), 0n);
    assert.equal(await h.provider.getBalance(h.payer.address), 7000000000000000n);
    assert.ok(result.proofs.every((p) => p.localOnly === true && BigInt(p.feeWei) <= BigInt(p.feeCapWei)));
    await h.reopen({ signer: undefined });
    assert.equal((await h.runner.reconcile()).complete, true); assert.equal((await h.runner.advance()).complete, true);
    assert.equal(h.signCalls, 5); assert.equal(await h.provider.getTransactionCount(h.operator.address), 5);
  } finally { await h.close(); }
});

test('public mode cannot use fixture journal and authorization is explicit, exact and never enabled by default', async () => {
  const h = await createBootstrapHarness();
  try {
    h.runner.close();
    for (const permission of [undefined, { ...h.authorization, enabled: false }, { ...h.authorization, planHash: '0x'+'11'.repeat(32) }]) {
      await assert.rejects(createLoopbackBootstrapRunner({ ...h.options, authorization: permission }), { code: 'BOOTSTRAP_AUTHORIZATION' });
    }
    await assert.rejects(createBootstrapRunner({ plan: h.plan, authorization: h.authorization, path: h.path, signer: h.signer }), { code: 'BOOTSTRAP_IDENTITY' });
    assert.equal(h.signCalls, 0);
    await h.reopen({ authorization: { ...h.authorization, expiresAt: 1 } });
    await assert.rejects(h.runner.advance(), { code: 'BOOTSTRAP_AUTHORIZATION_EXPIRED' });
    assert.equal(h.signCalls, 0); assert.equal(h.runner.status().steps[0].state, 'pending');
  } finally { await h.close(); }
});

test('authorization is checked again immediately before custody and broadcast after asynchronous work', async (t) => {
  for (const phase of ['afterIntent', 'beforeBroadcast']) {
    let clock;
    const h = await createBootstrapHarness({ hooks: { [phase]() {
      clock = t.mock.method(Date, 'now', () => (h.authorization.expiresAt + 1) * 1000);
    } } });
    try {
      await assert.rejects(h.runner.advance(), { code: 'BOOTSTRAP_AUTHORIZATION_EXPIRED' });
      assert.equal(h.signCalls, phase === 'afterIntent' ? 0 : 1);
      assert.equal(h.runner.status().steps[0].state, 'unknown');
      assert.equal(await h.provider.getTransactionCount(h.operator.address), 0);
    } finally { clock?.mock.restore(); await h.close(); }
  }
});

test('exclusive operator process gate prevents a second runner and overlapping sends', async () => {
  let unblock; const wait = new Promise((resolve) => { unblock = resolve; });
  const h = await createBootstrapHarness({ hooks: { afterIntent: () => wait } });
  try {
    await assert.rejects(createLoopbackBootstrapRunner(h.options), { code: 'BOOTSTRAP_LOCKED' });
    const active = h.runner.advance();
    // The second operation is rejected immediately, before any custody call.
    await assert.rejects(h.runner.advance(), { code: 'BOOTSTRAP_IN_FLIGHT' });
    unblock(); await active; assert.equal(h.signCalls, 1);
  } finally { unblock?.(); await h.close(); }
});

test('interruption after durable intent retains unknown authority and never re-signs without a hash', async () => {
  const h = await createBootstrapHarness({ hooks: { afterIntent() { throw new Error('fixture interruption before custody'); } } });
  try {
    await assert.rejects(h.runner.advance(), /fixture interruption/);
    assert.equal(h.runner.status().steps[0].state, 'unknown'); assert.equal(h.signCalls, 0);
    await h.reopen({ hooks: {} });
    await assert.rejects(h.runner.reconcile(), { code: 'BOOTSTRAP_UNKNOWN' });
    await assert.rejects(h.runner.advance(), { code: 'BOOTSTRAP_UNKNOWN' });
    assert.equal(h.signCalls, 0); assert.equal(await h.provider.getTransactionCount(h.operator.address), 0);
  } finally { await h.close(); }
});

test('signed hash is durable before broadcast and a lost submission response is reconciled without repetition', async () => {
  for (const phase of ['afterSigned', 'afterBroadcast']) {
    const h = await createBootstrapHarness({ hooks: { [phase]() { throw new Error('fixture response loss'); } } });
    try {
      await assert.rejects(h.runner.advance(), /fixture response loss/);
      const first = h.runner.status().steps[0]; assert.equal(first.state, 'unknown'); assert.match(first.transactionHash, /^0x[0-9a-f]{64}$/);
      assert.equal(h.signCalls, 1);
      await h.reopen({ signer: undefined, hooks: {} });
      if (phase === 'afterSigned') await assert.rejects(h.runner.reconcile(), { code: 'BOOTSTRAP_PENDING' });
      else assert.equal((await h.runner.reconcile()).steps[0].state, 'finalized');
      assert.equal(await h.provider.getTransactionCount(h.operator.address), phase === 'afterSigned' ? 0 : 1);
      assert.equal(h.signCalls, 1);
    } finally { await h.close(); }
  }
});

test('custody cannot alter an exact transaction and invalid signatures are never broadcast', async () => {
  const h = await createBootstrapHarness();
  try {
    await h.reopen({ signer: { getAddress: async () => h.operator.address,
      signTransaction: (tx) => h.operator.signTransaction({ ...tx, gasLimit: BigInt(tx.gasLimit) + 1n }) } });
    await assert.rejects(h.runner.advance(), { code: 'BOOTSTRAP_SIGNATURE' });
    assert.equal(h.runner.status().steps[0].transactionHash, null); assert.equal(h.runner.status().steps[0].state, 'unknown');
    assert.equal(await h.provider.getTransactionCount(h.operator.address), 0);
  } finally { await h.close(); }
});

test('custody methods are captured before address checks and cannot be swapped across awaits', async () => {
  const h = await createBootstrapHarness(); let originalCalls = 0, replacementCalls = 0;
  try {
    const signer = { getAddress: async () => {
      signer.signTransaction = async () => { replacementCalls++; throw new Error('unintended custody'); };
      return h.operator.address;
    }, signTransaction: async (tx) => { originalCalls++; return h.operator.signTransaction(tx); } };
    await h.reopen({ signer });
    assert.equal((await h.runner.advance()).steps[0].state, 'finalized');
    assert.equal(originalCalls, 1); assert.equal(replacementCalls, 0);
  } finally { await h.close(); }
});

test('changed historical finality anchor stops recovery and later steps without rewriting original proof', async () => {
  const h = await createBootstrapHarness({ hooks: { afterBroadcast: () => h.provider.send('evm_mine', []) } });
  try {
    await h.runner.advance();
    const saved = h.runner.status().steps[0];
    assert.ok(BigInt(saved.proof.finalized.blockNumber) > BigInt(saved.proof.blockNumber));
    await h.provider.send('evm_mine', []);
    let corruptAnchor = false;
    const reader = { endpoint: h.reader.endpoint, readOnly: true, async send(method, params) {
      const result = await h.reader.send(method, params);
      if (corruptAnchor && method === 'eth_getBlockByNumber' && params[0] === `0x${BigInt(saved.proof.finalized.blockNumber).toString(16)}`)
        return { ...result, hash: `0x${'12'.repeat(32)}` };
      return result;
    } };
    await h.reopen({ reader, signer: undefined, hooks: {} });
    await h.runner.reconcile(); assert.deepEqual(h.runner.status().steps[0], saved);
    corruptAnchor = true;
    await assert.rejects(h.runner.reconcile(), { code: 'BOOTSTRAP_REORG' });
    await assert.rejects(h.runner.advance(), { code: 'BOOTSTRAP_REORG' });
    assert.deepEqual(h.runner.status().steps[0], saved);
    assert.equal(h.signCalls, 1); assert.equal(await h.provider.getTransactionCount(h.operator.address), 1);
  } finally { await h.close(); }
});

test('RPC estimate omission, under-reported required gas, overflow and failure prevent signing', async (t) => {
  const h = await createBootstrapHarness(); const actualFetch = globalThis.fetch;
  try {
    for (const result of ['0x1', '0xffffffffff', null]) {
      const mock = t.mock.method(globalThis, 'fetch', async (url, options) => {
        const req = JSON.parse(options.body);
        if (req.method === 'eth_estimateGas') return Response.json({ jsonrpc: '2.0', id: req.id, result });
        return actualFetch(url, options);
      });
      await assert.rejects(h.runner.advance(), (error) => ['BOOTSTRAP_GAS', 'BOOTSTRAP_EVIDENCE'].includes(error.code));
      mock.mock.restore(); assert.equal(h.signCalls, 0); assert.equal(h.runner.status().steps[0].state, 'pending');
    }
  } finally { await h.close(); }
});

test('missing, replaced or corrupt durable authority never initializes or signs', async () => {
  const h = await createBootstrapHarness();
  try {
    assert.throws(() => initializeLocalBootstrapJournal({ ack: 'LOCAL_EVM_ONLY', path: h.path, plan: h.plan, genesisHash: h.genesisHash }), { code: 'BOOTSTRAP_EXISTS' });
    h.runner.close();
    const db = new DatabaseSync(h.path); db.prepare('UPDATE steps SET checksum=? WHERE idx=0').run('0x'+'00'.repeat(32)); db.close();
    await assert.rejects(h.reopen(), { code: 'BOOTSTRAP_CORRUPT' }); assert.equal(h.signCalls, 0);
    renameSync(h.path, `${h.path}.quarantined`);
    await assert.rejects(createLoopbackBootstrapRunner(h.options), { code: 'BOOTSTRAP_STORAGE' }); assert.equal(h.signCalls, 0);
  } finally { await h.close(); }
});

test('real process termination preserves intent, signed hash, broadcast and finalized commit without repeating any transaction', async () => {
  for (const phase of ['afterIntent', 'afterSigned', 'afterBroadcast', 'afterCommit']) {
    const h = await createBootstrapHarness(); let child;
    try {
      h.runner.close();
      child = fork(new URL('./helpers/bootstrap-process.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const exit = once(child, 'exit');
      const reached = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Child failed to reach ${phase}`)), 20000);
        child.once('message', (message) => { clearTimeout(timeout); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message); });
        child.once('error', (error) => { clearTimeout(timeout); reject(error); });
        child.once('exit', () => { clearTimeout(timeout); reject(new Error(`Child exited before ${phase}`)); });
      });
      child.send({ endpoint: h.reader.endpoint, plan: h.plan, authorization: h.authorization, path: h.path, genesisHash: h.genesisHash, phase });
      const marker = await reached;
      assert.equal(marker.phase, phase); assert.equal(marker.signCalls, phase === 'afterIntent' ? 0 : 1);
      await assert.rejects(createLoopbackBootstrapRunner(h.options), { code: 'BOOTSTRAP_LOCKED' });
      child.kill('SIGKILL'); await exit;
      await h.reopen({ signer: undefined });
      const stored = h.runner.status().steps[0];
      assert.equal(stored.state, { afterIntent: 'intent', afterSigned: 'signed', afterBroadcast: 'submitted', afterCommit: 'finalized' }[phase]);
      if (phase === 'afterIntent') {
        assert.equal(stored.transactionHash, null);
        await assert.rejects(h.runner.reconcile(), { code: 'BOOTSTRAP_UNKNOWN' });
        await assert.rejects(h.runner.advance(), { code: 'BOOTSTRAP_UNKNOWN' });
      } else if (phase === 'afterSigned') {
        assert.equal(stored.transactionHash, marker.transactionHash);
        await assert.rejects(h.runner.reconcile(), { code: 'BOOTSTRAP_PENDING' });
        await assert.rejects(h.runner.advance(), { code: 'BOOTSTRAP_PENDING' });
      } else {
        const first = await h.runner.reconcile(), again = await h.runner.reconcile();
        assert.equal(first.steps[0].state, 'finalized'); assert.deepEqual(again.steps[0], first.steps[0]);
        await assert.rejects(h.runner.advance(), { code: 'BOOTSTRAP_SIGNER' });
      }
      assert.equal(await h.provider.getTransactionCount(h.operator.address), ['afterBroadcast', 'afterCommit'].includes(phase) ? 1 : 0);
      assert.equal(h.signCalls, 0);
    } finally { if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); } await h.close(); }
  }
});
