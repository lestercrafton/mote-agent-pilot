import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { TestnetMoteClient } from '../src/testnet-client.mjs';
import { FixtureTestnetMoteClient, clientFixture } from './helpers/testnet-client-fixture.mjs';
const input = { document: { z: 3, a: 'public synthetic fixture' }, schema: { type: 'object', required: ['z'], properties: { z: { type: 'integer' } } } };
const quote = client => client.quote(input, 'quote-test-0001', { publicSynthetic: true });
const noSigner = { getAddress() { throw new Error('RECOVERY CALLED SIGNER'); }, sendTransaction() { throw new Error('RECOVERY SENT TRANSACTION'); } };
test('public constructor pins HTTPS/Base deployment; ordinary execution refuses fees before any signer call', async (t) => {
    const f = await clientFixture(t), client = new TestnetMoteClient(f.clientOptions);
    assert.equal((await client.discover()).testOnly, true);
    const offer = await quote(client);
    await assert.rejects(client.execute(offer, 'order-test-0001'), { code: 'BASE_TOTAL_FEE_CAP_UNENFORCEABLE' });
    assert.equal(f.state.signerCalls, 0);
    assert.equal(f.state.sends.length, 0);
    assert.equal(f.journal.list().length, 0);
    for (const change of [{ baseUrl: 'http://127.0.0.1:1234' }, { baseUrl: 'https://other.example' }, { chain: { ...f.chain, config: { ...f.chain.config, mode: 'local-fixture' } } }, { policy: { ...f.policy, chainId: 8453 } }])
        assert.throws(() => new TestnetMoteClient({ ...f.clientOptions, ...change }));
});
test('quotes require public synthetic acknowledgment and authenticate metadata/request before remembering an offer', async (t) => {
    const f = await clientFixture(t);
    await assert.rejects(f.client.quote(input, 'quote-test-0001'), { code: 'PUBLIC_SYNTHETIC_REQUIRED' });
    const offer = await quote(f.client), changed = structuredClone(offer);
    changed.quote.amount = '1';
    await assert.rejects(f.client.execute(changed, 'order-test-0001'));
    assert.equal(f.state.sends.length, 0);
    assert.equal(f.journal.list().length, 0);
});
test('controlled RPC fixture completes useful work automatically with exact durable approval/payment and total fees', async (t) => {
    const f = await clientFixture(t), offer = await quote(f.client), result = await f.client.execute(offer, 'order-test-0001');
    assert.equal(result.result.valid, true);
    assert.equal(result.result.canonicalJson, '{"a":"public synthetic fixture","z":3}');
    assert.deepEqual(f.state.sends.map(s => s.step), ['approval', 'payment']);
    const row = f.journal.read(offer.quote.quoteId);
    assert.equal(row.phase, 'complete');
    assert.equal(f.journal.budget().tokenSpent, offer.quote.amount);
    assert.equal(f.journal.budget().gasSpentWei, String(21001 * 13 + 31 + 50000 * 13 + 31));
    assert.equal(f.journal.budget().gasReservedWei, '0');
    assert.equal(row.approvalIntent.type, 2);
    assert.equal(row.paymentIntent.nonce, '1');
});
test('lost service response recovers after restart using finalized original transaction without ANY signer call', async (t) => {
    const f = await clientFixture(t), offer = await quote(f.client);
    f.state.lostResponse = true;
    await assert.rejects(f.client.execute(offer, 'order-test-0001'), e => e.doNotRepay && e.settlementState === 'finalized');
    assert.equal(f.journal.read(offer.quote.quoteId).phase, 'settled');
    const before = f.journal.budget();
    f.journal.close();
    const reopened = f.reopen(), client = new TestnetMoteClient({ ...f.clientOptions, journal: reopened, signer: noSigner });
    const delivered = await client.recover(offer, null, 'order-test-0001');
    assert.equal(delivered.result.valid, true);
    assert.equal(f.state.sends.length, 2);
    assert.deepEqual(reopened.budget(), before);
    assert.equal(reopened.read(offer.quote.quoteId).phase, 'complete');
    assert.deepEqual(await client.execute(offer, 'order-test-0001'), delivered);
    assert.equal(f.state.sends.length, 2);
});
test('crash before approval send leaves durable intent and restarted recovery never submits', async (t) => {
    const f = await clientFixture(t), offer = await quote(f.client);
    f.state.beforeSend = () => { throw new Error('controlled crash before broadcast'); };
    await assert.rejects(f.client.execute(offer, 'order-test-0001'), { code: 'PAYMENT_STATE_UNKNOWN' });
    assert.equal(f.journal.read(offer.quote.quoteId).phase, 'approval_unknown');
    const before = f.journal.budget();
    f.journal.close();
    const reopened = f.reopen(), client = new TestnetMoteClient({ ...f.clientOptions, journal: reopened, signer: noSigner });
    await assert.rejects(client.recover(offer, null, 'order-test-0001'), { code: 'PAYMENT_STATE_UNKNOWN' });
    assert.deepEqual(reopened.budget(), before);
    assert.equal(f.state.sends.length, 0);
});
test('crash after payment submission before hash record retains original fee reservation after observed payment recovery', async (t) => {
    const f = await clientFixture(t), offer = await quote(f.client);
    f.state.afterSend = step => { if (step === 'payment')
        throw new Error('controlled lost send response'); };
    await assert.rejects(f.client.execute(offer, 'order-test-0001'), { code: 'PAYMENT_STATE_UNKNOWN' });
    const unknown = f.journal.read(offer.quote.quoteId);
    assert.equal(unknown.phase, 'payment_unknown');
    assert.equal(unknown.paymentHash, null);
    const hash = f.state.sends[1].hash;
    f.journal.close();
    const reopened = f.reopen(), client = new TestnetMoteClient({ ...f.clientOptions, journal: reopened, signer: noSigner });
    const result = await client.recover(offer, hash, 'order-test-0001');
    assert.equal(result.result.valid, true);
    const row = reopened.read(offer.quote.quoteId);
    assert.equal(row.phase, 'payment_unknown');
    assert.equal(row.paymentReservedWei, f.policy.maxGasPerTransactionWei);
    assert.equal(row.tokenSpent, offer.quote.amount);
    assert.equal(f.state.sends.length, 2);
    const next = await quote(client);
    assert.throws(() => reopened.reserve(next, 'order-test-0002'), { code: 'WALLET_BUSY' });
});
test('missing L1 fee evidence retains known approval reservation and recovery cannot proceed to a new payment', async (t) => {
    const f = await clientFixture(t), offer = await quote(f.client);
    f.state.omitL1 = true;
    await assert.rejects(f.client.execute(offer, 'order-test-0001'), { code: 'PAYMENT_STATE_UNKNOWN' });
    assert.equal(f.state.sends.length, 1);
    assert.equal(f.journal.read(offer.quote.quoteId).phase, 'approval_unknown');
    const before = f.journal.budget();
    const client = new TestnetMoteClient({ ...f.clientOptions, journal: f.reopen(), signer: noSigner });
    await assert.rejects(client.recover(offer, null, 'order-test-0001'), { code: 'FEE_EVIDENCE_UNAVAILABLE' });
    assert.deepEqual(f.journal.budget(), before);
    f.state.omitL1 = false;
    await assert.rejects(client.recover(offer, null, 'order-test-0001'), { code: 'PAYMENT_STATE_UNKNOWN' });
    assert.equal(f.journal.read(offer.quote.quoteId).phase, 'approved');
    assert.equal(f.state.sends.length, 1);
    assert.equal(f.journal.budget().gasReservedWei, f.policy.maxGasPerTransactionWei);
});
test('canonical reorg or conflicting payment hash cannot release or overwrite completed authority', async (t) => {
    const f = await clientFixture(t), offer = await quote(f.client);
    await f.client.execute(offer, 'order-test-0001');
    const before = f.journal.budget();
    const client = new TestnetMoteClient({ ...f.clientOptions, journal: f.reopen(), signer: noSigner });
    await assert.rejects(client.recover(offer, '0x' + 'ff'.repeat(32), 'order-test-0001'), { code: 'TRANSACTION_CONFLICT' });
    f.state.reorg = true;
    await assert.rejects(client.recover(offer, null, 'order-test-0001'), { code: 'FEE_CANONICALITY_CHANGED' });
    assert.deepEqual(f.journal.budget(), before);
    assert.equal(f.state.sends.length, 2);
});
test('reverted original payment accounts actual total fee once and releases only known final authority', async (t) => {
    const f = await clientFixture(t), offer = await quote(f.client);
    f.state.revertStep = 'payment';
    await assert.rejects(f.client.execute(offer, 'order-test-0001'), { code: 'PAYMENT_REVERTED' });
    const row = f.journal.read(offer.quote.quoteId);
    assert.equal(row.phase, 'failed');
    assert.equal(row.tokenSpent, '0');
    assert.equal(row.gasReservedWei, '0');
    assert.notEqual(row.gasSpentWei, '0');
    const before = f.journal.budget(), client = new TestnetMoteClient({ ...f.clientOptions, journal: f.reopen(), signer: noSigner });
    await assert.rejects(client.recover(offer, null, 'order-test-0001'), { code: 'PAYMENT_REVERTED' });
    assert.deepEqual(f.journal.budget(), before);
    assert.equal(f.state.sends.length, 2);
});
test('active journal deletion/read-only/corruption before execution fails closed without signer calls', async (t) => {
    for (const mutation of ['deleted', 'read-only', 'corrupt']) {
        const f = await clientFixture(t), offer = await quote(f.client);
        if (mutation === 'deleted')
            rmSync(f.options.path);
        else if (mutation === 'read-only')
            chmodSync(f.options.path, 0o400);
        else
            writeFileSync(f.options.path, 'corrupt fixture storage');
        await assert.rejects(f.client.execute(offer, 'order-test-0001'));
        assert.equal(f.state.signerCalls, 0);
        assert.equal(f.state.sends.length, 0);
        if (mutation === 'read-only')
            chmodSync(f.options.path, 0o600);
    }
});
test('concurrent duplicate calls share one operation and conflicting order keys are rejected', async (t) => {
    const f = await clientFixture(t), offer = await quote(f.client);
    const [a, b] = await Promise.all([f.client.execute(offer, 'order-test-0001'), f.client.execute(offer, 'order-test-0001')]);
    assert.deepEqual(a, b);
    assert.equal(f.state.sends.length, 2);
    await assert.rejects(f.client.execute(offer, 'order-test-conflict'), { code: 'IDEMPOTENCY_CONFLICT' });
});
test('known payment with unavailable total fee evidence reconciles after restart without paying again', async (t) => {
    const f = await clientFixture(t), offer = await quote(f.client);
    f.state.afterSend = step => { if (step === 'payment')
        f.state.omitL1 = true; };
    await assert.rejects(f.client.execute(offer, 'order-test-0001'), { code: 'PAYMENT_STATE_UNKNOWN' });
    assert.equal(f.journal.read(offer.quote.quoteId).phase, 'payment_unknown');
    assert.ok(f.journal.read(offer.quote.quoteId).paymentHash);
    const before = f.journal.budget();
    assert.notEqual(before.tokenReserved, '0');
    f.journal.close();
    f.state.omitL1 = false;
    const reopened = f.reopen(), client = new TestnetMoteClient({ ...f.clientOptions, journal: reopened, signer: noSigner });
    const result = await client.recover(offer, null, 'order-test-0001');
    assert.equal(result.result.valid, true);
    assert.equal(reopened.budget().tokenReserved, '0');
    assert.equal(reopened.budget().tokenSpent, offer.quote.amount);
    assert.equal(f.state.sends.length, 2);
});
test('unfinalized approval retains authority; later finality permits accounting but never resumes payment', async (t) => {
    const f = await clientFixture(t), offer = await quote(f.client), original = f.reader.send;
    let pending = true;
    f.reader.send = (method, params) => original(method, method === 'eth_getBlockByNumber' && params[0] === 'finalized' && pending ? ['0xa', false] : params);
    await assert.rejects(f.client.execute(offer, 'order-test-0001'), { code: 'PAYMENT_STATE_UNKNOWN' });
    assert.equal(f.state.sends.length, 1);
    const before = f.journal.budget();
    const client = new TestnetMoteClient({ ...f.clientOptions, journal: f.reopen(), signer: noSigner });
    await assert.rejects(client.recover(offer, null, 'order-test-0001'), { code: 'FEE_NOT_FINALIZED' });
    assert.deepEqual(f.journal.budget(), before);
    pending = false;
    await assert.rejects(client.recover(offer, null, 'order-test-0001'), { code: 'PAYMENT_STATE_UNKNOWN' });
    assert.equal(f.journal.read(offer.quote.quoteId).phase, 'approved');
    assert.equal(f.state.sends.length, 1);
});
test('tampered results/receipt anchors are rejected after settlement and retried without a second payment', async (t) => {
    for (const kind of ['result', 'anchor', 'signature']) {
        const f = await clientFixture(t), offer = await quote(f.client), original = f.client.fetchImpl;
        f.client.fetchImpl = async (url, request) => {
            const response = await original(url, request);
            if (!url.endsWith('/v1/orders'))
                return response;
            const data = await response.json();
            if (kind === 'result')
                data.result.canonicalJson = '{}';
            else if (kind === 'anchor')
                data.receipt.finalized.blockHash = '0x' + 'ff'.repeat(32);
            else
                data.receiptSignature = '0x' + '11'.repeat(65);
            return Response.json(data);
        };
        await assert.rejects(f.client.execute(offer, 'order-test-0001'), e => e.doNotRepay && ['RESULT_MISMATCH', 'RECEIPT_MISMATCH', 'RECEIPT_SIGNATURE'].includes(e.code));
        assert.equal(f.journal.read(offer.quote.quoteId).phase, 'settled');
        assert.equal(f.journal.read(offer.quote.quoteId).response, null);
        const client = new TestnetMoteClient({ ...f.clientOptions, journal: f.reopen(), signer: noSigner });
        assert.equal((await client.recover(offer, null, 'order-test-0001')).result.valid, true);
        assert.equal(f.state.sends.length, 2);
    }
});

