import { getAddress } from 'ethers';
import { actualEthereumFees, assertEthereumFeeCap, estimateEthereumFees } from './ethereum-fees.mjs';
import { canonicalStringify, hashJson, prepareAudit } from './json.mjs';
import { CLAIM_CALLDATA } from './claim-journal.mjs';
import { TestnetMoteClient, LOCAL_FIXTURE_ACKNOWLEDGMENT } from './testnet-client.mjs';
import { getTestnetNetwork } from './testnet-networks.mjs';

const LOCAL = Symbol('local claim rehearsal');
const same = (a, b) => canonicalStringify(a) === canonicalStringify(b);
export class ClaimClientError extends Error {
  constructor(code, message, cause) { super(message, { cause }); this.name = 'ClaimClientError'; this.code = code; this.doNotRepay = true; }
}
const check = (value, code, message) => { if (!value) throw new ClaimClientError(code, message); };
function loopback(value) { const url = new URL(value); check(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) && url.origin === value, 'CLAIM_FIXTURE_DENIED', 'Only a literal loopback HTTP transport is permitted.'); }

/** Automatic claim followed by paid work under one preauthorized durable wallet
 * gate. The caller-provisioned signer is trusted to honor exact transaction
 * fields. Never use that raw signer concurrently outside this authority.
 * Read-only recovery cannot acquire ownership or resume a send sequence. */
