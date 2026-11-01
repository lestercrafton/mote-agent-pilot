import { randomBytes } from 'node:crypto';
import { getAddress, isAddress, ZeroAddress } from 'ethers';
import { canonicalStringify, MoteError, prepareAudit, hashJson } from './json.mjs';
import { QUOTE_TYPES, quoteDomain } from './chain.mjs';
import { openStore } from './store.mjs';

export function idempotencyKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) throw new MoteError('INVALID_IDEMPOTENCY_KEY', 'Supply an 8–128 character Idempotency-Key using letters, digits, dot, underscore, colon or dash.');
  return value;
}
const bytes32 = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);

export async function createService({ chain, database = ':memory:', ttlSeconds = 120, now = () => Math.floor(Date.now() / 1000), hooks = {} }) {
  if (chain.chainId !== 31337 || Number((await chain.provider.getNetwork()).chainId) !== 31337) throw new MoteError('LOCAL_ONLY', 'Only local chain 31337 is supported.');
  const config = {
    chainId: 31337, token: await chain.token.getAddress(), router: await chain.payments.getAddress(),
    recipient: await chain.merchant.getAddress(), quoteSigner: chain.quoteSigner.address,
  };
  const store = openStore(database, canonicalStringify(config));
  const inflight = new Set();
  async function verifyProof(row, transactionHash) {
    const receipt = await chain.provider.getTransactionReceipt(transactionHash);
    if (!receipt && row.response) throw new MoteError('SETTLEMENT_REORG', 'Previously recorded payment is no longer confirmed. Reconcile this transaction; do not pay again.', 409);
    if (!receipt) throw new MoteError('SETTLEMENT_PENDING', 'Payment is not confirmed. Reconcile this transaction; do not pay again.', 202);
    if (receipt.status !== 1) throw new MoteError('PAYMENT_REVERTED', 'Payment transaction reverted.', 409);
    if (receipt.to?.toLowerCase() !== config.router.toLowerCase()) throw new MoteError('WRONG_ROUTER', 'Receipt is not from the quoted payment router.', 409);
    const block = await chain.provider.getBlock(receipt.blockNumber);
    if (!block || block.hash !== receipt.blockHash) throw new MoteError('SETTLEMENT_REORG', 'Payment is no longer in the canonical local chain. Reconcile; do not pay again.', 409);
    const events = receipt.logs.filter((log) => log.address.toLowerCase() === config.router.toLowerCase()).map((log) => {
      try { return { log, event: chain.payments.interface.parseLog(log) }; } catch { return null; }
    }).filter((parsed) => parsed?.event?.name === 'Paid');
    const q = row.offer.quote;
    const matching = events.filter(({ event: { args } }) => args.quoteId.toLowerCase() === q.quoteId.toLowerCase() && args.requestHash.toLowerCase() === q.requestHash.toLowerCase() && args.payer.toLowerCase() === q.payer.toLowerCase() && args.amount === BigInt(q.amount));
    if (matching.length !== 1 || block.timestamp > Number(q.deadline)) throw new MoteError('PAYMENT_MISMATCH', 'Payment does not match the exact quote, payer, request, amount and expiry.', 409);
    return { receipt, block, log: matching[0].log };
  }
  async function checkedResponse(row) {
    if (!row.response) return { quoteId: row.id, status: 'awaiting_payment' };
    await verifyProof(row, row.tx);
    return row.response;
  }
  return {
    config,
    async quote({ payer, input }, key) {
      idempotencyKey(key);
      if (!isAddress(payer) || payer === ZeroAddress) throw new MoteError('INVALID_PAYER', 'A nonzero EVM payer address is required.');
      payer = getAddress(payer);
      const prepared = prepareAudit(input);
      const fingerprint = hashJson({ payer: payer.toLowerCase(), requestHash: prepared.requestHash });
      const previous = store.byKey(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new MoteError('IDEMPOTENCY_CONFLICT', 'Idempotency key belongs to another request or payer.', 409);
        return previous.offer;
      }
      if (store.count() >= 5000) throw new MoteError('CAPACITY', 'Local demo quote capacity reached.', 503);
      await hooks.beforeQuote?.();
      const deadline = now() + ttlSeconds;
      const quote = { quoteId: `0x${randomBytes(32).toString('hex')}`, requestHash: prepared.requestHash, payer, amount: prepared.amount, deadline: String(deadline) };
      const domain = quoteDomain(config.chainId, config.router);
      const signature = await chain.quoteSigner.signTypedData(domain, QUOTE_TYPES, quote);
      const offer = { protocol: 'mote-local-v1', quote, domain, signature, ...config, decimals: 6, asset: 'MOTE', service: 'json.audit', resultHash: prepared.resultHash, expiresAt: new Date(deadline * 1000).toISOString(), inputBytes: prepared.inputBytes, localOnly: true };
      // The contract's typed quote authorizes payment; this envelope additionally
      // authenticates the promised result hash and all discovery-facing metadata.
      offer.offerSignature = await chain.quoteSigner.signMessage(canonicalStringify(offer));
      return store.saveQuote(quote.quoteId, key, fingerprint, offer, prepared.result);
    },
    async settle({ quoteId, transactionHash }, key) {
      idempotencyKey(key);
      if (!bytes32(quoteId) || !bytes32(transactionHash)) throw new MoteError('INVALID_PROOF', 'quoteId and transactionHash must be 32-byte hexadecimal values.');
      quoteId = quoteId.toLowerCase(); transactionHash = transactionHash.toLowerCase();
      const row = store.byId(quoteId);
      if (!row) throw new MoteError('QUOTE_NOT_FOUND', 'Quote does not exist in this service instance.', 404);
      store.bindAttempt(key, quoteId, transactionHash);
      if (row.response) {
        if (row.tx !== transactionHash) throw new MoteError('ALREADY_PAID', 'This quote already has a different recorded transaction.', 409);
        return checkedResponse(row);
      }
      if (inflight.has(quoteId)) throw new MoteError('IN_FLIGHT', 'Order reconciliation is already in flight; retry the same proof.', 409);
      inflight.add(quoteId);
      try {
        const { receipt: chainReceipt, block, log } = await verifyProof(row, transactionHash);
        await hooks.afterVerification?.();
        const q = row.offer.quote;
        const receipt = { protocol: 'mote-local-v1', quoteId, requestHash: q.requestHash, resultHash: row.offer.resultHash, payer: q.payer, amount: q.amount, asset: 'MOTE', ...config, transactionHash, blockNumber: chainReceipt.blockNumber, blockHash: chainReceipt.blockHash, logIndex: log.index, settledAt: new Date(block.timestamp * 1000).toISOString(), localOnly: true };
        const receiptSignature = await chain.quoteSigner.signMessage(canonicalStringify(receipt));
        const response = { result: row.result, receipt, receiptSignature, receiptSigner: config.quoteSigner };
        // Commit before returning; dropped responses and process restarts replay identical bytes.
        const saved = store.saveResponse(quoteId, transactionHash, response);
        await hooks.afterCommit?.();
        return saved;
      } finally { inflight.delete(quoteId); }
    },
    async order(quoteId) {
      if (!bytes32(quoteId)) throw new MoteError('INVALID_QUOTE_ID', 'Invalid quote identifier.');
      const row = store.byId(quoteId.toLowerCase());
      if (!row) throw new MoteError('QUOTE_NOT_FOUND', 'Quote not found.', 404);
      return checkedResponse(row);
    },
    close() { store.close(); },
  };
}
