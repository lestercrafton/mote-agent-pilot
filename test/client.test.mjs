import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { createLocalChain, quoteDomain, QUOTE_TYPES } from '../src/chain.mjs';
import { MoteClient } from '../src/client.mjs';
import { canonicalStringify, prepareAudit } from '../src/json.mjs';

let chain, server, baseUrl, config;
const offers = new Map();
let dropNextOrder = false;
let invalidNextReceipt = false;
let quoteTtl = 120;
let tamperNextOffer = false;
let pendingNextOrder = false;

before(async () => {
  chain = await createLocalChain();
  config = {
    chainId: 31337, token: await chain.token.getAddress(), router: await chain.payments.getAddress(),
    recipient: await chain.merchant.getAddress(), quoteSigner: chain.quoteSigner.address,
  };
  server = createServer(async (req, res) => {
    try {
      if (req.url === '/.well-known/mote.json') { res.end(JSON.stringify({ name: 'Mote', localOnly: true })); return; }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (req.url === '/v1/quotes') {
        const prepared = prepareAudit(body.input);
        const quote = {
          quoteId: `0x${randomBytes(32).toString('hex')}`, requestHash: prepared.requestHash,
          payer: body.payer, amount: prepared.amount, deadline: String(Math.floor(Date.now() / 1000) + quoteTtl),
        };
        const domain = quoteDomain(31337, config.router);
        const signature = await chain.quoteSigner.signTypedData(domain, QUOTE_TYPES, quote);
        const offer = { protocol: 'mote-local-v1', quote, domain, signature, ...config, decimals: 6, asset: 'MOTE', service: 'json.audit', resultHash: prepared.resultHash };
        offer.offerSignature = await chain.quoteSigner.signMessage(canonicalStringify(offer));
        if (tamperNextOffer) { tamperNextOffer = false; offer.resultHash = `0x${'ef'.repeat(32)}`; }
        offers.set(quote.quoteId, { offer, result: prepared.result });
        res.end(JSON.stringify(offer));
      } else if (req.url === '/v1/orders') {
        if (pendingNextOrder) {
          pendingNextOrder = false;
          res.statusCode = 202;
          res.end(JSON.stringify({ error: { code: 'SETTLEMENT_PENDING', message: 'Fixture verification delayed; reconcile without repaying.' } }));
          return;
        }
        if (dropNextOrder) { dropNextOrder = false; req.socket.destroy(); return; }
        const { offer, result } = offers.get(body.quoteId);
        const chainReceipt = await chain.provider.getTransactionReceipt(body.transactionHash);
        const log = chainReceipt.logs.find((item) => item.address.toLowerCase() === config.router.toLowerCase());
        const receipt = {
          protocol: 'mote-local-v1', quoteId: body.quoteId, requestHash: offer.quote.requestHash,
          resultHash: offer.resultHash, payer: offer.quote.payer, amount: offer.quote.amount,
          asset: 'MOTE', ...config, transactionHash: body.transactionHash,
          blockNumber: chainReceipt.blockNumber, blockHash: chainReceipt.blockHash,
          logIndex: log.index, settledAt: 'local fixture', localOnly: true,
        };
        const receiptSignature = await chain.quoteSigner.signMessage(canonicalStringify(receipt));
        if (invalidNextReceipt) { invalidNextReceipt = false; receipt.amount = '0'; }
        res.end(JSON.stringify({ result, receipt, receiptSignature, receiptSigner: config.quoteSigner }));
      } else { res.statusCode = 404; res.end('{}'); }
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: { message: error.message } })); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (chain) await chain.close();
});

async function client(overrides = {}, signer = chain.payer) {
  return new MoteClient({
    baseUrl, signer, provider: chain.provider,
    policy: {
      enabled: true, ...config, payer: await chain.payer.getAddress(), serviceOrigin: baseUrl,
      maxSingleSpend: '100000', maxTotalSpend: '1000000',
      maxGasPerTransactionWei: '10000000000000000', maxGasTotalWei: '100000000000000000',
      ...overrides,
    },
  });
}

