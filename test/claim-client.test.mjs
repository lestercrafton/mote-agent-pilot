import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, unlinkSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ClaimThenPayClient } from '../src/claim-client.mjs';
import { ClaimBudgetJournal, CLAIM_CALLDATA } from '../src/claim-journal.mjs';
import { prepareAudit } from '../src/json.mjs';
import { createClaimHarness, startClaimWorker } from './helpers/claim-harness.mjs';

const input = { document: { operation: 'controlled-local-onboarding', quantity: 2 }, schema: { type: 'object', properties: { quantity: { type: 'integer', minimum: 1 } } } };
const request = key => ({ operationKey: key, publicSynthetic: true });
async function fixture(t) { const h = await createClaimHarness(); t.after(() => h.close()); return h; }
const nonce = async h => BigInt(await h.provider.send('eth_getTransactionCount', [h.policy.payer, 'pending']));
const wrapper = (h, send) => ({ provider: h.claimant.provider, getAddress: () => h.claimant.getAddress(), sendTransaction: send });
const reopen = (h, f, extra = {}) => h.openClaimClient({ options: f.options, paymentOptions: f.paymentOptions, signer: undefined, ...extra });

test('fresh zero-MOTE payer automatically claims then pays with exact native caps and one durable fee total', async t => {
  const h = await fixture(t), f = h.makeClaimClient();
  assert.equal(await h.token.balanceOf(h.policy.payer), 0n);
  assert.throws(() => new ClaimThenPayClient({ journal: f.journal, paymentClient: f.paymentClient, dispenserChain: h.dispenserChain, signer: h.claimant }), { code: 'CLAIM_CHAIN_DENIED' });
  const before = await nonce(h), first = f.client.claimThenExecute(input, request('onboarding-success'));
  const repeated = f.client.claimThenExecute(input, request('onboarding-success'));
  assert.equal(first, repeated);
  const result = await first;
  assert.equal(result.result.valid, true); assert.equal((await nonce(h)) - before, 3n);
  const claim = f.journal.claim(), row = f.paymentJournal.read(result.receipt.quoteId);
  assert.equal(claim.intent.data, CLAIM_CALLDATA); assert.equal(claim.intent.gasLimit, '500000');
  assert.equal(row.approvalIntent.gasLimit, '250000'); assert.equal(row.paymentIntent.gasLimit, '500000');
  assert.equal(claim.intent.maxFeePerGas, '2000000000'); assert.equal(f.journal.read('onboarding-success').phase, 'complete');
  const receipts = await Promise.all([claim.transactionHash, row.approvalHash, row.paymentHash].map(hash => h.provider.send('eth_getTransactionReceipt', [hash])));
  const spent = receipts.reduce((sum, r) => sum + BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice), 0n);
  assert.equal(f.client.budget.totalSpentWei, spent.toString()); assert.equal(f.client.budget.totalReservedWei, '0');
  assert.ok(spent <= 3000000000000000n);
  assert.equal(await h.token.balanceOf(h.policy.payer), 10000000n - BigInt(result.receipt.amount));
  const recovered = await reopen(h, f).client.recover('onboarding-success'); assert.deepEqual(recovered, result); assert.equal((await nonce(h)) - before, 3n);
  await assert.rejects(f.client.claimThenExecute({ document: 'changed' }, request('onboarding-success')), { code: 'CLAIM_OPERATION_CONFLICT' });
  await assert.rejects(f.client.claimThenExecute(input, request('onboarding-next-task')), { code: 'GAS_TOTAL_LIMIT' });
  assert.equal(f.client.budget.totalSpentWei, spent.toString()); assert.equal((await nonce(h)) - before, 3n);
});

