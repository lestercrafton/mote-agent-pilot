import { randomBytes } from 'node:crypto';
import { getAddress, isAddress, ZeroAddress, verifyMessage, verifyTypedData } from 'ethers';
import { canonicalStringify, hashJson, MoteError, prepareAudit } from './json.mjs';
import { QUOTE_TYPES, quoteDomain } from './testnet-chain.mjs';
import { normalizeTestnetStoreIdentity, TestnetStore } from './testnet-store.mjs';
import { getTestnetNetwork } from './testnet-networks.mjs';

// Kept as a Base-only compatibility export. Runtime offers use their pinned network.
export const TESTNET_PROTOCOL = getTestnetNetwork(84532).protocol;
const HEX = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^(0|[1-9]\d{0,77})$/;
const fail = (code, message, status = 400) => { throw new MoteError(code, message, status); };
const check = (condition, code, message, status) => { if (!condition) fail(code, message, status); };
const same = (a,b) => canonicalStringify(a) === canonicalStringify(b);
export function testnetIdempotencyKey(key) {
  check(typeof key === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(key), 'INVALID_IDEMPOTENCY_KEY', 'Supply an 8–128 character Idempotency-Key.');
  return key;
}
function declared(body, fields) {
  check(body && Object.getPrototypeOf(body) === Object.prototype && Object.keys(body).every(key => fields.includes(key)), 'INVALID_REQUEST', 'Unsupported request fields.');
  check(body.publicSynthetic === true, 'PUBLIC_SYNTHETIC_REQUIRED', 'This public test pilot accepts only explicitly declared public synthetic input. Results and proofs are public; this flag cannot detect private data.');
}
function proofError(error, hadResponse) {
  if (hadResponse && ['PAYMENT_PENDING', 'NOT_FINALIZED', 'SETTLEMENT_REORG'].includes(error.code)) return new MoteError('SETTLEMENT_REORG', 'Previously delivered payment is no longer finalized; preserve the original proof and do not pay again.', 409);
  if (['PAYMENT_PENDING', 'NOT_FINALIZED'].includes(error.code)) return new MoteError(error.code, 'Original payment is not finalized. Retry this proof; do not submit another payment.', 202);
  if (error instanceof MoteError) return error;
  const code = typeof error.code === 'string' ? error.code : 'PROOF_UNAVAILABLE';
  return new MoteError(code, 'Payment verification failed. Preserve and reconcile the original proof; do not pay again.', ['PAYMENT_MISMATCH', 'SETTLEMENT_REORG', 'CHAIN_IDENTITY_MISMATCH'].includes(code) ? 409 : 503);
}

/** This service never sends transactions and never creates or persists keys.
 * Its external signer is used only for exact payment offers and finalized
 * delivery receipts. Stored payloads must be public synthetic data. */