test('client offers free discovery and quote, while spending is disabled by default', async () => {
  const c = await client({ enabled: false });
  assert.equal((await c.discover()).name, 'Mote');
  const offer = await c.quote({ document: { b: 2, a: 1 } }, 'disabled-quote');
  await assert.rejects(c.execute(offer, 'disabled-order'), { code: 'SPENDING_DISABLED' });
  assert.equal(await chain.payments.consumed(offer.quote.quoteId), false);
  assert.equal(c.budget.tokenSpent, '0');
});

test('client rejects external origins, altered destinations, unrequested offers, expired quotes, and invalid keys', async () => {
  assert.throws(() => new MoteClient({ baseUrl: 'https://example.com', policy: {} }), { code: 'LOCAL_ONLY' });
  const c = await client();
  const offer = await c.quote({ document: { tag: 'boundaries' } }, 'boundary-quote');
  const altered = structuredClone(offer); altered.recipient = config.token;
  await assert.rejects(c.execute(altered, 'boundary-order'), { code: 'DESTINATION_DENIED' });
  const alteredCost = structuredClone(offer); alteredCost.quote.amount = String(BigInt(offer.quote.amount) + 1n);
  await assert.rejects(c.execute(alteredCost, 'boundary-order'), { code: 'OFFER_NOT_REQUESTED' });
  await assert.rejects(c.execute(offer, 'bad'), { code: 'INVALID_IDEMPOTENCY_KEY' });
  quoteTtl = -1;
  const expired = await c.quote({ document: 1 }, 'expired-quote');
  quoteTtl = 120;
  await assert.rejects(c.execute(expired, 'expired-order'), { code: 'QUOTE_EXPIRED' });
  assert.equal(await chain.payments.consumed(offer.quote.quoteId), false);
  assert.equal(c.budget.tokenReserved, '0');
});

test('client enforces both token and native-fee budgets before signing a payment', async () => {
  const tinyToken = await client({ maxSingleSpend: '1' });
  const tokenOffer = await tinyToken.quote({ document: {} }, 'token-budget-quote');
  await assert.rejects(tinyToken.execute(tokenOffer, 'token-budget-order'), { code: 'SINGLE_LIMIT' });
  const tinyGas = await client({ maxGasTotalWei: '1' });
  const gasOffer = await tinyGas.quote({ document: {} }, 'gas-budget-quote');
  await assert.rejects(tinyGas.execute(gasOffer, 'gas-budget-order'), { code: 'GAS_TOTAL_LIMIT' });
  assert.equal(await chain.payments.consumed(tokenOffer.quote.quoteId), false);
  assert.equal(await chain.payments.consumed(gasOffer.quote.quoteId), false);
});

test('client rejects result-hash tampering before an offered payment is authorized', async () => {
  const c = await client();
  tamperNextOffer = true;
  const offer = await c.quote({ document: { tag: 'altered-initial-envelope' } }, 'envelope-quote');
  await assert.rejects(c.execute(offer, 'envelope-order'), { code: 'INVALID_OFFER_SIGNATURE' });
  assert.equal(await chain.payments.consumed(offer.quote.quoteId), false);
  assert.equal(c.budget.tokenSpent, '0');
  assert.equal(c.budget.tokenReserved, '0');
});

