import { Contract, getAddress, verifyMessage, verifyTypedData } from 'ethers';
import { QUOTE_TYPES } from './chain.mjs';
import { canonicalStringify, requestHash, hashJson } from './json.mjs';

const TOKEN_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];
const PAYMENTS_ABI = [
  'function token() view returns (address)',
  'function merchant() view returns (address)',
  'function quoteSigner() view returns (address)',
  'function consumed(bytes32) view returns (bool)',
  'function pay((bytes32 quoteId,bytes32 requestHash,address payer,uint256 amount,uint256 deadline),bytes signature)',
  'event Paid(bytes32 indexed quoteId,bytes32 indexed requestHash,address indexed payer,uint256 amount)',
];
const APPROVE_GAS = 100_000n;
const PAY_GAS = 250_000n;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

export class PolicyError extends Error {
  constructor(code, message) { super(message); this.name = 'PolicyError'; this.code = code; }
}

export class PaymentStateUnknown extends Error {
  constructor(message, { quoteId, transactionHash, cause } = {}) {
    super(message, { cause });
    this.name = 'PaymentStateUnknown';
    this.code = 'PAYMENT_STATE_UNKNOWN';
    this.quoteId = quoteId;
    this.transactionHash = transactionHash;
    this.doNotRepay = true;
  }
}

function check(ok, code, message) { if (!ok) throw new PolicyError(code, message); }
function uint(value, name) {
  check(typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value), 'INVALID_INTEGER', `${name} must be a nonnegative integer string in base units`);
  return BigInt(value);
}
function address(value, name) {
  try { return getAddress(value); } catch { throw new PolicyError('INVALID_ADDRESS', `${name} is not an EVM address`); }
}
function sameAddress(a, b) { return address(a, 'address') === address(b, 'address'); }
function actualFee(receipt) { return receipt.fee ?? (receipt.gasUsed * receipt.gasPrice); }
function validateKey(value) { check(typeof value === 'string' && /^[a-zA-Z0-9._:-]{8,128}$/.test(value), 'INVALID_IDEMPOTENCY_KEY', 'Use an 8–128 character idempotency key'); }

/**
 * Local fixture client. The policy is supplied by the caller, never by a server
 * manifest. Reservations and transaction history are scoped to this instance.
 * A fresh client must reconcile outstanding transactions before receiving a new
 * budget. This is intentionally not a durable production wallet.
 */