test('lost real HTTP result recovers after restart without a signer or second payment', async t => {
  const h = await fixture(t); let dropped = false;
  const f = h.makeClaimClient({ fetchImpl: async (url, options) => { const response = await fetch(url, options); if (url.endsWith('/v1/orders') && !dropped) { dropped = true; await response.text(); throw new Error('controlled response loss after service commit'); } return response; } });
  const before = await nonce(h);
  await assert.rejects(f.client.claimThenExecute(input, request('onboarding-lost-result')), e => e.doNotRepay && e.settlementState === 'finalized');
  const prior = f.client.budget; f.journal.close(); f.paymentJournal.close();
  const again = reopen(h, f), result = await again.client.recover('onboarding-lost-result');
  assert.equal(result.result.valid, true); assert.equal((await nonce(h)) - before, 3n); assert.deepEqual(again.client.budget, prior);
  await assert.rejects(again.client.recover('onboarding-lost-result', { originalInput: { document: 7 }, publicSynthetic: true }), { code: 'CLAIM_OPERATION_CONFLICT' });
});

test('crash before claim broadcast keeps intent, reservation and gate across restart', async t => {
  const h = await fixture(t); let sends = 0;
  const f = h.makeClaimClient({ signer: wrapper(h, async () => { sends++; throw new Error('controlled crash before RPC'); }) });
  const before = await nonce(h);
  await assert.rejects(f.client.claimThenExecute(input, request('claim-crash-before')), { code: 'CLAIM_STATE_UNKNOWN' });
  assert.equal(f.journal.claim().phase, 'unknown'); assert.equal(f.journal.claim().transactionHash, null);
  assert.equal(f.client.budget.claimReservedWei, '1000000000000000');
  const again = reopen(h, f);
  await assert.rejects(again.client.recover('claim-crash-before'), { code: 'CLAIM_STATE_UNKNOWN' });
  await assert.rejects(again.client.claimThenExecute(input, request('claim-new-key-denied')), { code: 'CLAIM_WALLET_BUSY' });
  assert.equal(sends, 1); assert.equal(await nonce(h), before);
});

test('lost claim broadcast response cannot use claimed=true to erase original uncertain authority', async t => {
  const h = await fixture(t); let sends = 0;
  const f = h.makeClaimClient({ signer: wrapper(h, async tx => { sends++; const sent = await h.claimant.sendTransaction(tx); await sent.wait(); throw new Error('controlled lost original hash'); }) });
  const before = await nonce(h);
  await assert.rejects(f.client.claimThenExecute(input, request('claim-crash-after')), { code: 'CLAIM_STATE_UNKNOWN' });
  assert.equal((await h.dispenserChain.inspectClaim({ payer: h.policy.payer })).claimed, true);
  const again = reopen(h, f); await assert.rejects(again.client.recover('claim-crash-after'), { code: 'CLAIM_STATE_UNKNOWN' });
  assert.equal(again.client.budget.claimReservedWei, '1000000000000000'); assert.equal(again.client.budget.claimSpentWei, '0');
  assert.equal((await nonce(h)) - before, 1n); assert.equal(sends, 1);
});

test('known claim hash finality timeout reconciles read-only; a new task can pay without claiming twice', async t => {
  const h = await fixture(t); let claimHash, hide = true, sends = 0;
  const reader = { ...h.reader, async send(method, args) { if (method === 'eth_getTransactionReceipt' && args[0] === claimHash && hide) return null; return h.reader.send(method, args); } };
  const f = h.makeClaimClient({ reader, signer: wrapper(h, async tx => { sends++; const sent = await h.claimant.sendTransaction(tx); claimHash = sent.hash; return sent; }) });
  const before = await nonce(h);
  await assert.rejects(f.client.claimThenExecute(input, request('claim-known-timeout')), { code: 'CLAIM_STATE_UNKNOWN' });
  assert.equal(f.journal.claim().transactionHash, claimHash); hide = false;
  const again = reopen(h, f), recovered = await again.client.recover('claim-known-timeout');
  assert.equal(recovered.status, 'claim_finalized_no_payment'); assert.equal((await nonce(h)) - before, 1n); assert.equal(sends, 1);
  const ready = reopen(h, f, { signer: h.claimant });
  const result = await ready.client.claimThenExecute(input, request('after-readonly-recovery'));
  assert.equal(result.result.valid, true); assert.equal((await nonce(h)) - before, 3n); assert.equal(ready.journal.claim().transactionHash, claimHash);
});