export class ClaimThenPayClient {
  static forLocalFixture({ acknowledgment, ...options }) {
    check(acknowledgment === LOCAL_FIXTURE_ACKNOWLEDGMENT, 'CLAIM_FIXTURE_DENIED', 'Explicit local-EVM acknowledgment is required.');
    loopback(options.paymentClient?.reader?.endpoint);
    loopback(options.paymentClient?.transportOrigin);
    if (options.signer) check(options.signer.provider?._getConnection?.().url === options.paymentClient.reader.endpoint, 'CLAIM_FIXTURE_DENIED', 'Fixture signer must use the same loopback provider.');
    return new ClaimThenPayClient(options, LOCAL);
  }
  constructor({ journal, paymentClient, dispenserChain, signer, finalityWaitMs = 1800000, finalityPollMs = 15000 }, fixture = null) {
    check(paymentClient instanceof TestnetMoteClient && paymentClient.policy.chainId === 11155111, 'CLAIM_PAYMENT_CLIENT_REQUIRED', 'Use the existing Ethereum Sepolia payment client and its durable journal.');
    const local = fixture === LOCAL, network = getTestnetNetwork(11155111);
    check(paymentClient.chain.config.mode === (local ? 'local-fixture' : network.slug) && dispenserChain?.identity?.mode === paymentClient.chain.config.mode, 'CLAIM_CHAIN_DENIED', 'Public onboarding rejects local fixtures or other networks.');
    check(paymentClient.reader.readOnly === true && (local || paymentClient.reader.endpoint === network.rpcUrl), 'CLAIM_READER_DENIED', 'Use the pinned read-only network source.');
    check(Number.isSafeInteger(finalityWaitMs) && finalityWaitMs >= 0 && finalityWaitMs <= 1800000 && Number.isSafeInteger(finalityPollMs) && finalityPollMs >= 100 && finalityPollMs <= 60000, 'CLAIM_WAIT_INVALID', 'Use bounded finality wait intervals.');
    check(journal?.paymentJournal === paymentClient.journal, 'CLAIM_JOURNAL_MISMATCH', 'Outer authority must bind the exact payment journal handle.');
    this.journal = journal; this.paymentClient = paymentClient; this.dispenserChain = dispenserChain;
    this.policy = Object.freeze(structuredClone(journal.context.policy)); this.reader = paymentClient.reader;
    this.signer = signer; this.finalityWaitMs = finalityWaitMs; this.finalityPollMs = finalityPollMs; this.operations = new Map();
    journal.assertContext({ policy: this.policy, dispenserIdentity: dispenserChain.identity });
    // The original payment journal writes its exact intent before calling this
    // wrapper. The outer marker is also durable before invoking the signer.
    paymentClient.signer = signer ? {
      getAddress: () => signer.getAddress(),
      sendTransaction: async request => {
        const send = journal.authorizePaymentSend(request);
        const sent = await signer.sendTransaction(request);
        journal.submittedPayment(send.key, send.step, sent.hash);
        return sent;
      },
    } : undefined;
  }
  get budget() { return this.journal.budget(); }
  async assertContext() {
    await this.paymentClient.assertContext();
    const identity = await this.dispenserChain.verifyIdentity();
    check(same(identity, this.dispenserChain.identity), 'CLAIM_IDENTITY_CHANGED', 'Dispenser identity changed during verification.');
    this.journal.assertContext({ policy: this.policy, dispenserIdentity: identity });
  }
  claimThenExecute(rawInput, { operationKey, publicSynthetic } = {}) {
    check(publicSynthetic === true, 'PUBLIC_SYNTHETIC_REQUIRED', 'Explicit public synthetic input acknowledgment is required.');
    const input = structuredClone(rawInput), prepared = prepareAudit(input);
    const prior = this.operations.get(operationKey);
    if (prior) { check(prior.requestHash === prepared.requestHash, 'CLAIM_OPERATION_CONFLICT', 'Concurrent operation key cannot change the input.'); return prior.promise; }
    const promise = this.start(input, operationKey, prepared);
    this.operations.set(operationKey, { requestHash: prepared.requestHash, promise });
    promise.finally(() => this.operations.delete(operationKey)).catch(() => {});
    return promise;
  }
  async start(input, key, prepared) {
    await this.assertContext();
    const acquired = this.journal.acquire({ key, requestHash: prepared.requestHash, resultHash: prepared.resultHash });
    if (!acquired.created) return this.recover(key);
    try {
      await this.ensureClaim(key);
      await this.assertContext();
      const offer = await this.paymentClient.quote(input, `claim-quote:${hashJson({ operationKey: key }).slice(2)}`, { publicSynthetic: true });
      this.journal.bindQuote(key, offer);
      const response = await this.paymentClient.execute(offer, key);
      this.journal.finish(key); return response;
    } catch (error) {
      try { this.journal.finish(key); }
      catch { try { this.journal.unknown(key); } catch {} }
      throw error;
    }
  }
  async ensureClaim(key) {
    const current = this.journal.claim();
    if (current.phase === 'confirmed') { await this.reconcileClaim(); return; }
    const inspection = await this.dispenserChain.inspectClaim({ payer: this.policy.payer });
    if (current.phase === 'preexisting') { check(inspection.claimed, 'CLAIM_STATE_CHANGED', 'Previously observed claimed state is no longer canonical; no new claim is sent.'); return; }
    check(current.phase === 'none', 'CLAIM_STATE_UNKNOWN', 'An attempted or uncertain claim never permits an automatic retry.');
    if (inspection.claimed) { this.journal.recordPreexisting(key, inspection); return; }
    check(inspection.eligible, 'CLAIM_UNAVAILABLE', 'Dispenser is exhausted or underfunded; no claim was submitted.');
    check(this.signer && typeof this.signer.sendTransaction === 'function' && typeof this.signer.getAddress === 'function', 'CLAIM_SIGNER_REQUIRED', 'A caller-provisioned authorized signer is required.');
    check(getAddress(await this.signer.getAddress()).toLowerCase() === this.policy.payer, 'CLAIM_PAYER_DENIED', 'Signer is not the pinned payer.');
    const balance = BigInt(await this.reader.send('eth_getBalance', [this.policy.payer, 'latest']));
    check(balance >= BigInt(this.policy.maxClaimGasWei) + BigInt(this.policy.maxPaymentGasWei), 'CLAIM_GAS_BALANCE', 'Wallet cannot cover both fixed claim and payment fee allocations. No top-up is attempted.');
    const nonce = BigInt(await this.reader.send('eth_getTransactionCount', [this.policy.payer, 'pending'])).toString();
    const intent = { type: 2, chainId: 11155111, from: this.policy.payer, to: this.policy.dispenser, nonce, value: '0', data: CLAIM_CALLDATA, gasLimit: this.policy.claimGasLimit, maxFeePerGas: this.policy.maxFeePerGas, maxPriorityFeePerGas: this.policy.maxPriorityFeePerGas };
    const estimate = await estimateEthereumFees({ reader: this.reader, transaction: intent });
    assertEthereumFeeCap({ transaction: intent, evidence: estimate, maxFeeWei: this.policy.maxClaimGasWei });
    await this.assertContext();
    const recent = await this.dispenserChain.inspectClaim({ payer: this.policy.payer });
    check(recent.eligible && !recent.claimed, 'CLAIM_STATE_CHANGED', 'Claim eligibility changed before submission; no transaction was sent.');
    check(BigInt(await this.reader.send('eth_getTransactionCount', [this.policy.payer, 'pending'])) === BigInt(nonce), 'CLAIM_NONCE_CONFLICT', 'Wallet nonce changed before claim submission.');
    this.journal.beginClaim(key, intent);
    try {
      const sent = await this.signer.sendTransaction({ ...intent, nonce: Number(nonce), value: 0n, gasLimit: BigInt(intent.gasLimit), maxFeePerGas: BigInt(intent.maxFeePerGas), maxPriorityFeePerGas: BigInt(intent.maxPriorityFeePerGas) });
      this.journal.submittedClaim(key, sent.hash);
      await this.waitForClaim();
    } catch (cause) {
      try { this.journal.unknown(key); } catch {}
      if (cause.code === 'CLAIM_REVERTED') throw cause;
      throw new ClaimClientError('CLAIM_STATE_UNKNOWN', 'Original claim may have been submitted. Keep the gate and reservations; recovery is read-only and never resubmits.', cause);
    }
  }
  async waitForClaim() {
    const deadline = performance.now() + this.finalityWaitMs;
    for (;;) {
      try { return await this.reconcileClaim(); }
      catch (error) {
        if (!['FEE_PENDING', 'FEE_NOT_FINALIZED', 'CLAIM_PENDING', 'NOT_FINALIZED'].includes(error.code)) throw error;
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new ClaimClientError('CLAIM_FINALITY_TIMEOUT', 'Claim finality wait elapsed; retain its original authority.', error);
        await new Promise(resolve => setTimeout(resolve, Math.min(remaining, this.finalityPollMs)));
      }
    }
  }
  async reconcileClaim() {
    const c = this.journal.claim();
    check(c.transactionHash && c.intent, 'CLAIM_STATE_UNKNOWN', 'No durably known original claim hash exists. Observing claimed=true cannot release an uncertain original send.');
    const fees = await actualEthereumFees({ reader: this.reader, transactionHash: c.transactionHash, expectedTransaction: c.intent });
    let claim = null;
    if (fees.success) {
      claim = await this.dispenserChain.verifyClaim({ payer: this.policy.payer, transactionHash: c.transactionHash });
      check(claim.success && claim.blockHash === fees.blockHash && BigInt(claim.blockNumber) === BigInt(fees.blockNumber) && BigInt(claim.transactionNonce) === BigInt(c.intent.nonce), 'CLAIM_PROOF_MISMATCH', 'Claim and fee proofs must identify the same finalized exact transaction.');
    }
    // The finalized head may advance on recovery; hash the immutable inclusion
    // evidence, after the verifier has checked the current canonical finality.
    const { finalized: _head, ...inclusion } = claim ?? {};
    this.journal.recordClaim({ transactionHash: fees.transactionHash, feeWei: fees.totalFeeWei, success: fees.success, blockNumber: fees.blockNumber, blockHash: fees.blockHash, transaction: fees.transaction, claimEvidenceHash: claim ? hashJson(inclusion) : null });
    check(fees.success, 'CLAIM_REVERTED', 'Original claim reverted. Its fee is recorded; no claim retry or paid task is attempted.');
    return claim;
  }
  /** Recovery may verify canonical chain evidence and retrieve a receipt. It
   * never calls a signer, creates a reservation, or resumes an old send. */
  async recover(operationKey, { originalInput, publicSynthetic } = {}) {
    await this.assertContext();
    const operation = this.journal.read(operationKey);
    check(operation, 'CLAIM_UNTRACKED', 'Recovery requires the original recorded operation key.');
    if (originalInput !== undefined) {
      check(publicSynthetic === true, 'PUBLIC_SYNTHETIC_REQUIRED', 'Recovery input must be explicitly public synthetic data.');
      const prepared = prepareAudit(originalInput);
      check(prepared.requestHash === operation.requestHash && prepared.resultHash === operation.resultHash, 'CLAIM_OPERATION_CONFLICT', 'Recovery input differs from the original task.');
    }
    const c = this.journal.claim();
    if (c.intent) await this.reconcileClaim();
    else if (c.phase === 'preexisting') check((await this.dispenserChain.inspectClaim({ payer: this.policy.payer })).claimed, 'CLAIM_STATE_CHANGED', 'Previously claimed state is no longer canonical.');
    const row = operation.quoteId ? this.paymentClient.journal.read(operation.quoteId) : null;
    if (!row) {
      const ended = this.journal.finish(operationKey);
      return { status: ended.phase === 'cancelled' ? 'cancelled_before_submission' : 'claim_finalized_no_payment', claimTransactionHash: c.transactionHash, operationKey, noTransactionsSubmittedDuringRecovery: true };
    }
    try {
      const response = originalInput === undefined
        ? await this.paymentClient.recover(row.offer, row.paymentHash, operationKey)
        : await this.paymentClient.recoverFromOriginalInput(row.offer, originalInput, row.paymentHash, operationKey, { publicSynthetic: true });
      this.journal.finish(operationKey); return response;
    } catch (error) { try { this.journal.finish(operationKey); } catch {} throw error; }
  }
}

export function claimThenExecute(client, input, options) { return client.claimThenExecute(input, options); }
