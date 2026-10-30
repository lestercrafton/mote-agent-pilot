import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { id, JsonRpcProvider } from 'ethers';
import { SQLiteBudgetJournal } from '../src/journal.mjs';
import { DurableMoteClient, readChainIdentity } from '../src/durable-client.mjs';
import { createDurableHarness, runWorker, startWorker } from './helpers/durable-harness.mjs';

let harness;
let sequence = 0;
const input = { document: { fixture: 'durable-client', value: 1 } };
const unique = (prefix) => `${prefix}-${++sequence}`;

before(async () => { harness = await createDurableHarness(); });
after(async () => { await harness?.close(); });

function resultOf(child) {
  assert.equal(child.signal, null, `Unexpected child signal. ${child.stderr}`);
  assert.equal(child.exitCode, 0, child.stderr);
  assert.ok(child.result, `Missing child result. ${child.stderr}`);
  return child.result;
}
function succeeded(child) {
  const result = resultOf(child);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result;
}
function failed(child, code) {
  const result = resultOf(child);
  assert.equal(result.ok, false);
  if (code) assert.equal(result.error.code, code, JSON.stringify(result.error));
  else assert.equal(typeof result.error.message, 'string');
  return result;
}
async function withJournal(run, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mote-durable-process-'));
  const path = join(directory, 'budget.sqlite');
  const policy = { ...harness.policy, ...overrides };
  const policyId = unique('fixture-policy');
  const chainIdentity = await readChainIdentity(harness.chain.provider, policy);
  const initialized = SQLiteBudgetJournal.initialize({ path, policyId, policy, chainIdentity });
  initialized.close();
  const job = {
    path, policyId, policy, baseUrl: harness.baseUrl, rpcUrl: harness.rpcUrl,
    input, action: 'execute', quoteKey: unique('durable-quote'), orderKey: unique('durable-order'),
  };
  try { return await run(job, { directory, chainIdentity }); }
  finally { await chmod(path, 0o600).catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}
async function snapshot(job, chainIdentity) {
  const journal = new SQLiteBudgetJournal({ path: job.path, policyId: job.policyId, policy: job.policy, chainIdentity });
  try { return { budget: journal.budget(), rows: journal.list() }; }
  finally { journal.close(); }
}

async function directClient(job, chainIdentity, wrapSigner) {
  const provider = new JsonRpcProvider(job.rpcUrl, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
  provider.pollingInterval = 20;
  const fixtureSigner = await provider.getSigner(1);
  const signer = wrapSigner ? wrapSigner(fixtureSigner) : fixtureSigner;
  const journal = new SQLiteBudgetJournal({ path: job.path, policyId: job.policyId, policy: job.policy, chainIdentity });
  const client = new DurableMoteClient({ baseUrl: job.baseUrl, signer, provider, policy: job.policy, journal });
  return { client, provider, journal, close() { journal.close(); provider.destroy(); } };
}

test('active same-instance submission rejects changed offer, order key and unidentified explicit proof', async () => withJournal(async (job, { chainIdentity }) => {
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const atSend = new Promise((resolve) => { entered = resolve; });
  let pause = true;
  const direct = await directClient(job, chainIdentity, (fixtureSigner) => new Proxy(fixtureSigner, {
    get(target, property) {
      if (property === 'sendTransaction') return async (transaction) => {
        if (pause) { pause = false; entered(); await gate; }
        return target.sendTransaction(transaction);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }));
  let first;
  try {
    const offer = await direct.client.quote(job.input, job.quoteKey);
    const before = harness.sendCounts();
    first = direct.client.execute(offer, job.orderKey);
    await atSend;
    const altered = { ...offer, resultHash: id('different-promised-result') };
    await assert.rejects(direct.client.execute(altered, job.orderKey), { code: 'QUOTE_CONFLICT' });
    await assert.rejects(direct.client.execute(offer, unique('wrong-active-order')), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(direct.client.recover(altered, null, job.orderKey), { code: 'QUOTE_CONFLICT' });
    await assert.rejects(direct.client.recover(offer, null, unique('wrong-active-recovery')), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(direct.client.recover(offer, id('unidentified-active-payment'), job.orderKey), { code: 'RECOVERY_IN_FLIGHT' });
    assert.deepEqual(harness.sendCounts(), before);
    release();
    const response = await first;
    assert.equal(response.receipt.quoteId, offer.quote.quoteId);
    assert.equal(harness.sendCounts().approve - before.approve, 1);
    assert.equal(harness.sendCounts().pay - before.pay, 1);
  } finally { release(); await first?.catch(() => {}); direct.close(); }
}));

for (const hashRecorded of [true, false]) {
  test(`active recovery rejects a different proof when the original hash is ${hashRecorded ? 'recorded' : 'known only to the active recovery'}`, async () => withJournal(async (job, { chainIdentity }) => {
    let offer, paymentHash;
    if (hashRecorded) {
      const executed = succeeded(await runWorker(job));
      offer = executed.offer;
      paymentHash = executed.response.receipt.transactionHash;
    } else {
      const killed = await runWorker({ ...job, crash: { stage: 'pay', when: 'after' } });
      assert.equal(killed.signal, 'SIGKILL');
      offer = killed.messages.find((message) => message.type === 'ready').offer;
      paymentHash = killed.messages.find((message) => message.type === 'crash-point').transactionHash;
      const state = await snapshot(job, chainIdentity);
      assert.equal(state.rows[0].paymentHash, null);
    }
    const before = harness.sendCounts();
    const direct = await directClient(job, chainIdentity);
    let release, entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const atProof = new Promise((resolve) => { entered = resolve; });
    const originalReceipt = direct.provider.getTransactionReceipt.bind(direct.provider);
    let pause = true;
    direct.provider.getTransactionReceipt = async (hash) => {
      if (pause && hash.toLowerCase() === paymentHash.toLowerCase()) { pause = false; entered(); await gate; }
      return originalReceipt(hash);
    };
    let first, compatible;
    try {
      first = direct.client.recover(offer, paymentHash, job.orderKey);
      await atProof;
      await assert.rejects(direct.client.recover(offer, id('conflicting-recovery-payment'), job.orderKey), { code: 'TRANSACTION_CONFLICT' });
      compatible = direct.client.recover(offer, paymentHash, job.orderKey);
      release();
      const [a, b] = await Promise.all([first, compatible]);
      assert.deepEqual(a, b);
      assert.equal(a.receipt.transactionHash, paymentHash);
      assert.deepEqual(harness.sendCounts(), before);
    } finally {
      release(); await first?.catch(() => {}); await compatible?.catch(() => {});
      direct.provider.getTransactionReceipt = originalReceipt;
      direct.close();
    }
  }));
}

test('separate clients share a durable total budget across successful process restart', async () => {
  const price = (await harness.quote(input, unique('price-reference'))).quote.amount;
  await withJournal(async (job) => {
    const beforeBalance = await harness.chain.token.balanceOf(harness.payer);
    const first = succeeded(await runWorker(job));
    assert.equal(first.budget.tokenSpent, price);
    const afterFirstSends = harness.sendCounts();
    const second = failed(await runWorker({ ...job, quoteKey: unique('restart-quote'), orderKey: unique('restart-order') }), 'TOTAL_LIMIT');
    assert.equal(second.budget.tokenSpent, price);
    assert.deepEqual(harness.sendCounts(), afterFirstSends);
    assert.equal(await harness.chain.payments.consumed(second.offer.quote.quoteId), false);
    assert.equal(beforeBalance - await harness.chain.token.balanceOf(harness.payer), BigInt(price));
  }, { maxTotalSpend: price });
});

test('two independent processes cannot reserve or spend beyond their shared one-payment cap', async () => {
  const price = (await harness.quote(input, unique('race-price'))).quote.amount;
  await withJournal(async (job, { chainIdentity }) => {
    const beforeBalance = await harness.chain.token.balanceOf(harness.payer);
    const beforeSends = harness.sendCounts();
    const a = startWorker({ ...job, barrier: true });
    const b = startWorker({ ...job, barrier: true, quoteKey: unique('race-other-quote'), orderKey: unique('race-other-order') });
    try {
      const ready = await Promise.all([a.ready, b.ready]);
      assert.ok(ready.every((item) => item.type === 'ready'), JSON.stringify(ready));
      a.start(); b.start();
      const results = (await Promise.all([a.done, b.done])).map(resultOf);
      assert.equal(results.filter((item) => item.ok).length, 1, JSON.stringify(results.map((item) => item.error)));
      assert.equal(results.find((item) => !item.ok).error.code, 'TOTAL_LIMIT');
      const { budget } = await snapshot(job, chainIdentity);
      assert.equal(budget.tokenSpent, price);
      assert.equal(budget.tokenReserved, '0');
      assert.equal(BigInt(budget.tokenSpent) + BigInt(budget.tokenReserved), BigInt(price));
      assert.equal(beforeBalance - await harness.chain.token.balanceOf(harness.payer), BigInt(price));
      assert.equal(harness.sendCounts().approve - beforeSends.approve, 1);
      assert.equal(harness.sendCounts().pay - beforeSends.pay, 1);
    } finally { a.kill(); b.kill(); }
  }, { maxTotalSpend: price });
});

test('separate concurrent processes using the same quote settle it only once', async () => withJournal(async (job) => {
  const beforeBalance = await harness.chain.token.balanceOf(harness.payer);
  const beforeSends = harness.sendCounts();
  const a = startWorker({ ...job, barrier: true });
  const b = startWorker({ ...job, barrier: true });
  try {
    const [readyA, readyB] = await Promise.all([a.ready, b.ready]);
    assert.equal(readyA.type, 'ready'); assert.equal(readyB.type, 'ready');
    assert.equal(readyA.offer.quote.quoteId, readyB.offer.quote.quoteId);
    a.start(); b.start();
    const results = (await Promise.all([a.done, b.done])).map(resultOf);
    assert.ok(results.some((item) => item.ok), JSON.stringify(results.map((item) => item.error)));
    const sent = harness.sendCounts();
    assert.equal(sent.approve - beforeSends.approve, 1);
    assert.equal(sent.pay - beforeSends.pay, 1);
    const recovered = succeeded(await runWorker({ ...job, action: 'recover', offer: readyA.offer }));
    assert.equal(recovered.response.receipt.quoteId, readyA.offer.quote.quoteId);
    assert.deepEqual(harness.sendCounts(), sent);
    assert.equal(beforeBalance - await harness.chain.token.balanceOf(harness.payer), BigInt(readyA.offer.quote.amount));
  } finally { a.kill(); b.kill(); }
}));

for (const crash of [
  { stage: 'approve', when: 'before', sends: 0, paid: false },
  { stage: 'approve', when: 'after', sends: 1, paid: false },
  { stage: 'pay', when: 'before', sends: 1, paid: false },
  { stage: 'pay', when: 'after', sends: 2, paid: true },
]) {
  test(`SIGKILL ${crash.when} ${crash.stage} dispatch retains state and recovery never resends`, async () => withJournal(async (job, { chainIdentity }) => {
    const beforeBalance = await harness.chain.token.balanceOf(harness.payer);
    const beforeSends = harness.sendCounts();
    const killed = await runWorker({ ...job, crash });
    assert.equal(killed.signal, 'SIGKILL', JSON.stringify(killed.result ?? killed.stderr));
    const point = killed.messages.find((item) => item.type === 'crash-point');
    assert.equal(point?.stage, crash.stage);
    assert.equal(point?.when, crash.when);
    const offer = killed.messages.find((item) => item.type === 'ready').offer;
    const afterCrashSends = harness.sendCounts();
    assert.equal(afterCrashSends.total - beforeSends.total, crash.sends);
    const state = await snapshot(job, chainIdentity);
    assert.equal(state.rows.length, 1);
    assert.equal(state.budget.tokenReserved, offer.quote.amount);
    assert.ok(BigInt(state.budget.gasReservedWei) > 0n);
    const recoveredChild = await runWorker({ ...job, action: 'recover', offer });
    const recovered = crash.paid ? succeeded(recoveredChild) : failed(recoveredChild);
    assert.deepEqual(harness.sendCounts(), afterCrashSends);
    if (crash.paid) {
      assert.equal(recovered.response.receipt.quoteId, offer.quote.quoteId);
      assert.equal(recovered.budget.tokenSpent, offer.quote.amount);
      assert.equal(recovered.budget.tokenReserved, '0');
      assert.ok(BigInt(recovered.budget.gasReservedWei) > 0n, 'Unknown submission hash must retain its fee reservation');
    } else {
      assert.equal(recovered.error.doNotRepay, true);
      assert.equal(recovered.budget.tokenReserved, offer.quote.amount);
    }
    // Even with plenty of token budget left, an unresolved wallet gate must not
    // be stolen by another process, a new quote, or a normal execute retry.
    failed(await runWorker({ ...job, quoteKey: unique('blocked-new-quote'), orderKey: unique('blocked-new-order') }));
    assert.deepEqual(harness.sendCounts(), afterCrashSends);
    const retried = resultOf(await runWorker(job));
    if (crash.paid) assert.equal(retried.ok, true, JSON.stringify(retried.error));
    else assert.equal(retried.ok, false);
    assert.deepEqual(harness.sendCounts(), afterCrashSends);
    assert.equal(beforeBalance - await harness.chain.token.balanceOf(harness.payer), crash.paid ? BigInt(offer.quote.amount) : 0n);
  }));
}

for (const boundary of [
  { name: 'reservation commit', method: 'reserve', phase: 'reserved', sends: 0, paid: false },
  { name: 'approval hash persistence', method: 'markSubmitted', step: 'approval', phase: 'approval_submitted', sends: 1, paid: false },
  { name: 'payment hash persistence', method: 'markSubmitted', step: 'payment', phase: 'payment_submitted', sends: 2, paid: true },
  { name: 'settlement accounting commit before delivery', method: 'recordPayment', phase: 'settled', sends: 2, paid: true },
]) {
  test(`SIGKILL after ${boundary.name} recovers committed evidence without resubmission or duplicate fees`, async () => withJournal(async (job, { chainIdentity }) => {
    const beforeSends = harness.sendCounts();
    const beforeBalance = await harness.chain.token.balanceOf(harness.payer);
    const killed = await runWorker({ ...job, crashJournal: { method: boundary.method, step: boundary.step } });
    assert.equal(killed.signal, 'SIGKILL', JSON.stringify(killed.result ?? killed.stderr));
    const offer = killed.messages.find((message) => message.type === 'ready').offer;
    const afterCrashSends = harness.sendCounts();
    assert.equal(afterCrashSends.total - beforeSends.total, boundary.sends);
    const beforeRecovery = await snapshot(job, chainIdentity);
    const row = beforeRecovery.rows[0];
    assert.equal(row.phase, boundary.phase);
    assert.equal(row.response, null);
    assert.equal(await harness.chain.payments.consumed(offer.quote.quoteId), boundary.paid);
    const cap = BigInt(job.policy.maxGasPerTransactionWei);
    const receiptFee = async (hash) => {
      if (!hash) return 0n;
      const receipt = await harness.chain.provider.getTransactionReceipt(hash);
      assert.equal(receipt.status, 1);
      return receipt.fee ?? receipt.gasUsed * receipt.gasPrice;
    };
    const approvalFee = await receiptFee(row.approvalHash);
    const paymentFee = await receiptFee(row.paymentHash);
    if (boundary.method === 'reserve') {
      assert.equal(row.approvalIntent, null);
      assert.equal(row.paymentIntent, null);
      assert.equal(row.approvalHash, null);
      assert.equal(row.paymentHash, null);
      assert.equal(beforeRecovery.budget.gasReservedWei, String(cap * 2n));
      assert.equal(beforeRecovery.budget.gasSpentWei, '0');
    } else if (boundary.step === 'approval') {
      assert.ok(row.approvalHash);
      assert.equal(row.approvalProof, null);
      assert.equal(row.paymentIntent, null);
      assert.equal(beforeRecovery.budget.gasSpentWei, '0');
    } else if (boundary.step === 'payment') {
      assert.ok(row.approvalProof?.success);
      assert.ok(row.paymentHash);
      assert.equal(row.paymentProof, null);
      assert.equal(beforeRecovery.budget.gasSpentWei, String(approvalFee));
    } else {
      assert.ok(row.paymentProof?.success);
      assert.equal(beforeRecovery.budget.tokenSpent, offer.quote.amount);
      assert.equal(beforeRecovery.budget.tokenReserved, '0');
      assert.equal(beforeRecovery.budget.gasReservedWei, '0');
      assert.equal(beforeRecovery.budget.gasSpentWei, String(approvalFee + paymentFee));
      assert.equal((await harness.service.order(offer.quote.quoteId)).status, 'awaiting_payment');
    }
    const recoveredChild = await runWorker({ ...job, action: 'recover', offer });
    const recovered = boundary.paid ? succeeded(recoveredChild) : failed(recoveredChild);
    const expectedSpentGas = approvalFee + paymentFee;
    assert.equal(recovered.budget.gasSpentWei, String(expectedSpentGas));
    assert.equal(recovered.budget.tokenSpent, boundary.paid ? offer.quote.amount : '0');
    assert.equal(recovered.budget.tokenReserved, boundary.paid ? '0' : offer.quote.amount);
    assert.equal(recovered.budget.gasReservedWei, boundary.paid ? '0' : String(boundary.sends === 0 ? cap * 2n : cap));
    assert.deepEqual(harness.sendCounts(), afterCrashSends);
    if (boundary.paid) assert.equal(recovered.response.receipt.transactionHash, row.paymentHash);
    else assert.equal(recovered.error.doNotRepay, true);

    // Reopening again and repeating both recovery and ordinary execute must
    // account the original receipts exactly once, never resume a stopped send.
    const recoveredAgain = resultOf(await runWorker({ ...job, action: 'recover', offer }));
    const executedAgain = resultOf(await runWorker(job));
    assert.equal(recoveredAgain.ok, boundary.paid);
    assert.equal(executedAgain.ok, boundary.paid);
    assert.deepEqual(recoveredAgain.budget, recovered.budget);
    assert.deepEqual(executedAgain.budget, recovered.budget);
    if (boundary.paid) assert.deepEqual(recoveredAgain.response, recovered.response);
    assert.deepEqual(harness.sendCounts(), afterCrashSends);
    assert.equal(beforeBalance - await harness.chain.token.balanceOf(harness.payer), boundary.paid ? BigInt(offer.quote.amount) : 0n);

    if (!boundary.paid) {
      failed(await runWorker({ ...job, quoteKey: unique('reserved-blocked-quote'), orderKey: unique('reserved-blocked-order') }), 'WALLET_BUSY');
      assert.deepEqual(harness.sendCounts(), afterCrashSends);
    }
    if (boundary.method === 'reserve') {
      // Explicit cancellation is only safe while no send intent ever existed;
      // it leaves a tombstone and cannot turn an old execute into permission.
      const journal = new SQLiteBudgetJournal({ path: job.path, policyId: job.policyId, policy: job.policy, chainIdentity });
      try {
        const cancelled = journal.cancelReserved(offer.quote.quoteId);
        assert.equal(cancelled.phase, 'cancelled');
        assert.equal(journal.budget().tokenReserved, '0');
        assert.equal(journal.budget().gasReservedWei, '0');
      } finally { journal.close(); }
      failed(await runWorker(job), 'ATTEMPT_CANCELLED');
      failed(await runWorker({ ...job, action: 'recover', offer }), 'ATTEMPT_CANCELLED');
      assert.deepEqual(harness.sendCounts(), afterCrashSends);
    }
  }));
}

test('a dropped committed delivery response is recovered after process restart without any send', async () => withJournal(async (job) => {
  const beforeBalance = await harness.chain.token.balanceOf(harness.payer);
  harness.dropNextOrderResponse();
  const dropped = failed(await runWorker(job));
  assert.equal(dropped.error.doNotRepay, true);
  assert.equal(dropped.budget.tokenSpent, dropped.offer.quote.amount);
  const sent = harness.sendCounts();
  const recovered = succeeded(await runWorker({ ...job, action: 'recover', offer: dropped.offer }));
  assert.equal(recovered.response.receipt.quoteId, dropped.offer.quote.quoteId);
  assert.equal(recovered.budget.tokenSpent, dropped.offer.quote.amount);
  assert.deepEqual(harness.sendCounts(), sent);
  assert.equal(beforeBalance - await harness.chain.token.balanceOf(harness.payer), BigInt(dropped.offer.quote.amount));
}));

test('changed policy ID or policy contents cannot reset an existing journal budget', async () => withJournal(async (job) => {
  const before = harness.sendCounts();
  failed(await runWorker({ ...job, policyId: `${job.policyId}-different` }), 'JOURNAL_IDENTITY_MISMATCH');
  failed(await runWorker({ ...job, policy: { ...job.policy, maxTotalSpend: String(BigInt(job.policy.maxTotalSpend) + 1n) } }), 'JOURNAL_IDENTITY_MISMATCH');
  assert.deepEqual(harness.sendCounts(), before);
}));

for (const mode of ['missing', 'corrupt', 'readonly']) {
  test(`${mode} persistent state fails closed before approvals or payments`, async () => withJournal(async (job) => {
    if (mode === 'missing') await rm(job.path);
    if (mode === 'corrupt') await writeFile(job.path, 'not a SQLite database; synthetic corruption fixture');
    if (mode === 'readonly') await chmod(job.path, 0o444);
    const before = harness.sendCounts();
    const result = failed(await runWorker(job));
    assert.ok(['JOURNAL_MISSING', 'JOURNAL_CORRUPT', 'JOURNAL_UNAVAILABLE', 'JOURNAL_FILE_CHANGED'].includes(result.error.code), JSON.stringify(result.error));
    assert.deepEqual(harness.sendCounts(), before);
  }));
}

for (const mode of ['missing', 'readonly']) {
  test(`journal becoming ${mode} after client startup blocks the first broadcast`, async () => withJournal(async (job) => {
    const before = harness.sendCounts();
    const child = startWorker({ ...job, barrier: true });
    try {
      const ready = await child.ready;
      assert.equal(ready.type, 'ready', JSON.stringify(ready));
      if (mode === 'missing') await rm(job.path);
      else await chmod(job.path, 0o444);
      child.start();
      const result = failed(await child.done);
      assert.ok(['JOURNAL_MISSING', 'JOURNAL_UNAVAILABLE', 'JOURNAL_FILE_CHANGED'].includes(result.error.code), JSON.stringify(result.error));
      assert.deepEqual(harness.sendCounts(), before);
    } finally { child.kill(); }
  }));
}

test('recovery of an untracked offer cannot create a fresh budget or send a transaction', async () => withJournal(async (job) => {
  const offer = await harness.quote(input, unique('untracked-offer'));
  const before = harness.sendCounts();
  failed(await runWorker({ ...job, action: 'recover', offer }));
  assert.deepEqual(harness.sendCounts(), before);
}));