test('bounded original-owner finality polling never repeats claim send', async t => {
  const h = await fixture(t); let claimHash, hidden = 0, sends = 0;
  const reader = { ...h.reader, async send(method, args) { if (method === 'eth_getTransactionReceipt' && args[0] === claimHash && hidden++ < 2) return null; return h.reader.send(method, args); } };
  const f = h.makeClaimClient({ reader, finalityWaitMs: 2000, signer: wrapper(h, async tx => { sends++; const sent = await h.claimant.sendTransaction(tx); if (tx.data === CLAIM_CALLDATA) claimHash = sent.hash; return sent; }) });
  const result = await f.client.claimThenExecute(input, request('claim-finality-wait'));
  assert.equal(result.result.valid, true); assert.equal(sends, 3); assert.ok(hidden >= 3);
});

test('preexisting canonical claim is inspection-only and sends only approval/payment', async t => {
  const h = await fixture(t);
  await (await h.dispenser.claim({ type: 2, gasLimit: 500000n, maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n })).wait();
  const f = h.makeClaimClient(), before = await nonce(h);
  const result = await f.client.claimThenExecute(input, request('preexisting-claim'));
  assert.equal(result.result.valid, true); assert.equal((await nonce(h)) - before, 2n);
  assert.equal(f.journal.claim().phase, 'preexisting'); assert.equal(f.client.budget.claimSpentWei, '0');
});

test('unknown payment keeps both journals gated and claim fees counted; recovery calls no signer', async t => {
  const h = await fixture(t); let sends = 0;
  const f = h.makeClaimClient({ signer: wrapper(h, async tx => { sends++; if (tx.to.toLowerCase() === h.policy.dispenser) return h.claimant.sendTransaction(tx); if (tx.to.toLowerCase() === h.policy.payer) throw new Error('unexpected'); if (sends === 2) throw new Error('controlled crash before approval broadcast'); return h.claimant.sendTransaction(tx); }) });
  await assert.rejects(f.client.claimThenExecute(input, request('unknown-payment')), { code: 'PAYMENT_STATE_UNKNOWN' });
  assert.equal(f.journal.claim().phase, 'confirmed'); assert.equal(f.client.budget.paymentReservedWei, '2000000000000000');
  const before = f.client.budget, again = reopen(h, f);
  await assert.rejects(again.client.recover('unknown-payment'), { code: 'PAYMENT_STATE_UNKNOWN' });
  await assert.rejects(again.client.claimThenExecute(input, request('unknown-blocks-new')), { code: 'CLAIM_WALLET_BUSY' });
  assert.deepEqual(again.client.budget, before); assert.equal(sends, 2);
});

test('two independent processes share the same non-expiring claim/payment wallet gate', async t => {
  const h = await fixture(t), f = h.makeClaimClient();
  const job = { rpcUrl: h.rpcUrl, localServiceOrigin: h.localServiceOrigin, baseUrl: h.baseUrl, config: h.config, dispenserConfig: h.dispenserConfig, payerAddress: h.policy.payer, options: f.options, paymentOptions: f.paymentOptions, input };
  const before = await nonce(h), first = startClaimWorker({ ...job, operationKey: 'process-first-owner', pauseClaim: true });
  await new Promise((resolve, reject) => { first.child.once('message', resolve); first.child.once('error', reject); first.child.once('exit', () => reject(new Error('worker exited before gate test'))); });
  const second = await startClaimWorker({ ...job, operationKey: 'process-other-owner' }).done;
  assert.equal(second.ok, false); assert.equal(second.error.code, 'CLAIM_WALLET_BUSY');
  first.child.send({ resume: true }); const completed = await first.done;
  assert.equal(completed.ok, true, JSON.stringify(completed)); assert.equal((await nonce(h)) - before, 3n);
  const recovered = await startClaimWorker({ ...job, operationKey: 'process-first-owner', recover: true }).done;
  assert.equal(recovered.ok, true, JSON.stringify(recovered)); assert.deepEqual(recovered.result, completed.result); assert.equal((await nonce(h)) - before, 3n);
});

