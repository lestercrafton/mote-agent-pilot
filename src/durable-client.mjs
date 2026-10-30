import { Contract, getAddress, keccak256, verifyMessage } from 'ethers';
import { MoteClient, PaymentStateUnknown, PolicyError } from './client.mjs';
import { canonicalStringify, hashJson } from './json.mjs';

const TOKEN_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];
const ROUTER_ABI = [
  'function token() view returns (address)',
  'function merchant() view returns (address)',
  'function quoteSigner() view returns (address)',
  'function consumed(bytes32) view returns (bool)',
  'function pay((bytes32 quoteId,bytes32 requestHash,address payer,uint256 amount,uint256 deadline),bytes signature)',
  'event Paid(bytes32 indexed quoteId,bytes32 indexed requestHash,address indexed payer,uint256 amount)',
];
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const APPROVAL_GAS = 100_000n;
const PAYMENT_GAS = 250_000n;

function check(ok, code, message) { if (!ok) throw new PolicyError(code, message); }
function sameAddress(a, b) { return getAddress(a) === getAddress(b); }
function validateKey(key) { check(typeof key === 'string' && /^[a-zA-Z0-9._:-]{8,128}$/.test(key), 'INVALID_IDEMPOTENCY_KEY', 'Use an 8–128 character idempotency key'); }
function sameOffer(a, b) { return canonicalStringify(a) === canonicalStringify(b); }
function fee(receipt) { return receipt.fee ?? receipt.gasUsed * receipt.gasPrice; }
function ledgerProof({ receipt, ...proof }) { return proof; }

/** Immutable local-chain context; this contains no keys or credentials. */
export async function readChainIdentity(provider, policy) {
  check(policy.chainId === 31337 && BigInt(await provider.send('eth_chainId', [])) === 31337n, 'CHAIN_DENIED', 'Durable fixture mode only supports local chain 31337');
  const routerInterface = new Contract(policy.router, ROUTER_ABI).interface;
  const readAddress = async (name) => routerInterface.decodeFunctionResult(name,
    await provider.send('eth_call', [{ to: policy.router, data: routerInterface.encodeFunctionData(name) }, 'latest']))[0];
  // Use raw read RPCs so a provider's short request cache cannot hide a local
  // chain reset at the boundary of a new reservation or reconciliation.
  const [genesis, tokenCode, routerCode, quoteSigner, token, merchant] = await Promise.all([
    provider.send('eth_getBlockByNumber', ['0x0', false]),
    provider.send('eth_getCode', [policy.token, 'latest']),
    provider.send('eth_getCode', [policy.router, 'latest']),
    readAddress('quoteSigner'), readAddress('token'), readAddress('merchant'),
  ]);
  check(genesis?.hash && tokenCode !== '0x' && routerCode !== '0x', 'CHAIN_IDENTITY_INVALID', 'Local-chain genesis and deployed contracts are required');
  check(sameAddress(token, policy.token) && sameAddress(merchant, policy.recipient), 'CONTRACT_MISMATCH', 'Deployed router differs from the authorized policy');
  check(policy.quoteSigner === undefined || sameAddress(quoteSigner, policy.quoteSigner), 'CONTRACT_MISMATCH', 'Deployed quote signer differs from the authorized policy');
  return {
    chainId: 31337,
    genesisHash: genesis.hash,
    quoteSigner: getAddress(quoteSigner),
    tokenCodeHash: keccak256(tokenCode),
    routerCodeHash: keccak256(routerCode),
  };
}

/**
 * Optional SQLite-backed fixture client. The caller explicitly creates/opens a
 * journal and supplies it here. Existing records are NEVER submission permits.
 * A process restart can only reconcile them; uncertain intent holds its budget
 * and non-expiring wallet gate until exact original chain evidence resolves it.
 */
export class DurableMoteClient extends MoteClient {
  constructor({ journal, ...options }) {
    super(options);
    check(journal && typeof journal.reserve === 'function' && typeof journal.assertContext === 'function', 'JOURNAL_REQUIRED', 'Supply an explicitly initialized or reopened SQLiteBudgetJournal');
    this.journal = journal;
    this.operations = new Map();
    this.operationProofs = new Map();
  }

  get budget() { return this.journal.budget(); }