export class MoteClient {
  constructor({ baseUrl, signer, provider, policy = {} }) {
    const url = new URL(baseUrl);
    check(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname), 'LOCAL_ONLY', 'This fixture client only permits loopback HTTP services');
    check(url.username === '' && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === '', 'INVALID_ORIGIN', 'baseUrl must be an origin without credentials or path');
    this.baseUrl = url.origin;
    this.signer = signer;
    this.provider = provider;
    this.policy = Object.freeze(structuredClone(policy));
    this.entries = new Map();
    this.offers = new Map();
    this.tail = Promise.resolve();
    this.tokenReserved = 0n;
    this.tokenSpent = 0n;
    this.gasReserved = 0n;
    this.gasSpent = 0n;
  }

  get budget() {
    return {
      tokenReserved: this.tokenReserved.toString(), tokenSpent: this.tokenSpent.toString(),
      gasReservedWei: this.gasReserved.toString(), gasSpentWei: this.gasSpent.toString(),
    };
  }

  async request(path, body, idempotencyKey) {
    if (body !== undefined) validateKey(idempotencyKey);
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1_048_576) { await reader.cancel(); throw new PolicyError('RESPONSE_TOO_LARGE', 'Service response exceeded 1 MiB'); }
      chunks.push(value);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!response.ok || data.error) {
      const error = new Error(data.error?.message ?? data.message ?? `HTTP ${response.status}`);
      error.code = data.error?.code ?? data.code ?? `HTTP_${response.status}`;
      error.status = response.status;
      throw error;
    }
    return data;
  }

  discover() { return this.request('/.well-known/mote.json'); }

  async quote(input, idempotencyKey) {
    const snapshot = structuredClone(input);
    const payer = await this.signer.getAddress();
    const offer = await this.request('/v1/quotes', { payer, input: snapshot }, idempotencyKey);
    check(offer.quote?.requestHash === requestHash(snapshot), 'REQUEST_MISMATCH', 'The offer does not bind the requested input');
    check(HEX32.test(offer.quote?.quoteId ?? ''), 'INVALID_QUOTE', 'Invalid quote ID');
    this.offers.set(offer.quote.quoteId, structuredClone(offer));
    return offer;
  }

  async validateOffer(offer, { allowExpired = false, requireKnown = true } = {}) {
    const p = this.policy;
    check(p.enabled === true, 'SPENDING_DISABLED', 'Spending requires an explicitly enabled caller policy');
    check(p.chainId === 31337 && offer.chainId === 31337, 'CHAIN_DENIED', 'Only the local fixture chain 31337 is supported');
    check(p.serviceOrigin === this.baseUrl, 'ORIGIN_DENIED', 'Service origin is not allowed by the caller policy');
    check(offer.protocol === 'mote-local-v1' && offer.service === 'json.audit', 'PROTOCOL_DENIED', 'Unsupported service or payment protocol');
    check(offer.asset === 'MOTE' && offer.decimals === 6, 'ASSET_DENIED', 'Unexpected asset metadata');
    check(sameAddress(offer.token, p.token) && sameAddress(offer.router, p.router) && sameAddress(offer.recipient, p.recipient), 'DESTINATION_DENIED', 'Asset, router or recipient is outside the caller allowlist');
    check(offer.domain?.name === 'MotePayments' && offer.domain.version === '1' && offer.domain.chainId === 31337 && sameAddress(offer.domain.verifyingContract, p.router), 'DOMAIN_DENIED', 'Invalid EIP-712 payment domain');
    check(Object.keys(offer.domain).sort().join(',') === 'chainId,name,verifyingContract,version', 'DOMAIN_DENIED', 'Unexpected EIP-712 domain fields');
    const q = offer.quote;
    check(q && HEX32.test(q.quoteId) && HEX32.test(q.requestHash) && HEX32.test(offer.resultHash), 'INVALID_QUOTE', 'Quote hashes must be 32 bytes');
    const amount = uint(q.amount, 'quote.amount');
    const deadline = uint(q.deadline, 'quote.deadline');
    check(amount > 0n && amount <= uint(p.maxSingleSpend, 'maxSingleSpend'), 'SINGLE_LIMIT', 'Quoted amount exceeds the single-payment limit');
    check(allowExpired || deadline > BigInt(Math.floor(Date.now() / 1000)), 'QUOTE_EXPIRED', 'Quote has expired');
    check(sameAddress(q.payer, p.payer) && sameAddress(await this.signer.getAddress(), p.payer), 'PAYER_DENIED', 'Quote payer does not match the authorized fixture account');
    check(this.signer.provider === this.provider, 'PROVIDER_MISMATCH', 'Signer and verifier must share the same provider');
    check((await this.provider.getNetwork()).chainId === 31337n, 'CHAIN_DENIED', 'Connected provider is not the local fixture chain');
    if (requireKnown) {
      const known = this.offers.get(q.quoteId);
      check(known && JSON.stringify(known) === JSON.stringify(offer), 'OFFER_NOT_REQUESTED', 'Only an unchanged offer returned by this client can authorize spending');
    }
    const router = new Contract(p.router, PAYMENTS_ABI, this.signer);
    const token = new Contract(p.token, TOKEN_ABI, this.signer);
    const [chainToken, merchant, signer] = await Promise.all([router.token(), router.merchant(), router.quoteSigner()]);
    check(sameAddress(chainToken, p.token) && sameAddress(merchant, p.recipient), 'CONTRACT_MISMATCH', 'Router configuration does not match caller policy');
    let recovered;
    try { recovered = verifyTypedData(offer.domain, QUOTE_TYPES, q, offer.signature); }
    catch { throw new PolicyError('INVALID_SIGNATURE', 'Offer signature could not be verified'); }
    check(sameAddress(recovered, signer), 'INVALID_SIGNATURE', 'Offer was not signed by the configured quote signer');
    const { offerSignature, ...envelope } = offer;
    let envelopeSigner;
    try { envelopeSigner = verifyMessage(canonicalStringify(envelope), offerSignature); }
    catch { throw new PolicyError('INVALID_OFFER_SIGNATURE', 'Full offer signature could not be verified'); }
    check(sameAddress(envelopeSigner, signer), 'INVALID_OFFER_SIGNATURE', 'Offer metadata and promised result hash are not authenticated');
    if (offer.quoteSigner !== undefined) check(sameAddress(offer.quoteSigner, signer), 'CONTRACT_MISMATCH', 'Offer signer metadata does not match the router');
    return { router, token, amount, quoteSigner: signer };
  }

  reserve(offer, amount) {
    const gas = 2n * uint(this.policy.maxGasPerTransactionWei, 'maxGasPerTransactionWei');
    check(this.tokenSpent + this.tokenReserved + amount <= uint(this.policy.maxTotalSpend, 'maxTotalSpend'), 'TOTAL_LIMIT', 'Concurrent token reservations would exceed the total budget');
    check(this.gasSpent + this.gasReserved + gas <= uint(this.policy.maxGasTotalWei, 'maxGasTotalWei'), 'GAS_TOTAL_LIMIT', 'Concurrent fee reservations would exceed the native-fee budget');
    const entry = { offer, amount, tokenReserved: amount, gasReserved: gas, status: 'reserved', transactionHash: null, approvalHash: null, promise: null };
    this.tokenReserved += amount;
    this.gasReserved += gas;
    this.entries.set(offer.quote.quoteId, entry);
    return entry;
  }

  releaseToken(entry, spent = false) {
    this.tokenReserved -= entry.tokenReserved;
    if (spent) this.tokenSpent += entry.tokenReserved;
    entry.tokenReserved = 0n;
  }

  chargeGas(entry, receipt, reservedCap) {
    const released = reservedCap > entry.gasReserved ? entry.gasReserved : reservedCap;
    this.gasReserved -= released;
    entry.gasReserved -= released;
    this.gasSpent += actualFee(receipt);
  }

  releaseGas(entry, keep = 0n) {
    const retained = keep < entry.gasReserved ? keep : entry.gasReserved;
    this.gasReserved -= entry.gasReserved - retained;
    entry.gasReserved = retained;
  }

  async execute(rawOffer, idempotencyKey) {
    validateKey(idempotencyKey);
    const offer = structuredClone(rawOffer);
    const knownEntry = this.entries.get(offer.quote?.quoteId);
    if (knownEntry) {
      check(JSON.stringify(knownEntry.offer) === JSON.stringify(offer), 'QUOTE_CONFLICT', 'Quote ID cannot be reused with a different offer');
      if (knownEntry.promise) return knownEntry.promise;
      if (knownEntry.status === 'complete') return knownEntry.response;
      if (['settled', 'unknown'].includes(knownEntry.status)) return this.recover(offer, knownEntry.transactionHash, idempotencyKey);
      throw new PolicyError('PREVIOUS_ATTEMPT_FAILED', 'This attempt failed; obtain a new quote before a new authorized payment');
    }
    const validated = await this.validateOffer(offer);
    // Atomic within this client: no awaits occur between the recheck and reserve.
    if (this.entries.has(offer.quote.quoteId)) return this.execute(offer, idempotencyKey);
    const entry = this.reserve(offer, validated.amount);
    entry.quoteSigner = validated.quoteSigner;
    const task = this.tail.then(() => this.pay(entry, validated, idempotencyKey));
    this.tail = task.catch(() => {});
    entry.promise = task;
    try { return await task; } finally { entry.promise = null; }
  }

  async pay(entry, { router, token }, key) {
    const offer = entry.offer;
    const cap = uint(this.policy.maxGasPerTransactionWei, 'maxGasPerTransactionWei');
    try {
      check(!(await router.consumed(offer.quote.quoteId)), 'ALREADY_PAID', 'This quote was already paid; use recover instead of sending another payment');
      const block = await this.provider.getBlock('latest');
      check(BigInt(block.timestamp) <= BigInt(offer.quote.deadline), 'QUOTE_EXPIRED', 'Quote expired on the local chain');
      check(await token.balanceOf(offer.quote.payer) >= entry.amount, 'INSUFFICIENT_BALANCE', 'Fixture token balance is too small');
      const fees = await this.provider.getFeeData();
      const gasPrice = fees.gasPrice;
      check(gasPrice > 0n && gasPrice * PAY_GAS <= cap && gasPrice * APPROVE_GAS <= cap, 'GAS_TRANSACTION_LIMIT', 'Bounded transaction fee exceeds caller policy');
      check(await this.provider.getBalance(offer.quote.payer) >= gasPrice * (APPROVE_GAS + PAY_GAS), 'INSUFFICIENT_GAS', 'Fixture account cannot cover the bounded native fees');
      // Approve only this quote's exact amount, never an unlimited allowance.
      entry.status = 'approval-submitting';
      const approval = await token.approve(offer.router, entry.amount, { gasLimit: APPROVE_GAS, gasPrice });
      entry.approvalHash = approval.hash;
      const approvalReceipt = await approval.wait();
      this.chargeGas(entry, approvalReceipt, cap);
      check(approvalReceipt.status === 1, 'APPROVAL_REVERTED', 'Exact approval reverted');
      entry.status = 'payment-submitting';
      const payment = await router.pay(offer.quote, offer.signature, { gasLimit: PAY_GAS, gasPrice });
      entry.transactionHash = payment.hash;
      const receipt = await payment.wait();
      this.chargeGas(entry, receipt, cap);
      check(receipt.status === 1, 'PAYMENT_REVERTED', 'Payment reverted');
      this.releaseToken(entry, true);
      this.releaseGas(entry);
      entry.chainReceipt = receipt;
      entry.status = 'settled';
      return await this.deliver(entry, key);
    } catch (error) {
      if (entry.status === 'settled') throw error; // Delivery retry never repays.
      if (error.receipt?.status === 0) {
        let canonical = false;
        try { canonical = (await this.provider.getBlock(error.receipt.blockNumber))?.hash === error.receipt.blockHash; } catch { /* retain reservations below */ }
        if (!canonical) {
          entry.uncertainStage = entry.status;
          entry.status = 'unknown';
          throw new PaymentStateUnknown('A reverted receipt could not be confirmed in the canonical local chain. Reservation retained; do not repay.', { quoteId: offer.quote.quoteId, transactionHash: entry.transactionHash, cause: error });
        }
        this.chargeGas(entry, error.receipt, cap);
        this.releaseToken(entry);
        this.releaseGas(entry);
        entry.status = 'failed';
        throw error;
      }
      if (['approval-submitting', 'payment-submitting'].includes(entry.status)) {
        entry.uncertainStage = entry.status;
        entry.status = 'unknown';
        throw new PaymentStateUnknown('Transaction outcome is uncertain. Reservation retained; reconcile before any new payment.', { quoteId: offer.quote.quoteId, transactionHash: entry.transactionHash, cause: error });
      }
      this.releaseToken(entry);
      this.releaseGas(entry);
      entry.status = 'failed';
      throw error;
    }
  }

  async deliver(entry, key) {
    try {
    const response = await this.request('/v1/orders', { quoteId: entry.offer.quote.quoteId, transactionHash: entry.transactionHash }, key);
    check(hashJson(response.result) === entry.offer.resultHash, 'RESULT_MISMATCH', 'Delivered result does not match the quoted hash');
    const r = response.receipt;
    const offer = entry.offer;
    check(r?.protocol === 'mote-local-v1' && r.localOnly === true && r.quoteId === offer.quote.quoteId && r.transactionHash?.toLowerCase() === entry.transactionHash.toLowerCase() && r.requestHash === offer.quote.requestHash && r.resultHash === offer.resultHash, 'RECEIPT_MISMATCH', 'Receipt does not bind the settled quote and result');
    check(r.chainId === 31337 && r.asset === 'MOTE' && r.amount === offer.quote.amount && sameAddress(r.payer, offer.quote.payer) && sameAddress(r.token, offer.token) && sameAddress(r.router, offer.router) && sameAddress(r.recipient, offer.recipient), 'RECEIPT_MISMATCH', 'Receipt payment fields differ from the exact offer');
    check(r.blockNumber === entry.chainReceipt.blockNumber && r.blockHash === entry.chainReceipt.blockHash && entry.chainReceipt.logs.some((log) => log.index === r.logIndex && sameAddress(log.address, offer.router)), 'RECEIPT_MISMATCH', 'Receipt does not identify the confirmed local-chain log');
    check(sameAddress(r.quoteSigner, entry.quoteSigner) && sameAddress(response.receiptSigner, entry.quoteSigner), 'RECEIPT_SIGNATURE', 'Receipt signer differs from the router quote signer');
    let receiptSigner;
    try { receiptSigner = verifyMessage(canonicalStringify(r), response.receiptSignature); }
    catch { throw new PolicyError('RECEIPT_SIGNATURE', 'Receipt signature could not be verified'); }
    check(sameAddress(receiptSigner, entry.quoteSigner), 'RECEIPT_SIGNATURE', 'Receipt signature is invalid');
    entry.status = 'complete';
    entry.response = response;
    return response;
    } catch (error) {
      error.quoteId = entry.offer.quote.quoteId;
      error.transactionHash = entry.transactionHash;
      error.doNotRepay = true;
      error.settlementState = 'confirmed';
      throw error;
    }
  }

  async recover(rawOffer, transactionHash, idempotencyKey) {
    validateKey(idempotencyKey);
    const offer = structuredClone(rawOffer);
    const { router, quoteSigner } = await this.validateOffer(offer, { allowExpired: true, requireKnown: false });
    let entry = this.entries.get(offer.quote.quoteId);
    if (!entry) {
      // Recovery never signs or sends transactions. Past payment is counted in
      // this instance's budget, even if another instance originally sent it.
      entry = { offer, amount: BigInt(offer.quote.amount), tokenReserved: 0n, gasReserved: 0n, status: 'external-recovery', transactionHash: null };
      this.entries.set(offer.quote.quoteId, entry);
    }
    check(JSON.stringify(entry.offer) === JSON.stringify(offer), 'QUOTE_CONFLICT', 'Recovery offer differs from the attempted offer');
    entry.quoteSigner = quoteSigner;
    check(!transactionHash || !entry.transactionHash || transactionHash.toLowerCase() === entry.transactionHash.toLowerCase(), 'TRANSACTION_CONFLICT', 'Recovery must reconcile the original submitted payment hash');
    if (entry.status === 'complete') return entry.response;
    if (entry.promise) return entry.promise;
    const task = this.reconcile(entry, router, transactionHash, idempotencyKey);
    entry.promise = task;
    try { return await task; } finally { entry.promise = null; }
  }

  async reconcile(entry, router, transactionHash, idempotencyKey) {
    const offer = entry.offer;
    let hash = transactionHash ?? entry.transactionHash;
    if (!hash) {
      const events = await router.queryFilter(router.filters.Paid(offer.quote.quoteId));
      if (events.length === 1) hash = events[0].transactionHash;
    }
    if (!hash) throw new PaymentStateUnknown('No settled payment found. No new transaction was sent; inspect the original transaction or exact allowance before requesting a new quote.', { quoteId: offer.quote.quoteId });
    check(HEX32.test(hash), 'INVALID_TRANSACTION', 'Transaction hash must be 32 bytes');
    const receipt = await this.provider.getTransactionReceipt(hash);
    if (!receipt) throw new PaymentStateUnknown('Payment is still pending or its outcome is unknown; do not repay.', { quoteId: offer.quote.quoteId, transactionHash: hash });
    const block = await this.provider.getBlock(receipt.blockNumber);
    check(block?.hash === receipt.blockHash, 'SETTLEMENT_REORG', 'Payment block is no longer canonical; do not repay');
    if (receipt.status === 0) {
      const transaction = await this.provider.getTransaction(hash);
      let decoded;
      try { decoded = router.interface.parseTransaction(transaction); } catch { /* reject below */ }
      const quoted = decoded?.args?.[0];
      check(transaction && sameAddress(transaction.from, offer.quote.payer) && transaction.to && sameAddress(transaction.to, offer.router) && decoded?.name === 'pay' && quoted.quoteId === offer.quote.quoteId && quoted.requestHash === offer.quote.requestHash && sameAddress(quoted.payer, offer.quote.payer) && quoted.amount === BigInt(offer.quote.amount) && quoted.deadline === BigInt(offer.quote.deadline) && decoded.args[1] === offer.signature, 'PAYMENT_PROOF_MISMATCH', 'Reverted transaction does not identify the original exact payment');
      if (entry.status === 'unknown' && !entry.transactionHash) {
        throw new PaymentStateUnknown('The original submission hash was not recorded. A reverted replay cannot prove it was uncharged; recover without a hash to locate the canonical Paid event.', { quoteId: offer.quote.quoteId });
      }
      check(entry.uncertainStage !== 'approval-submitting', 'APPROVAL_STATE_UNKNOWN', 'An unrelated payment failure cannot resolve an uncertain approval');
      if (entry.status !== 'failed') {
        if (entry.status === 'unknown') this.chargeGas(entry, receipt, uint(this.policy.maxGasPerTransactionWei, 'maxGasPerTransactionWei'));
        this.releaseToken(entry); this.releaseGas(entry); entry.status = 'failed';
      }
      throw new PolicyError('PAYMENT_REVERTED', 'Original payment reverted; recovery did not send a new payment');
    }
    const match = receipt.logs.some((log) => {
      if (!sameAddress(log.address, offer.router)) return false;
      let parsed; try { parsed = router.interface.parseLog(log); } catch { return false; }
      return parsed?.name === 'Paid' && parsed.args.quoteId === offer.quote.quoteId && parsed.args.requestHash === offer.quote.requestHash && sameAddress(parsed.args.payer, offer.quote.payer) && parsed.args.amount === BigInt(offer.quote.amount);
    });
    check(match, 'PAYMENT_PROOF_MISMATCH', 'Transaction lacks the exact router payment event');
    if (!['settled', 'complete'].includes(entry.status)) {
      const wasExternal = ['external-recovery', 'failed'].includes(entry.status);
      let unresolvedApprovalCap = 0n;
      if (entry.status === 'unknown') {
        const cap = uint(this.policy.maxGasPerTransactionWei, 'maxGasPerTransactionWei');
        if (entry.gasReserved > cap) {
          const approvalReceipt = entry.approvalHash ? await this.provider.getTransactionReceipt(entry.approvalHash) : null;
          if (approvalReceipt) this.chargeGas(entry, approvalReceipt, cap);
          else unresolvedApprovalCap = cap;
        }
        this.chargeGas(entry, receipt, cap);
      }
      this.releaseToken(entry, true);
      if (wasExternal) { this.tokenSpent += entry.amount; this.gasSpent += actualFee(receipt); }
      // A matching Paid log proves token settlement, but it cannot establish
      // the fee outcome of an earlier approval whose submission was unknown.
      this.releaseGas(entry, unresolvedApprovalCap);
    }
    entry.transactionHash = hash;
    entry.chainReceipt = receipt;
    entry.status = 'settled';
    return this.deliver(entry, idempotencyKey);
  }
}