test('identity, unsafe calldata, separate allocation expansion and secret fields fail before signer use', async t => {
  const h = await fixture(t), f = h.makeClaimClient(), options = { ...f.options, dispenserIdentity: h.dispenserChain.identity, paymentJournal: f.paymentJournal };
  assert.throws(() => ClaimBudgetJournal.initialize(options), { code: 'CLAIM_JOURNAL_EXISTS' });
  for (const changed of [{ policyId: 'another-policy-id' }, { policy: { ...f.options.policy, maxTotalGasWei: '4000000000000000' } }, { dispenserIdentity: { ...h.dispenserChain.identity, runtimeCodeHash: '0x' + '11'.repeat(32) } }]) assert.throws(() => new ClaimBudgetJournal({ ...options, ...changed }), { code: 'CLAIM_IDENTITY_MISMATCH' });
  assert.throws(() => ClaimBudgetJournal.initialize({ ...options, path: join(h.directory, 'secret.sqlite'), policy: { ...f.options.policy, privateKey: 'forbidden-public-placeholder' } }), { code: 'CLAIM_INPUT_INVALID' });
  assert.throws(() => ClaimBudgetJournal.initialize({ ...options, path: join(h.directory, 'expanded.sqlite'), policy: { ...f.options.policy, maxPaymentGasWei: '3000000000000000' } }), { code: 'CLAIM_BUDGET_INVALID' });
  const p = prepareAudit(input); f.journal.acquire({ key: 'malformed-claim-intent', requestHash: p.requestHash, resultHash: p.resultHash });
  const tx = { type: 2, chainId: 11155111, from: h.policy.payer, to: h.policy.dispenser, nonce: '0', value: '0', data: CLAIM_CALLDATA, gasLimit: '500000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000' };
  for (const bad of [{ ...tx, data: '0x' }, { ...tx, to: h.policy.payer }, { ...tx, value: '1' }, { ...tx, chainId: 84532 }, { ...tx, gasLimit: '500001' }]) assert.throws(() => f.journal.beginClaim('malformed-claim-intent', bad));
  assert.equal(f.journal.claim().phase, 'none'); assert.equal(await nonce(h), 0n);
});

test('disabled policy and insufficient total allocation cannot trigger claims', async t => {
  const h = await fixture(t), f = h.makeClaimClient({ policy: { enabled: false } });
  await assert.rejects(f.client.claimThenExecute(input, request('disabled-onboarding')), { code: 'SPENDING_DISABLED' });
  assert.throws(() => h.makeClaimClient({ policy: { maxClaimGasWei: '999' } }), { code: 'CLAIM_BUDGET_INVALID' });
  assert.equal(await nonce(h), 0n); assert.equal(f.journal.claim().phase, 'none');
});

test('missing/read-only/corrupt/replaced/hardlinked authority files fail closed', async t => {
  const h = await fixture(t), f = h.makeClaimClient();
  const options = { ...f.options, dispenserIdentity: h.dispenserChain.identity, paymentJournal: f.paymentJournal };
  assert.throws(() => new ClaimBudgetJournal({ ...options, path: join(h.directory, 'absent.sqlite') }), { code: 'CLAIM_JOURNAL_UNAVAILABLE' });
  chmodSync(f.options.path, 0o400); assert.throws(() => f.journal.budget(), { code: 'CLAIM_JOURNAL_UNAVAILABLE' }); chmodSync(f.options.path, 0o600);
  const alias = join(h.directory, 'hardlink.sqlite'); linkSync(f.options.path, alias); assert.throws(() => f.journal.budget(), { code: 'CLAIM_JOURNAL_UNAVAILABLE' }); unlinkSync(alias);
  const db = new DatabaseSync(f.options.path); db.prepare('UPDATE state SET data=? WHERE id=1').run('{}'); db.close(); assert.throws(() => f.journal.budget(), { code: 'CLAIM_JOURNAL_CORRUPT' });
  const second = h.makeClaimClient(); renameSync(second.options.path, `${second.options.path}.old`); writeFileSync(second.options.path, 'SQLite format 3\0'); assert.throws(() => second.journal.budget(), { code: 'CLAIM_JOURNAL_FILE_CHANGED' });
  const third = h.makeClaimClient(); unlinkSync(third.paymentOptions.path); assert.throws(() => third.journal.budget(), { code: 'CLAIM_JOURNAL_UNAVAILABLE' });
  assert.equal(await nonce(h), 0n);
});