  async assertContext() {
    const chainIdentity = await readChainIdentity(this.provider, this.policy);
    this.journal.assertContext({ policy: this.policy, chainIdentity });
    return chainIdentity;
  }

  requireTracked(offer, key) {
    const row = this.journal.read(offer.quote.quoteId);
    check(row, 'UNTRACKED_QUOTE', 'Durable recovery requires a quote already reserved in this journal');
    check(sameOffer(row.offer, offer), 'QUOTE_CONFLICT', 'Persisted offer differs from the supplied offer');
    check(row.idempotencyKey === key, 'IDEMPOTENCY_CONFLICT', 'Use the original persisted order idempotency key');
    check(row.phase !== 'cancelled', 'ATTEMPT_CANCELLED', 'This attempt was cancelled before submission; its reservations and wallet gate were released. Obtain a fresh quote. This cancelled quote cannot authorize another payment.');
    return row;
  }

  reuseOperation(offer, key, transactionHash = null) {
    const row = this.requireTracked(offer, key);
    if (transactionHash) {
      const activeHash = row.paymentHash ?? this.operationProofs.get(offer.quote.quoteId) ?? row.observedPayment?.transactionHash;
      check(activeHash, 'RECOVERY_IN_FLIGHT', 'An active operation has not yet identified a payment hash; an explicit proof cannot be silently substituted');
      check(transactionHash.toLowerCase() === activeHash.toLowerCase(), 'TRANSACTION_CONFLICT', 'Concurrent recovery supplied a different payment hash');
    }
    return this.operations.get(offer.quote.quoteId);
  }

  async execute(rawOffer, idempotencyKey) {
    validateKey(idempotencyKey);
    const offer = structuredClone(rawOffer);
    const quoteId = offer.quote?.quoteId;
    check(HEX32.test(quoteId ?? ''), 'INVALID_QUOTE', 'Quote ID must be 32 bytes');
    if (this.operations.has(quoteId)) return this.reuseOperation(offer, idempotencyKey);
    await this.assertContext();
    if (this.journal.read(quoteId)) return this.recover(offer, null, idempotencyKey);
    const validated = await super.validateOffer(offer);
    // reserve atomically checks the full shared budgets, writes the immutable
    // offer, and acquires the wallet gate. Only created:true authorizes new work.
    const reservation = this.journal.reserve(offer, idempotencyKey);
    if (!reservation.created) return this.recover(offer, null, idempotencyKey);
    const task = this.performNew(offer, validated, idempotencyKey);
    this.operations.set(quoteId, task);
    try { return await task; } finally { this.operations.delete(quoteId); this.operationProofs.delete(quoteId); }
  }

  async rawNonce() {
    // Avoid ethers' short cache across the approval -> payment boundary.
    const value = BigInt(await this.provider.send('eth_getTransactionCount', [this.policy.payer, 'pending']));
    check(value <= BigInt(Number.MAX_SAFE_INTEGER), 'NONCE_RANGE', 'Fixture nonce is outside the supported integer range');
    return value;
  }

  makeIntent(to, data, gasLimit, gasPrice, nonce) {
    return {
      from: getAddress(this.policy.payer), to: getAddress(to), data,
      value: '0', chainId: '31337', nonce: nonce.toString(),
      gasLimit: gasLimit.toString(), gasPrice: gasPrice.toString(),
    };
  }

  async sendIntent(quoteId, step, expectedPhase, intent) {
    // The exact request is written durably before the signer sees it. There is
    // no lease expiry or restarted-process send path through this method.
    this.journal.beginIntent(quoteId, expectedPhase, step, intent);
    const sent = await this.signer.sendTransaction({
      ...intent,
      nonce: Number(intent.nonce), chainId: BigInt(intent.chainId), value: 0n,
      gasLimit: BigInt(intent.gasLimit), gasPrice: BigInt(intent.gasPrice),
    });
    this.journal.markSubmitted(quoteId, step, sent.hash);
    return sent;
  }