test('original-input reconstruction restores a missing service record after restart without signing or repaying', async t => {
    const f = await clientFixture(t), offer = await quote(f.client);
    f.state.lostResponse = true;
    await assert.rejects(f.client.execute(offer, 'order-test-0001'));
    assert.equal(f.journal.read(offer.quote.quoteId).phase, 'settled');
    f.state.offers.clear();
    f.journal.close();
    const reopened = f.reopen(), client = new TestnetMoteClient({ ...f.clientOptions, journal: reopened, signer: noSigner });
    const result = await client.recoverFromOriginalInput(offer, input, null, 'order-test-0001', { publicSynthetic: true });
    assert.equal(result.result.valid, true);
    assert.equal(f.state.recoveryRequests, 1);
    assert.equal(f.state.sends.length, 2);
    assert.equal(reopened.read(offer.quote.quoteId).phase, 'complete');
    const budget = reopened.budget();
    f.state.offers.clear();
    assert.deepEqual(await client.recoverFromOriginalInput(offer, input, null, 'order-test-0001', { publicSynthetic: true }), result);
    assert.equal(f.state.recoveryRequests, 2); // A cached receipt still repairs lost server state.
    assert.deepEqual(reopened.budget(), budget);
    assert.equal(f.state.sends.length, 2);
});