test('concurrent payments reserve atomically and only one fits a one-quote budget', async () => {
  const c = await client();
  const a = await c.quote({ document: { equal: true } }, 'concurrent-quote-a');
  const b = await c.quote({ document: { equal: true } }, 'concurrent-quote-b');
  const limited = await client({ maxTotalSpend: a.quote.amount });
  // Offers must be obtained by the same policy-bearing client before spending.
  const x = await limited.quote({ document: { equal: true } }, 'limited-quote-a');
  const y = await limited.quote({ document: { equal: true } }, 'limited-quote-b');
  const results = await Promise.allSettled([limited.execute(x, 'limited-order-a'), limited.execute(y, 'limited-order-b')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'TOTAL_LIMIT');
  assert.equal(limited.budget.tokenSpent, a.quote.amount);
  assert.equal(limited.budget.tokenReserved, '0');
  assert.equal(limited.budget.gasReservedWei, '0');
  assert.equal(await chain.payments.consumed(a.quote.quoteId), false);
  assert.equal(await chain.payments.consumed(b.quote.quoteId), false);
});

test('concurrent retries of the same quote pay once and leave no token allowance', async () => {
  const c = await client();
  const offer = await c.quote({ document: { b: 2, a: 1 } }, 'same-quote-id');
  const beforeBalance = await chain.token.balanceOf(offer.quote.payer);
  const [a, b] = await Promise.all([c.execute(offer, 'same-order-id'), c.execute(offer, 'same-order-id')]);
  assert.deepEqual(a, b);
  assert.equal(beforeBalance - await chain.token.balanceOf(offer.quote.payer), BigInt(offer.quote.amount));
  assert.equal(await chain.token.allowance(offer.quote.payer, config.router), 0n);
  assert.equal(c.budget.tokenSpent, offer.quote.amount);
  assert.equal(c.budget.tokenReserved, '0');
});

test('a dropped paid response is recovered without a second payment', async () => {
  const c = await client();
  const offer = await c.quote({ document: { tag: 'dropped-response' } }, 'dropped-quote');
  const beforeBalance = await chain.token.balanceOf(offer.quote.payer);
  dropNextOrder = true;
  await assert.rejects(c.execute(offer, 'dropped-order'));
  assert.equal(c.budget.tokenSpent, offer.quote.amount);
  const response = await c.execute(offer, 'dropped-order');
  assert.equal(response.receipt.quoteId, offer.quote.quoteId);
  assert.equal(beforeBalance - await chain.token.balanceOf(offer.quote.payer), BigInt(offer.quote.amount));
});

test('HTTP 202 settlement-pending preserves recovery guidance and does not repay', async () => {
  const c = await client();
  const offer = await c.quote({ document: { tag: 'pending-verification' } }, 'pending-quote');
  const beforeBalance = await chain.token.balanceOf(offer.quote.payer);
  pendingNextOrder = true;
  let failure;
  try { await c.execute(offer, 'pending-order'); } catch (error) { failure = error; }
  assert.equal(failure?.code, 'SETTLEMENT_PENDING');
  assert.equal(failure.doNotRepay, true);
  assert.equal(failure.settlementState, 'confirmed');
  const response = await c.recover(offer, failure.transactionHash, 'pending-order');
  assert.equal(response.receipt.quoteId, offer.quote.quoteId);
  assert.equal(beforeBalance - await chain.token.balanceOf(offer.quote.payer), BigInt(offer.quote.amount));
});

test('uncertain transaction wait retains its reservation and reconciles the original hash', async () => {
  let failPaymentWait = true;
  let failHash;
  const originalReceipt = chain.provider.getTransactionReceipt.bind(chain.provider);
  chain.provider.getTransactionReceipt = async (hash) => {
    if (hash === failHash) { failHash = null; throw new Error('Injected local RPC response loss'); }
    return originalReceipt(hash);
  };
  const signer = {
    provider: chain.provider,
    getAddress: () => chain.payer.getAddress(),
    sendTransaction: async (tx) => {
      const sent = await chain.payer.sendTransaction(tx);
      if (tx.to.toLowerCase() === config.router.toLowerCase() && failPaymentWait) {
        failPaymentWait = false;
        failHash = sent.hash;
      }
      return sent;
    },
  };
  const c = await client({}, signer);
  const offer = await c.quote({ document: { tag: 'uncertain-payment' } }, 'unknown-quote');
  const beforeBalance = await chain.token.balanceOf(offer.quote.payer);
  let failure;
  try { await c.execute(offer, 'unknown-order'); } catch (error) { failure = error; }
  assert.equal(failure?.code, 'PAYMENT_STATE_UNKNOWN');
  assert.equal(failure.doNotRepay, true);
  assert.equal(c.budget.tokenReserved, offer.quote.amount);
  assert.equal(c.budget.tokenSpent, '0');
  const beforeRecoveryBudget = c.budget;
  await assert.rejects(c.recover(offer, `0x${'ff'.repeat(32)}`, 'unknown-order'), { code: 'TRANSACTION_CONFLICT' });
  assert.deepEqual(c.budget, beforeRecoveryBudget);
  chain.provider.getTransactionReceipt = async (hash) => {
    const receipt = await originalReceipt(hash);
    return hash === failure.transactionHash ? { ...receipt, status: 0, blockHash: `0x${'fa'.repeat(32)}` } : receipt;
  };
  await assert.rejects(c.recover(offer, failure.transactionHash, 'unknown-order'), { code: 'SETTLEMENT_REORG' });
  assert.deepEqual(c.budget, beforeRecoveryBudget);
  chain.provider.getTransactionReceipt = originalReceipt;
  const response = await c.recover(offer, failure.transactionHash, 'unknown-order');
  chain.provider.getTransactionReceipt = originalReceipt;
  assert.equal(response.receipt.transactionHash, failure.transactionHash);
  assert.equal(c.budget.tokenReserved, '0');
  assert.equal(c.budget.tokenSpent, offer.quote.amount);
  assert.equal(beforeBalance - await chain.token.balanceOf(offer.quote.payer), BigInt(offer.quote.amount));
});

test('an unrelated reverted transaction cannot release an unknown payment reservation', async () => {
  let failSendResponse = true;
  const signer = {
    provider: chain.provider,
    getAddress: () => chain.payer.getAddress(),
    sendTransaction: async (tx) => {
      const sent = await chain.payer.sendTransaction(tx);
      if (tx.to.toLowerCase() === config.router.toLowerCase() && failSendResponse) {
        failSendResponse = false;
        throw new Error('Injected loss of payment submission response');
      }
      return sent;
    },
  };
  const c = await client({}, signer);
  const offer = await c.quote({ document: { tag: 'unknown-hash' } }, 'unknown-hash-quote');
  await assert.rejects(c.execute(offer, 'unknown-hash-order'), { code: 'PAYMENT_STATE_UNKNOWN' });
  const beforeRecoveryBudget = c.budget;
  const unrelated = await c.quote({ document: { tag: 'unrelated-revert' } }, 'unrelated-quote');
  const wrongPayment = await chain.payments.connect(chain.payer).pay(unrelated.quote, unrelated.signature, { gasLimit: 250000n });
  await assert.rejects(wrongPayment.wait());
  await assert.rejects(c.recover(offer, wrongPayment.hash, 'unknown-hash-order'), { code: 'PAYMENT_PROOF_MISMATCH' });
  assert.deepEqual(c.budget, beforeRecoveryBudget);
  const revertedReplay = await chain.payments.connect(chain.payer).pay(offer.quote, offer.signature, { gasLimit: 250000n });
  await assert.rejects(revertedReplay.wait());
  await assert.rejects(c.recover(offer, revertedReplay.hash, 'unknown-hash-order'), { code: 'PAYMENT_STATE_UNKNOWN' });
  assert.deepEqual(c.budget, beforeRecoveryBudget);
  const recovered = await c.recover(offer, null, 'unknown-hash-order');
  assert.equal(recovered.receipt.quoteId, offer.quote.quoteId);
  assert.equal(c.budget.tokenReserved, '0');
  assert.equal(c.budget.tokenSpent, offer.quote.amount);
});

test('client rejects a tampered signed receipt and retries delivery without paying again', async () => {
  const c = await client();
  const offer = await c.quote({ document: { tag: 'receipt-tamper' } }, 'receipt-quote');
  const beforeBalance = await chain.token.balanceOf(offer.quote.payer);
  invalidNextReceipt = true;
  await assert.rejects(c.execute(offer, 'receipt-order'), { code: 'RECEIPT_MISMATCH' });
  const response = await c.execute(offer, 'receipt-order');
  assert.equal(response.receipt.amount, offer.quote.amount);
  assert.equal(beforeBalance - await chain.token.balanceOf(offer.quote.payer), BigInt(offer.quote.amount));
});

test('concurrent recoveries account for an uncertain approval and payment exactly once', async () => {
  let approvalHash;
  let loseReceipt = true;
  let approvalRecoveryReads = 0;
  const originalReceipt = chain.provider.getTransactionReceipt.bind(chain.provider);
  chain.provider.getTransactionReceipt = async (hash) => {
    if (hash === approvalHash) {
      if (loseReceipt) { loseReceipt = false; throw new Error('Injected lost approval receipt'); }
      approvalRecoveryReads++;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return originalReceipt(hash);
  };
  try {
    const signer = {
      provider: chain.provider,
      getAddress: () => chain.payer.getAddress(),
      sendTransaction: async (tx) => {
        const sent = await chain.payer.sendTransaction(tx);
        if (tx.to.toLowerCase() === config.token.toLowerCase()) approvalHash = sent.hash;
        return sent;
      },
    };
    const c = await client({}, signer);
    const offer = await c.quote({ document: { tag: 'concurrent-recovery' } }, 'recovery-race-quote');
    await assert.rejects(c.execute(offer, 'recovery-race-order'), { code: 'PAYMENT_STATE_UNKNOWN' });
    const payment = await chain.payments.connect(chain.payer).pay(offer.quote, offer.signature, { gasLimit: 250000n });
    const paymentReceipt = await payment.wait();
    const approvalReceipt = await originalReceipt(approvalHash);
    const responses = await Promise.all([
      c.recover(offer, payment.hash, 'recovery-race-order'),
      c.recover(offer, payment.hash, 'recovery-race-order'),
    ]);
    assert.deepEqual(responses[0], responses[1]);
    assert.equal(approvalRecoveryReads, 1);
    assert.equal(c.budget.gasSpentWei, (approvalReceipt.fee + paymentReceipt.fee).toString());
    assert.equal(c.budget.gasReservedWei, '0');
    assert.equal(c.budget.tokenSpent, offer.quote.amount);
  } finally { chain.provider.getTransactionReceipt = originalReceipt; }
});

test('recovery keeps the native-fee cap when an earlier approval hash is unknown', async () => {
  let loseApprovalResponse = true;
  const signer = {
    provider: chain.provider,
    getAddress: () => chain.payer.getAddress(),
    sendTransaction: async (tx) => {
      const sent = await chain.payer.sendTransaction(tx);
      if (tx.to.toLowerCase() === config.token.toLowerCase() && loseApprovalResponse) {
        loseApprovalResponse = false;
        throw new Error('Injected lost approval submission response');
      }
      return sent;
    },
  };
  const c = await client({}, signer);
  const offer = await c.quote({ document: { tag: 'unknown-approval-hash' } }, 'approval-unknown-quote');
  await assert.rejects(c.execute(offer, 'approval-unknown-order'), { code: 'PAYMENT_STATE_UNKNOWN' });
  const payment = await chain.payments.connect(chain.payer).pay(offer.quote, offer.signature, { gasLimit: 250000n });
  const receipt = await payment.wait();
  await c.recover(offer, payment.hash, 'approval-unknown-order');
  assert.equal(c.budget.tokenSpent, offer.quote.amount);
  assert.equal(c.budget.gasSpentWei, receipt.fee.toString());
  assert.equal(c.budget.gasReservedWei, '10000000000000000');
});

test('recovering an externally paid quote after ALREADY_PAID accounts for its spend', async () => {
  const c = await client();
  const offer = await c.quote({ document: { tag: 'external-paid' } }, 'external-paid-quote');
  await (await chain.token.connect(chain.payer).approve(config.router, offer.quote.amount)).wait();
  const payment = await chain.payments.connect(chain.payer).pay(offer.quote, offer.signature, { gasLimit: 250000n });
  const receipt = await payment.wait();
  await assert.rejects(c.execute(offer, 'external-paid-order'), { code: 'ALREADY_PAID' });
  assert.equal(c.budget.tokenSpent, '0');
  await c.recover(offer, payment.hash, 'external-paid-order');
  assert.equal(c.budget.tokenSpent, offer.quote.amount);
  assert.equal(c.budget.gasSpentWei, receipt.fee.toString());
  await c.recover(offer, payment.hash, 'external-paid-order');
  assert.equal(c.budget.tokenSpent, offer.quote.amount);
  assert.equal(c.budget.gasSpentWei, receipt.fee.toString());
});