  async performNew(offer, { router, token }, key) {
    const id = offer.quote.quoteId;
    let activeStep = null;
    try {
      check(!(await router.consumed(id)), 'ALREADY_PAID', 'Quote is already paid; only read-only reconciliation is permitted');
      const block = await this.provider.getBlock('latest');
      check(BigInt(block.timestamp) <= BigInt(offer.quote.deadline), 'QUOTE_EXPIRED', 'Quote expired on the local chain');
      const amount = BigInt(offer.quote.amount);
      check(await token.balanceOf(offer.quote.payer) >= amount, 'INSUFFICIENT_BALANCE', 'Fixture token balance is too small');
      const gasPrice = (await this.provider.getFeeData()).gasPrice;
      const cap = BigInt(this.policy.maxGasPerTransactionWei);
      check(gasPrice > 0n && gasPrice * APPROVAL_GAS <= cap && gasPrice * PAYMENT_GAS <= cap, 'GAS_TRANSACTION_LIMIT', 'Transaction fee cap exceeds the caller policy');
      check(await this.provider.getBalance(offer.quote.payer) >= gasPrice * (APPROVAL_GAS + PAYMENT_GAS), 'INSUFFICIENT_GAS', 'Fixture account cannot cover bounded native fees');
      const tokenInterface = new Contract(offer.token, TOKEN_ABI).interface;
      const approvalNonce = await this.rawNonce();
      const approvalIntent = this.makeIntent(offer.token, tokenInterface.encodeFunctionData('approve', [offer.router, amount]), APPROVAL_GAS, gasPrice, approvalNonce);
      activeStep = 'approval';
      const approval = await this.sendIntent(id, 'approval', 'reserved', approvalIntent);
      await approval.wait(1, 10_000);
      const approvalProof = await this.proofFor(approval.hash);
      this.journal.recordApproval(id, ledgerProof(approvalProof));
      check(approvalProof.success, 'APPROVAL_REVERTED', 'Exact approval reverted');
      await this.assertContext();
      const paymentNonce = await this.rawNonce();
      check(paymentNonce === approvalNonce + 1n, 'NONCE_CONFLICT', 'Wallet nonce changed outside this gated workflow; do not resubmit');
      const paymentIntent = this.makeIntent(offer.router, router.interface.encodeFunctionData('pay', [offer.quote, offer.signature]), PAYMENT_GAS, gasPrice, paymentNonce);
      activeStep = 'payment';
      const payment = await this.sendIntent(id, 'payment', 'approved', paymentIntent);
      await payment.wait(1, 10_000);
      const paymentProof = await this.proofFor(payment.hash);
      this.verifyPaidProof(offer, paymentProof, router);
      this.journal.recordPayment(id, ledgerProof(paymentProof));
      check(paymentProof.success, 'PAYMENT_REVERTED', 'Payment reverted');
      return await this.deliverDurable(offer, paymentProof.receipt, key);
    } catch (error) {
      let row;
      try { row = this.journal.read(id); } catch { /* fail closed on a lost journal */ }
      if (row && ['settled', 'complete'].includes(row.phase)) {
        this.annotateDelivery(error, offer, row.paymentHash);
        throw error;
      }
      if (row?.phase === 'reserved') {
        this.journal.cancelReserved(id);
        throw error;
      }
      if (row && ['failed', 'cancelled'].includes(row.phase)) throw error;
      if (row && activeStep && error.receipt?.status === 0) {
        const hash = activeStep === 'approval' ? row.approvalHash : row.paymentHash;
        if (hash) {
          try {
            const proof = await this.proofFor(hash);
            if (!proof.success) {
              this.journal[activeStep === 'approval' ? 'recordApproval' : 'recordPayment'](id, ledgerProof(proof));
              throw new PolicyError(activeStep === 'approval' ? 'APPROVAL_REVERTED' : 'PAYMENT_REVERTED', 'Original transaction reverted canonically; no retry was submitted');
            }
          } catch (proofError) {
            if (['APPROVAL_REVERTED', 'PAYMENT_REVERTED'].includes(proofError.code)) throw proofError;
          }
        }
      }
      if (row && activeStep) {
        try { this.journal.markUnknown(id, activeStep); } catch { /* persisted intent already fails closed */ }
      }
      throw new PaymentStateUnknown('Durable transaction intent requires read-only reconciliation. Its reservations and wallet gate remain; do not repay.', { quoteId: id, transactionHash: row?.paymentHash ?? undefined, cause: error });
    }
  }