test('reconstruction rejects input tampering and missing acknowledgment before any recovery request', async t => {
    const f = await clientFixture(t), offer = await quote(f.client);
    await f.client.execute(offer, 'order-test-0001');
    const before = f.journal.budget(), client = new TestnetMoteClient({ ...f.clientOptions, journal: f.reopen(), signer: noSigner });
    await assert.rejects(client.recoverFromOriginalInput(offer, input, null, 'order-test-0001'), { code: 'PUBLIC_SYNTHETIC_REQUIRED' });
    await assert.rejects(client.recoverFromOriginalInput(offer, { document: { z: 999 } }, null, 'order-test-0001', { publicSynthetic: true }), { code: 'RECOVERY_INPUT_MISMATCH' });
    const changed = structuredClone(offer); changed.resultHash = '0x' + 'ff'.repeat(32);
    await assert.rejects(client.recoverFromOriginalInput(changed, input, null, 'order-test-0001', { publicSynthetic: true }), { code: 'RECOVERY_INPUT_MISMATCH' });
    assert.equal(f.state.recoveryRequests, undefined);
    assert.deepEqual(f.journal.budget(), before);
    assert.equal(f.state.sends.length, 2);
});

test('original-input reconstruction cannot revive an unidentified original submission', async t => {
    const f = await clientFixture(t), offer = await quote(f.client);
    f.state.beforeSend = () => { throw new Error('controlled uncertain original'); };
    await assert.rejects(f.client.execute(offer, 'order-test-0001'), { code: 'PAYMENT_STATE_UNKNOWN' });
    const client = new TestnetMoteClient({ ...f.clientOptions, journal: f.reopen(), signer: noSigner });
    await assert.rejects(client.recoverFromOriginalInput(offer, input, null, 'order-test-0001', { publicSynthetic: true }), { code: 'PAYMENT_STATE_UNKNOWN' });
    assert.equal(f.state.recoveryRequests, undefined);
    assert.equal(f.state.sends.length, 0);
    assert.equal(f.journal.read(offer.quote.quoteId).phase, 'approval_unknown');
});

test('a delivery-time reorg remains reconciliation-required rather than being relabeled finalized', async t => {
    const f = await clientFixture(t), offer = await quote(f.client), original = f.chain.verifyPayment;
    let verifies = 0;
    f.chain.verifyPayment = async options => {
        verifies++;
        // First client check and service response succeed; the client's fresh
        // delivery verification then observes a changed canonical history.
        if (verifies === 3) {
            const error = new Error('controlled delivery-time reorg');
            error.code = 'SETTLEMENT_REORG';
            throw error;
        }
        return original(options);
    };
    await assert.rejects(f.client.execute(offer, 'order-test-0001'), error => error.code === 'SETTLEMENT_REORG' && error.doNotRepay && error.settlementState === 'reconciliation_required');
    assert.equal(f.journal.read(offer.quote.quoteId).phase, 'settled');
    const before = f.journal.budget();
    f.chain.verifyPayment = original;
    const client = new TestnetMoteClient({ ...f.clientOptions, journal: f.reopen(), signer: noSigner });
    assert.equal((await client.recover(offer, null, 'order-test-0001')).result.valid, true);
    assert.deepEqual(f.journal.budget(), before);
    assert.equal(f.state.sends.length, 2);
});