test('finalized reverted claim records its fee once and never retries or increases gas', async t => {
  const h = await fixture(t), f = h.makeClaimClient({ policy: { claimGasLimit: '30000' } }), before = await nonce(h);
  await assert.rejects(f.client.claimThenExecute(input, request('claim-bounded-revert')), { code: 'CLAIM_REVERTED' });
  const claim = f.journal.claim(); assert.equal(claim.phase, 'failed'); assert.equal(claim.proof.success, false);
  assert.ok(BigInt(f.client.budget.claimSpentWei) > 0n); assert.equal(f.client.budget.totalReservedWei, '0');
  assert.equal((await nonce(h)) - before, 1n); assert.equal(await h.token.balanceOf(h.policy.payer), 0n);
  const again = reopen(h, f); await assert.rejects(again.client.recover('claim-bounded-revert'), { code: 'CLAIM_REVERTED' });
  await assert.rejects(again.client.claimThenExecute(input, request('no-retry-after-revert')), { code: 'CLAIM_STATE_UNKNOWN' });
  assert.equal((await nonce(h)) - before, 1n); assert.deepEqual(again.client.budget, f.client.budget);
});

test('read-only claim reconciliation fences a paused original owner before any payment can be sent', async t => {
  const h = await fixture(t); let signal, release;
  const reached = new Promise(resolve => signal = resolve), resume = new Promise(resolve => release = resolve);
  const dispenserChain = { ...h.dispenserChain, async verifyClaim(args) { const proof = await h.dispenserChain.verifyClaim(args); signal(); await resume; return proof; } };
  const f = h.makeClaimClient({ dispenserChain }), before = await nonce(h);
  const original = f.client.claimThenExecute(input, request('paused-original-owner')); original.catch(() => {});
  await reached;
  const other = reopen(h, f), recovered = await other.client.recover('paused-original-owner');
  assert.equal(recovered.status, 'claim_finalized_no_payment');
  const next = reopen(h, f, { signer: h.claimant });
  const result = await next.client.claimThenExecute(input, request('new-operation-after-proof'));
  assert.equal(result.result.valid, true); release();
  await assert.rejects(original, { code: 'CLAIM_OWNER_MISMATCH' });
  assert.equal((await nonce(h)) - before, 3n);
});

test('empty/exhausted public dispenser eligibility does not trigger a claim or payment', async t => {
  const h = await createClaimHarness({ distributionCap: '10000000' }); t.after(() => h.close());
  await (await h.dispenser.connect(h.operator).claim({ type: 2, gasLimit: 500000n, maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n })).wait();
  const f = h.makeClaimClient(), before = await nonce(h);
  await assert.rejects(f.client.claimThenExecute(input, request('dispenser-exhausted')), { code: 'CLAIM_UNAVAILABLE' });
  assert.equal(await nonce(h), before); assert.equal(f.journal.claim().phase, 'none'); assert.equal(f.client.budget.totalSpentWei, '0');
});