  async proofFor(transactionHash) {
    check(HEX32.test(transactionHash ?? ''), 'INVALID_TRANSACTION', 'Transaction hash must be 32 bytes');
    const receipt = await this.provider.getTransactionReceipt(transactionHash);
    if (!receipt) throw new PaymentStateUnknown('Original transaction is pending or unknown; no new transaction was sent.', { transactionHash });
    const [block, tx] = await Promise.all([this.provider.getBlock(receipt.blockNumber), this.provider.getTransaction(transactionHash)]);
    check(block?.hash === receipt.blockHash, 'SETTLEMENT_REORG', 'Receipt is no longer in the canonical local chain; keep reservations');
    check(tx && tx.hash.toLowerCase() === transactionHash.toLowerCase() && tx.to, 'PAYMENT_PROOF_MISMATCH', 'Canonical transaction data is unavailable');
    check(tx.blockHash === receipt.blockHash && tx.blockNumber === receipt.blockNumber, 'PAYMENT_PROOF_MISMATCH', 'Transaction and receipt identify different canonical blocks');
    return {
      transactionHash, feeWei: fee(receipt).toString(), success: receipt.status === 1,
      blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
      transaction: {
        nonce: String(tx.nonce), to: getAddress(tx.to), from: getAddress(tx.from), data: tx.data,
        value: tx.value.toString(), gasLimit: tx.gasLimit.toString(), gasPrice: tx.gasPrice.toString(), chainId: tx.chainId.toString(),
      },
      // Adapter-only field: ledgerProof strips the provider receipt before any
      // journal write. No signer or key material is included.
      receipt,
    };
  }

  verifyPaidProof(offer, proof, router) {
    check(proof.success, 'PAYMENT_REVERTED', 'Payment did not succeed');
    const tx = proof.transaction;
    check(sameAddress(tx.from, offer.quote.payer) && sameAddress(tx.to, offer.router) && tx.value === '0' && tx.chainId === '31337', 'PAYMENT_PROOF_MISMATCH', 'Payment transaction is outside the exact caller and router boundary');
    check(tx.data === router.interface.encodeFunctionData('pay', [offer.quote, offer.signature]), 'PAYMENT_PROOF_MISMATCH', 'Payment calldata differs from the signed quote');
    const matching = proof.receipt.logs.filter((log) => {
      if (!sameAddress(log.address, offer.router)) return false;
      let event; try { event = router.interface.parseLog(log); } catch { return false; }
      return event?.name === 'Paid' && event.args.quoteId === offer.quote.quoteId && event.args.requestHash === offer.quote.requestHash && sameAddress(event.args.payer, offer.quote.payer) && event.args.amount === BigInt(offer.quote.amount);
    });
    check(matching.length === 1, 'PAYMENT_PROOF_MISMATCH', 'Expected exactly one matching router Paid event');
  }

  async recover(rawOffer, transactionHash, idempotencyKey) {
    validateKey(idempotencyKey);
    const offer = structuredClone(rawOffer);
    check(HEX32.test(offer.quote?.quoteId ?? ''), 'INVALID_QUOTE', 'Quote ID must be 32 bytes');
    check(!transactionHash || HEX32.test(transactionHash), 'INVALID_TRANSACTION', 'Transaction hash must be 32 bytes');
    if (this.operations.has(offer.quote.quoteId)) return this.reuseOperation(offer, idempotencyKey, transactionHash);
    await this.assertContext();
    this.requireTracked(offer, idempotencyKey);
    const validated = await super.validateOffer(offer, { allowExpired: true, requireKnown: false });
    if (this.operations.has(offer.quote.quoteId)) return this.reuseOperation(offer, idempotencyKey, transactionHash);
    const task = this.reconcileDurable(offer, transactionHash, idempotencyKey, validated.router);
    this.operations.set(offer.quote.quoteId, task);
    if (transactionHash) this.operationProofs.set(offer.quote.quoteId, transactionHash);
    try { return await task; } finally { this.operations.delete(offer.quote.quoteId); this.operationProofs.delete(offer.quote.quoteId); }
  }