export async function createTestnetService({ adapter, quoteSigner, origin, database, ttlSeconds, now = () => Math.floor(Date.now() / 1000), hooks = {}, recoveryOnly = false, limits }) {
  check(adapter && typeof adapter.verifyIdentity === 'function' && typeof adapter.verifyPayment === 'function', 'CONFIG_INVALID', 'A read-only deployment and finalized payment adapter is required.');
  const identity = normalizeTestnetStoreIdentity(adapter.identity);
  const network = getTestnetNetwork(identity.chainId);
  const lifetimePolicy = network.chainId === 11155111 ? { default: 3600, maximum: 7200 } : { default: 120, maximum: 900 };
  const lifetime = ttlSeconds === undefined ? lifetimePolicy.default : ttlSeconds;
  check(origin === undefined || origin === identity.origin, 'CONFIG_INVALID', 'Service origin differs from the deployment identity.');
  check(Number.isSafeInteger(lifetime) && lifetime >= 30 && lifetime <= lifetimePolicy.maximum, 'CONFIG_INVALID', `Quote lifetime must be 30–${lifetimePolicy.maximum} seconds for this pinned network.`);
  check(typeof database === 'string' && database !== ':memory:' && database.length > 0, 'CONFIG_INVALID', 'An explicitly initialized durable database is required.');
  check(quoteSigner && typeof quoteSigner.signTypedData === 'function' && typeof quoteSigner.signMessage === 'function' && !quoteSigner.provider, 'SIGNER_INVALID', 'An externally provisioned offline quote signer is required; no connected transaction signer is accepted.');
  let signerAddress;
  try { signerAddress = getAddress(quoteSigner.address ?? await quoteSigner.getAddress()).toLowerCase(); } catch { fail('SIGNER_INVALID', 'Quote signer identity is unavailable.'); }
  check(signerAddress === identity.quoteSigner, 'SIGNER_MISMATCH', 'Quote signer differs from the pinned immutable router signer.');
  check(same(normalizeTestnetStoreIdentity(await adapter.verifyIdentity()), identity), 'CHAIN_IDENTITY_MISMATCH', 'Deployment identity changed.', 503);
  const store = new TestnetStore({ path: database, identity, recoveryOnly, ...(limits ? { limits } : {}) });
  const inflight = new Map();
  let closed = false;
  const config = Object.freeze({ ...identity, protocol: network.protocol, publicSyntheticOnly: true, testOnly: true, finality: 'finalized', recoveryOnly });
  const time = () => { const value = now(); check(Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000 - lifetime, 'CLOCK_INVALID', 'A valid seconds clock is required.', 503); return value; };
  function draftFor(prepared, quote) {
    return {
      protocol: network.protocol, quote, domain: quoteDomain(identity.chainId, identity.router),
      chainId: identity.chainId, token: identity.token, router: identity.router, recipient: identity.recipient, quoteSigner: identity.quoteSigner,
      decimals: 6, asset: 'MOTE', service: 'json.audit', resultHash: prepared.resultHash,
      expiresAt: new Date(Number(quote.deadline) * 1000).toISOString(), inputBytes: prepared.inputBytes,
      origin: identity.origin, configHash: identity.configHash, finality: 'finalized', testOnly: true, publicSynthetic: true, localOnly: false,
    };
  }
  function prepare(body, needsPayer = true) {
    declared(body, needsPayer ? ['payer', 'input', 'publicSynthetic'] : ['offer', 'input', 'transactionHash', 'publicSynthetic']);
    const prepared = prepareAudit(body.input);
    const input = structuredClone(body.input);
    if (!needsPayer) return { prepared, input };
    check(isAddress(body.payer) && getAddress(body.payer) !== ZeroAddress, 'INVALID_PAYER', 'A nonzero EVM payer address is required.');
    const payer = getAddress(body.payer).toLowerCase();
    return { prepared, input, payer, fingerprint: hashJson({ payer, requestHash: prepared.requestHash, publicSynthetic: true }) };
  }
  function verifyOffer(offer, prepared) {
    check(offer && Object.getPrototypeOf(offer) === Object.prototype && offer.quote && Object.getPrototypeOf(offer.quote) === Object.prototype && Object.keys(offer.quote).sort().join() === 'amount,deadline,payer,quoteId,requestHash', 'INVALID_OFFER', 'Complete original signed offer is required.');
    const q = offer.quote;
    check(HEX.test(q.quoteId) && HEX.test(q.requestHash) && q.quoteId !== `0x${'0'.repeat(64)}` && isAddress(q.payer) && getAddress(q.payer) !== ZeroAddress && typeof q.amount === 'string' && UINT.test(q.amount) && typeof q.deadline === 'string' && UINT.test(q.deadline) && BigInt(q.deadline) <= 8640000000000n, 'INVALID_OFFER', 'Invalid signed quote fields.');
    check(q.requestHash === prepared.requestHash && q.amount === prepared.amount, 'OFFER_INPUT_MISMATCH', 'Original public input does not reproduce the signed request and exact price.', 409);
    const { signature, offerSignature, ...draft } = offer;
    check(same(draft, draftFor(prepared, q)), 'OFFER_CONFIG_MISMATCH', 'Offer does not bind this exact service, result, deployment and public synthetic declaration.', 409);
    try {
      check(verifyTypedData(offer.domain, QUOTE_TYPES, q, signature).toLowerCase() === identity.quoteSigner, 'INVALID_SIGNATURE', 'Invalid payment quote signature.', 409);
      const { offerSignature: ignored, ...envelope } = offer;
      check(verifyMessage(canonicalStringify(envelope), offerSignature).toLowerCase() === identity.quoteSigner, 'INVALID_SIGNATURE', 'Invalid signed offer envelope.', 409);
    } catch (error) { if (error instanceof MoteError) throw error; fail('INVALID_SIGNATURE', 'Original offer signature is invalid.', 409); }
    return draft;
  }
  async function verified(row, transactionHash) {
    try {
      const prepared = prepareAudit(row.input);
      verifyOffer(row.offer, prepared);
      check(same(row.result, prepared.result), 'STORE_CORRUPT', 'Stored result differs from its signed input commitment.', 503);
      const proof = await adapter.verifyPayment({ offer: row.offer, transactionHash, ...(row.response ? { finalizedAnchor: row.response.receipt.finalized } : {}) });
      check(proof?.transactionHash === transactionHash, 'PROOF_MISMATCH', 'Adapter returned another payment proof.', 409);
      return proof;
    }
    catch (error) { throw proofError(error, Boolean(row.response)); }
  }
  async function responseFor(row, proof) {
    const q = row.offer.quote;
    check(proof && proof.transactionHash?.toLowerCase() === proof.transactionHash && HEX.test(proof.transactionHash) && proof.quoteId === q.quoteId && proof.requestHash === q.requestHash && proof.payer?.toLowerCase() === q.payer.toLowerCase() && proof.amount === q.amount && proof.configHash === identity.configHash && ['token', 'router', 'recipient'].every(key => proof[key]?.toLowerCase() === identity[key]) && HEX.test(proof.blockHash) && proof.finalized && HEX.test(proof.finalized.blockHash), 'PROOF_MISMATCH', 'Finalized adapter proof did not bind the signed offer.', 409);
    for (const key of ['blockNumber', 'transactionIndex', 'logIndex', 'blockTimestamp']) check(typeof proof[key] === 'string' && UINT.test(proof[key]), 'PROOF_MISMATCH', 'Invalid finalized proof number.', 409);
    check(typeof proof.finalized.blockNumber === 'string' && UINT.test(proof.finalized.blockNumber) && BigInt(proof.finalized.blockNumber) >= BigInt(proof.blockNumber) && BigInt(proof.blockTimestamp) <= BigInt(q.deadline) && BigInt(proof.blockTimestamp) <= 8640000000000n, 'PROOF_MISMATCH', 'Invalid proof finality or expiry.', 409);
    const receipt = {
      protocol: network.protocol, quoteId: q.quoteId, requestHash: q.requestHash, resultHash: row.offer.resultHash, payer: q.payer, amount: q.amount,
      asset: 'MOTE', chainId: identity.chainId, token: identity.token, router: identity.router, recipient: identity.recipient, quoteSigner: identity.quoteSigner,
      origin: identity.origin, configHash: identity.configHash, transactionHash: proof.transactionHash,
      blockNumber: proof.blockNumber, blockHash: proof.blockHash, transactionIndex: proof.transactionIndex, logIndex: proof.logIndex,
      settledAt: new Date(Number(proof.blockTimestamp) * 1000).toISOString(), finalized: proof.finalized,
      finality: 'finalized', testOnly: true, publicSynthetic: true, localOnly: false,
    };
    const receiptSignature = await quoteSigner.signMessage(canonicalStringify(receipt));
    check(verifyMessage(canonicalStringify(receipt), receiptSignature).toLowerCase() === identity.quoteSigner, 'SIGNER_MISMATCH', 'Receipt signer returned an invalid attestation.', 503);
    return { result: row.result, receipt, receiptSignature, receiptSigner: identity.quoteSigner };
  }
  async function exclusive(id, fn) {
    check(!closed, 'SERVICE_CLOSED', 'Service is closed.', 503);
    check(!inflight.has(id), 'IN_FLIGHT', 'Order operation is already running. Retry the same request.', 409);
    check(inflight.size < 16, 'CAPACITY', 'Pilot concurrency limit reached; retry the same request.', 503);
    const pending = Promise.resolve().then(fn);
    inflight.set(id, pending);
    try { return await pending; } finally { inflight.delete(id); }
  }
  async function completed(row) {
    const proof = await verified(row, row.transactionHash);
    const receipt = row.response.receipt;
    check(['blockNumber', 'blockHash', 'transactionIndex', 'logIndex'].every(key => proof[key] === receipt[key]), 'SETTLEMENT_REORG', 'Recorded settlement moved or changed; reconcile the original proof and do not pay again.', 409);
    try {
      check(same(row.response.result, row.result) && receipt.resultHash === row.offer.resultHash && row.response.receiptSigner === identity.quoteSigner && verifyMessage(canonicalStringify(receipt), row.response.receiptSignature).toLowerCase() === identity.quoteSigner, 'STORE_CORRUPT', 'Stored receipt or delivered result failed verification.', 503);
    } catch (error) { if (error instanceof MoteError) throw error; fail('STORE_CORRUPT', 'Stored receipt signature is invalid.', 503); }
    return structuredClone(row.response);
  }
  return {
    config,
    async readiness() {
      const ready = !closed && store.ready();
      return { ready, mode: recoveryOnly ? 'recovery-only' : 'normal', newQuotesAllowed: ready && !recoveryOnly, publicSyntheticOnly: true, scope: 'local durable state only', chainEvidenceRefresh: 'on every quote/payment proof operation' };
    },
    async quote(body, key) {
      testnetIdempotencyKey(key);
      check(!recoveryOnly, 'RECOVERY_ONLY', 'Restored service only recovers original offers and finalized results; new quotes are disabled.', 503);
      const { prepared, input, payer, fingerprint } = prepare(body);
      const previous = store.byKey(key);
      if (previous) check(previous.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', 'Idempotency key belongs to another payer or input.', 409);
      return exclusive(`quote:${key}`, async () => {
        check(same(normalizeTestnetStoreIdentity(await adapter.verifyIdentity()), identity), 'CHAIN_IDENTITY_MISMATCH', 'Deployment changed.', 503);
        let row = previous;
        if (!row) {
          const q = { quoteId: `0x${randomBytes(32).toString('hex')}`, requestHash: prepared.requestHash, payer, amount: prepared.amount, deadline: String(time() + lifetime) };
          row = store.saveDraft({ id: q.quoteId, key, fingerprint, payer, input, result: prepared.result, draft: draftFor(prepared, q) });
        }
        if (row.offer) { verifyOffer(row.offer, prepared); return structuredClone(row.offer); }
        check(BigInt(row.draft.quote.deadline) >= BigInt(time()), 'QUOTE_EXPIRED', 'Unreturned draft expired. Use a fresh quote key; no payment was authorized by this service response.', 409);
        await hooks.beforeQuoteSigning?.(structuredClone(row));
        const signature = await quoteSigner.signTypedData(row.draft.domain, QUOTE_TYPES, row.draft.quote);
        const envelope = { ...row.draft, signature };
        const offer = { ...envelope, offerSignature: await quoteSigner.signMessage(canonicalStringify(envelope)) };
        verifyOffer(offer, prepared);
        await hooks.beforeOfferCommit?.(structuredClone(offer));
        const saved = store.saveOffer(row.id, offer);
        await hooks.afterOfferCommit?.(structuredClone(saved));
        return saved;
      });
    },
    async settle(body, key) {
      declared(body, ['quoteId', 'transactionHash', 'publicSynthetic']); testnetIdempotencyKey(key);
      check(HEX.test(body.quoteId) && HEX.test(body.transactionHash), 'INVALID_PROOF', 'Quote and transaction hashes must be 32 bytes.');
      const id = body.quoteId.toLowerCase(); const tx = body.transactionHash.toLowerCase();
      const row = store.byId(id);
      check(row?.offer, 'QUOTE_NOT_FOUND', 'Original signed offer not found. In recovery mode supply the original offer and input to /v1/recover.', 404);
      store.bindAttempt(key, id, tx);
      if (row.response) { check(row.transactionHash === tx, 'ALREADY_PAID', 'This quote already records another transaction; do not pay again.', 409); return completed(row); }
      return exclusive(id, async () => {
        let proof;
        try { proof = await verified(row, tx); }
        catch (error) { store.proofState(key, error.status === 202 ? 'pending' : error.code === 'SETTLEMENT_REORG' ? 'reorg' : 'rejected'); throw error; }
        await hooks.afterVerification?.(structuredClone(proof));
        const response = await responseFor(row, proof);
        const saved = store.saveResponse(id, tx, response);
        store.proofState(key, 'finalized');
        await hooks.afterCommit?.(structuredClone(saved));
        return saved;
      });
    },
    async order(id) {
      check(HEX.test(id), 'INVALID_QUOTE_ID', 'Invalid quote identifier.');
      const row = store.byId(id.toLowerCase());
      check(row, 'QUOTE_NOT_FOUND', 'Quote not found.', 404);
      return row.response ? completed(row) : { quoteId: row.id, status: row.offer ? 'awaiting_finalized_payment' : 'unsigned_draft', publicSynthetic: true, doNotRepay: true };
    },
    async recover(body, key) {
      testnetIdempotencyKey(key);
      const { prepared, input } = prepare(body, false);
      check(typeof body.transactionHash === 'string' && HEX.test(body.transactionHash), 'INVALID_PROOF', 'Original transaction hash is required.');
      const offer = structuredClone(body.offer);
      const draft = verifyOffer(offer, prepared);
      const id = offer.quote.quoteId.toLowerCase(); const tx = body.transactionHash.toLowerCase();
      const existing = store.byId(id);
      if (existing) {
        check(same(existing.offer, offer) && same(existing.input, input), 'RECOVERY_CONFLICT', 'Original offer or input conflicts with the stored order.', 409);
        return this.settle({ quoteId: id, transactionHash: tx, publicSynthetic: true }, key);
      }
      check(recoveryOnly, 'RECOVERY_MODE_REQUIRED', 'Missing-row reconstruction is restricted to explicit restored recovery mode.', 409);
      return exclusive(id, async () => {
        const row = { offer, input, result: prepared.result, response: null };
        const proof = await verified(row, tx);
        await hooks.afterVerification?.(structuredClone(proof));
        const response = await responseFor(row, proof);
        const payer = getAddress(offer.quote.payer).toLowerCase();
        const fingerprint = hashJson({ payer, requestHash: prepared.requestHash, publicSynthetic: true });
        const saved = store.importRecovered({ id, key, fingerprint, payer, input, result: prepared.result, draft, offer, transactionHash: tx, response });
        await hooks.afterCommit?.(structuredClone(saved));
        return saved;
      });
    },
    close() { if (closed) return; closed = true; store.close(); },
  };
}