test('recovery cannot end a payment handoff while its inner reservation has not yet been written', async t => {
  const h = await fixture(t), f = h.makeClaimClient(); let signal, release;
  const reached = new Promise(resolve => signal = resolve), resume = new Promise(resolve => release = resolve);
  const execute = f.paymentClient.execute.bind(f.paymentClient);
  f.paymentClient.execute = async (...args) => { signal(); await resume; return execute(...args); };
  const original = f.client.claimThenExecute(input, request('paused-payment-handoff')); original.catch(() => {});
  await reached;
  const op = f.journal.read('paused-payment-handoff'); assert.ok(op.quoteId); assert.equal(f.paymentJournal.read(op.quoteId), null);
  const other = reopen(h, f);
  await assert.rejects(other.client.recover('paused-payment-handoff'), { code: 'CLAIM_STATE_UNKNOWN' });
  await assert.rejects(other.client.claimThenExecute(input, request('cannot-overtake-handoff')), { code: 'CLAIM_WALLET_BUSY' });
  release(); const result = await original; assert.equal(result.result.valid, true); assert.equal(await nonce(h), 3n);
  assert.equal(f.journal.read('paused-payment-handoff').phase, 'complete');
});

test('unexpected SQLite triggers or views fail closed before authorization', async t => {
  const h = await fixture(t), f = h.makeClaimClient();
  const db = new DatabaseSync(f.options.path); db.exec('CREATE VIEW unexpected AS SELECT * FROM state'); db.close();
  assert.throws(() => f.journal.budget(), { code: 'CLAIM_JOURNAL_CORRUPT' }); assert.equal(await nonce(h), 0n);
});

test('recovery cannot transfer a live owner after inner reservation but before its first approval intent', async t => {
  const h = await fixture(t); let signal, release, f;
  const reached = new Promise(resolve => signal = resolve), resume = new Promise(resolve => release = resolve);
  const signer = { provider: h.claimant.provider, async getAddress() {
    if (f?.paymentJournal.list().some(row => row.phase === 'reserved')) { signal(); await resume; }
    return h.claimant.getAddress();
  }, sendTransaction: tx => h.claimant.sendTransaction(tx) };
  f = h.makeClaimClient({ signer });
  const original = f.client.claimThenExecute(input, request('paused-inner-reservation')); original.catch(() => {});
  await reached;
  const other = reopen(h, f);
  await assert.rejects(other.client.recover('paused-inner-reservation'), { code: 'PAYMENT_STATE_UNKNOWN' });
  await assert.rejects(other.client.claimThenExecute(input, request('no-reservation-takeover')), { code: 'CLAIM_WALLET_BUSY' });
  release(); const result = await original; assert.equal(result.result.valid, true); assert.equal(await nonce(h), 3n);
  assert.equal(f.journal.read('paused-inner-reservation').phase, 'complete');
});

test('unexpected reported canonical fee overrun is counted permanently and denies continuation', async t => {
  // Synthetic ledger proof only; actualEthereumFees rejects an impossible
  // ordinary type-2 overrun. The journal must not hide supplied accounting.
  const h = await fixture(t), f = h.makeClaimClient(), prepared = prepareAudit(input);
  const key = 'account-overrun-conservatively';
  f.journal.acquire({ key, requestHash: prepared.requestHash, resultHash: prepared.resultHash });
  const intent = { type: 2, chainId: 11155111, from: h.policy.payer, to: h.policy.dispenser, nonce: '0', value: '0', data: CLAIM_CALLDATA, gasLimit: '500000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000' };
  f.journal.beginClaim(key, intent); const hash = '0x' + '11'.repeat(32); f.journal.submittedClaim(key, hash);
  const proof = { transactionHash: hash, feeWei: '1000000000000001', success: true, blockNumber: '1', blockHash: '0x' + '22'.repeat(32), transaction: intent, claimEvidenceHash: '0x' + '33'.repeat(32) };
  f.journal.recordClaim(proof); f.journal.recordClaim(proof);
  assert.equal(f.client.budget.claimSpentWei, proof.feeWei);
  const offer = await f.paymentClient.quote(input, 'overrun-fixture-quote', { publicSynthetic: true });
  assert.throws(() => f.journal.bindQuote(key, offer), { code: 'CLAIM_NOT_FINALIZED' });
  assert.equal(await nonce(h), 0n); assert.equal(f.client.budget.claimSpentWei, proof.feeWei);
});