  async reconcileDurable(offer, transactionHash, key, router) {
    const id = offer.quote.quoteId;
    let row = this.requireTracked(offer, key);
    check(!transactionHash || !row.paymentHash || transactionHash.toLowerCase() === row.paymentHash.toLowerCase(), 'TRANSACTION_CONFLICT', 'Recovery must use the recorded original payment hash');
    // Known approvals can be accounted from any process; no recovery method
    // can acquire a submission permit or progress approved -> payment_intent.
    if (row.approvalHash) {
      const approvalProof = await this.proofFor(row.approvalHash);
      this.journal.recordApproval(id, ledgerProof(approvalProof));
      row = this.journal.read(id);
      if (!approvalProof.success) throw new PolicyError('APPROVAL_REVERTED', 'Original approval reverted; recovery sent nothing');
    }
    let hash = row.paymentHash ?? transactionHash ?? row.observedPayment?.transactionHash;
    if (!hash) {
      const events = await router.queryFilter(router.filters.Paid(id));
      if (events.length === 1) hash = events[0].transactionHash;
    }
    if (!hash) throw new PaymentStateUnknown('No canonical payment found. Existing intent will not be resumed; reservations and wallet gate remain.', { quoteId: id });
    this.operationProofs.set(id, hash);
    const proof = await this.proofFor(hash);
    if (row.paymentHash) {
      if (proof.success) this.verifyPaidProof(offer, proof, router);
      this.journal.recordPayment(id, ledgerProof(proof));
      if (!proof.success) throw new PolicyError('PAYMENT_REVERTED', 'Original payment reverted; recovery sent nothing');
    } else {
      // A failed replay never resolves an original hashless intent. A Paid log
      // proves token settlement but cannot resolve the original fee uncertainty.
      if (!proof.success) throw new PaymentStateUnknown('A reverted replay cannot resolve an original transaction whose hash was never recorded.', { quoteId: id });
      this.verifyPaidProof(offer, proof, router);
      this.journal.recordObservedPayment(id, { ...ledgerProof(proof), quoteId: id, requestHash: offer.quote.requestHash, payer: offer.quote.payer, amount: offer.quote.amount });
    }
    return this.deliverDurable(offer, proof.receipt, key);
  }

  annotateDelivery(error, offer, transactionHash) {
    error.quoteId = offer.quote.quoteId;
    error.transactionHash = transactionHash;
    error.doNotRepay = true;
    error.settlementState = 'confirmed';
  }

  verifyDelivery(response, offer, receipt) {
    check(hashJson(response.result) === offer.resultHash, 'RESULT_MISMATCH', 'Result does not match the authenticated offer');
    const r = response.receipt;
    check(r?.protocol === 'mote-local-v1' && r.localOnly === true && r.quoteId === offer.quote.quoteId && r.transactionHash?.toLowerCase() === receipt.hash.toLowerCase() && r.requestHash === offer.quote.requestHash && r.resultHash === offer.resultHash, 'RECEIPT_MISMATCH', 'Receipt differs from the settled quote');
    check(r.chainId === 31337 && r.asset === 'MOTE' && r.amount === offer.quote.amount && sameAddress(r.payer, offer.quote.payer) && sameAddress(r.token, offer.token) && sameAddress(r.router, offer.router) && sameAddress(r.recipient, offer.recipient), 'RECEIPT_MISMATCH', 'Receipt payment fields differ from caller policy');
    check(r.blockNumber === receipt.blockNumber && r.blockHash === receipt.blockHash && receipt.logs.some((log) => log.index === r.logIndex && sameAddress(log.address, offer.router)), 'RECEIPT_MISMATCH', 'Receipt does not identify the canonical chain log');
    check(sameAddress(r.quoteSigner, offer.quoteSigner) && sameAddress(response.receiptSigner, offer.quoteSigner), 'RECEIPT_SIGNATURE', 'Receipt signer differs from the authenticated offer');
    let signer; try { signer = verifyMessage(canonicalStringify(r), response.receiptSignature); } catch { throw new PolicyError('RECEIPT_SIGNATURE', 'Receipt signature is malformed'); }
    check(sameAddress(signer, offer.quoteSigner), 'RECEIPT_SIGNATURE', 'Receipt signature is invalid');
  }

  async deliverDurable(offer, receipt, key) {
    try {
      const row = this.journal.read(offer.quote.quoteId);
      const response = row.response ?? await this.request('/v1/orders', { quoteId: offer.quote.quoteId, transactionHash: receipt.hash }, key);
      this.verifyDelivery(response, offer, receipt);
      this.journal.markComplete(offer.quote.quoteId, response);
      return response;
    } catch (error) { this.annotateDelivery(error, offer, receipt.hash); throw error; }
  }
}
