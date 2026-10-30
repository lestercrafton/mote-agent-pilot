import { Interface, getAddress, verifyMessage, verifyTypedData } from 'ethers';
import { canonicalStringify, hashJson, parseJson, prepareAudit } from './json.mjs';
import { actualBaseFees, assertPublicFeeCap, estimateBaseFees } from './base-fees.mjs';
import { actualEthereumFees, assertEthereumFeeCap, estimateEthereumFees } from './ethereum-fees.mjs';
import { getTestnetNetwork } from './testnet-networks.mjs';
const HASH = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^(0|[1-9]\d*)$/;
const APPROVAL_GAS = 100000n, PAYMENT_GAS = 250000n;
const LOCAL_FIXTURE = Symbol('explicit local fixture transport');
export const LOCAL_FIXTURE_ACKNOWLEDGMENT = 'Local EVM only; no public broadcast';
function loopbackOrigin(value) {
    let url; try { url = new URL(value); } catch { throw new TestnetClientError('FIXTURE_TRANSPORT_DENIED', 'An exact literal loopback HTTP origin is required.'); }
    check(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) && url.origin === value && !url.username && !url.password, 'FIXTURE_TRANSPORT_DENIED', 'An exact literal loopback HTTP origin is required.');
    return value;
}
const TOKEN = new Interface(['function balanceOf(address) view returns(uint256)', 'function approve(address,uint256) returns(bool)']);
const ROUTER = new Interface(['function consumed(bytes32) view returns(bool)', 'function pay((bytes32 quoteId,bytes32 requestHash,address payer,uint256 amount,uint256 deadline),bytes)']);
const QUOTE_TYPES = { Quote: [{ name: 'quoteId', type: 'bytes32' }, { name: 'requestHash', type: 'bytes32' }, { name: 'payer', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] };
export class TestnetClientError extends Error {
    constructor(code, message, cause) { super(message, { cause }); this.name = 'TestnetClientError'; this.code = code; this.doNotRepay = true; }
}
const check = (ok, code, message) => { if (!ok)
    throw new TestnetClientError(code, message); };
const same = (a, b) => canonicalStringify(a) === canonicalStringify(b);
const addr = (a, b) => { try {
    return getAddress(a) === getAddress(b);
}
catch {
    return false;
} };
const keyCheck = (v) => check(typeof v === 'string' && /^[a-zA-Z0-9._:-]{8,128}$/.test(v), 'INVALID_IDEMPOTENCY_KEY', 'Use the original explicit 8–128 character operation key.');
const uint = (v) => { check(typeof v === 'string' && UINT.test(v) && v.length <= 78, 'INVALID_INTEGER', 'Expected a bounded decimal integer string.'); return BigInt(v); };
const safeNumber = (v) => { const n = BigInt(v); check(n >= 0n && n <= BigInt(Number.MAX_SAFE_INTEGER), 'INTEGER_RANGE', 'Evidence integer exceeds supported range.'); return Number(n); };
const ledgerProof = ({ receipt, feeEvidence, ...proof }) => proof;
/** Configured deployment identity only; never contains signer credentials. */
export function testnetIdentity(chain) {
    const i = chain.identity, c = chain.config;
    check(i && c && [84532, 11155111].includes(c.chainId) && i.chainId === c.chainId, 'CHAIN_DENIED', 'A pinned registered testnet deployment is required.');
    getTestnetNetwork(c.chainId);
    return {
        chainId: c.chainId, genesisHash: i.genesisHash ?? null, quoteSigner: i.quoteSigner,
        tokenCodeHash: c.deployments.token.runtimeCodeHash, routerCodeHash: c.deployments.payments.runtimeCodeHash,
        configHash: i.configHash, deploymentAnchorHash: hashJson(c.deployments), checkpointHash: hashJson(i.checkpoint),
    };
}
export async function readTestnetIdentity(chain) {
    const identity = await chain.verifyIdentity();
    check(same(identity, chain.identity), 'CHAIN_IDENTITY_CHANGED', 'Deployment identity changed; keep all outstanding authority.');
    return testnetIdentity(chain);
}
/** Separate registered-testnet adapter. Ethereum Sepolia uses the exact type-2
 * EOA gas ceiling and a caller-provisioned signer. Base refuses its unenforceable
 * complete L1+L2 fee cap. No keys are generated or persisted here. Read-only
 * recovery never calls a signer. The explicit loopback factory preserves all
 * policy, native-fee, intent, and finalized-proof checks without overrides.
 */
export class TestnetMoteClient {
    /** Explicit local rehearsal transport; all policy, fee, signing-intent and
     * finalized proof checks use the SAME class as public operation. No caller
     * flag can change the fee boundary. Never used by production entrypoints. */
    static forLocalFixture({ acknowledgment, localServiceOrigin, ...options }) {
        check(acknowledgment === LOCAL_FIXTURE_ACKNOWLEDGMENT, 'FIXTURE_ACKNOWLEDGMENT_REQUIRED', 'Explicitly acknowledge a local EVM rehearsal.');
        const transportOrigin = loopbackOrigin(localServiceOrigin);
        check(options.chain?.config?.mode === 'local-fixture' && HASH.test(options.chain?.identity?.genesisHash ?? ''), 'FIXTURE_CHAIN_REQUIRED', 'The verified local fixture configuration and genesis are required.');
        loopbackOrigin(options.reader?.endpoint);
        if (options.signer) {
            const endpoint = options.signer.provider?._getConnection?.().url;
            check(endpoint === options.reader.endpoint, 'FIXTURE_SIGNER_DENIED', 'Fixture signer must use the same literal loopback JsonRpcProvider as the reader.');
            loopbackOrigin(endpoint);
        }
        return new TestnetMoteClient(options, { capability: LOCAL_FIXTURE, transportOrigin });
    }
    constructor({ baseUrl, signer, reader, chain, policy, journal, fetchImpl = globalThis.fetch, finalityWaitMs = 1800000, finalityPollMs = 15000 }, fixture = null) {
        const url = new URL(baseUrl);
        check(url.protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.origin === baseUrl, 'ORIGIN_DENIED', 'An exact non-loopback HTTPS origin is required.');
        const network = getTestnetNetwork(policy?.chainId);
        const local = fixture?.capability === LOCAL_FIXTURE;
        check(chain?.config?.mode === (local ? 'local-fixture' : network.slug), 'CHAIN_DENIED', 'Public client rejects local fixture deployment configurations and other networks.');
        check(reader?.readOnly === true && typeof reader.send === 'function' && (local ? loopbackOrigin(reader.endpoint) : reader.endpoint === network.rpcUrl), 'READER_DENIED', 'Use the exact registered read-only network source.');
        check(Number.isSafeInteger(finalityWaitMs) && finalityWaitMs >= 0 && finalityWaitMs <= 1800000 && Number.isSafeInteger(finalityPollMs) && finalityPollMs >= 100 && finalityPollMs <= 60000, 'FINALITY_WAIT_INVALID', 'Use bounded finality wait and polling intervals.');
        this.finalityWaitMs = finalityWaitMs; this.finalityPollMs = finalityPollMs;
        this.network = network;
        this.transportOrigin = local ? fixture.transportOrigin : baseUrl;
        check(journal && typeof journal.assertContext === 'function', 'JOURNAL_REQUIRED', 'An explicitly initialized or reopened TestnetBudgetJournal is required.');
        this.policy = Object.freeze(structuredClone(policy));
        this.baseUrl = baseUrl;
        this.signer = signer;
        this.reader = reader;
        this.chain = chain;
        this.journal = journal;
        this.fetchImpl = fetchImpl;
        this.offers = new Map();
        this.operations = new Map();
        this.operationProofs = new Map();
        check(policy.serviceOrigin === baseUrl && policy.publicSynthetic === true, 'ORIGIN_DENIED', 'Caller policy must pin the exact origin and public synthetic data mode.');
        const i = chain.identity;
        check(i.origin === baseUrl && addr(i.token, policy.token) && addr(i.router, policy.router) && addr(i.recipient, policy.recipient) && addr(i.quoteSigner, policy.quoteSigner), 'CONTRACT_MISMATCH', 'Deployment identity differs from the payer allowlist.');
        journal.assertContext({ policy: this.policy, chainIdentity: testnetIdentity(chain) });
    }
    get budget() { return this.journal.budget(); }
    async assertContext() { this.journal.assertContext({ policy: this.policy, chainIdentity: await readTestnetIdentity(this.chain) }); }
    async request(path, body, key) {
        if (body !== undefined)
            keyCheck(key);
        const response = await this.fetchImpl(`${this.transportOrigin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': key }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(10000) });
        check(!response.redirected && (!response.url || response.url === `${this.transportOrigin}${path}`), 'ORIGIN_DENIED', 'Service redirected away from the pinned request.');
        check(response.body?.getReader, 'RESPONSE_INVALID', 'Expected a bounded JSON response.');
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                size += value.length;
                if (size > 1048576) {
                    await reader.cancel();
                    throw new TestnetClientError('RESPONSE_TOO_LARGE', 'Response exceeds 1 MiB.');
                }
                chunks.push(value);
            }
        }
        finally {
            reader.releaseLock();
        }
        const data = parseJson(Buffer.concat(chunks).toString('utf8'));
        check(response.ok && !data.error, data.error?.code ?? `HTTP_${response.status}`, data.error?.message ?? 'Service request failed.');
        return data;
    }
    async discover() {
        const manifest = await this.request('/.well-known/mote.json');
        // A manifest is discovery metadata, never spend authorization.
        return manifest;
    }
    async quote(input, key, { publicSynthetic } = {}) {
        check(publicSynthetic === true, 'PUBLIC_SYNTHETIC_REQUIRED', 'Explicitly mark input as public synthetic test data.');
        const snapshot = structuredClone(input);
        const prepared = prepareAudit(snapshot);
        const offer = await this.request('/v1/quotes', { payer: this.policy.payer, input: snapshot, publicSynthetic: true }, key);
        check(offer.quote?.requestHash === prepared.requestHash && offer.resultHash === prepared.resultHash, 'REQUEST_MISMATCH', 'Offer does not bind the submitted input and its deterministic result.');
        await this.validateOffer(offer, { requireKnown: false });
        this.offers.set(offer.quote.quoteId.toLowerCase(), structuredClone(offer));
        return offer;
    }
    async validateOffer(offer, { allowExpired = false, requireKnown = true } = {}) {
        this.journal.validateOffer(offer);
        const p = this.policy, q = offer.quote;
        check(p.enabled === true, 'SPENDING_DISABLED', 'Caller policy disables payments.');
        check(uint(q.amount) > 0n && uint(q.amount) <= uint(p.maxSingleSpend), 'SINGLE_LIMIT', 'Quote exceeds the single-payment limit.');
        check(allowExpired || uint(q.deadline) > BigInt(Math.floor(Date.now() / 1000)), 'QUOTE_EXPIRED', 'Quote has expired.');
        check(offer.expiresAt === new Date(safeNumber(q.deadline) * 1000).toISOString(), 'QUOTE_METADATA_MISMATCH', 'Offer expiry differs from the signed deadline.');
        if (requireKnown)
            check(this.offers.has(q.quoteId.toLowerCase()) && same(this.offers.get(q.quoteId.toLowerCase()), offer), 'OFFER_NOT_REQUESTED', 'Only an unchanged requested offer may authorize a new payment.');
        let signed, envelopeSigned;
        try {
            signed = verifyTypedData(offer.domain, QUOTE_TYPES, q, offer.signature);
            const { offerSignature, ...envelope } = offer;
            envelopeSigned = verifyMessage(canonicalStringify(envelope), offerSignature);
        }
        catch (cause) {
            throw new TestnetClientError('INVALID_SIGNATURE', 'Offer signatures are malformed.', cause);
        }
        check(addr(signed, p.quoteSigner) && addr(envelopeSigned, p.quoteSigner), 'INVALID_SIGNATURE', 'Both quote and complete offer must match the pinned signer.');
        return offer;
    }
    requireTracked(offer, key) {
        const row = this.journal.read(offer.quote.quoteId);
        check(row, 'UNTRACKED_QUOTE', 'Recovery requires a previously reserved quote in this journal.');
        check(same(row.offer, offer), 'QUOTE_CONFLICT', 'Recovery offer differs from durable original.');
        check(row.idempotencyKey === key, 'IDEMPOTENCY_CONFLICT', 'Recovery requires the original order key.');
        check(row.phase !== 'cancelled', 'ATTEMPT_CANCELLED', 'This pre-intent attempt was cancelled; obtain a fresh quote.');
        return row;
    }
    reuse(offer, key, hash = null) {
        const row = this.requireTracked(offer, key), id = offer.quote.quoteId.toLowerCase();
        if (hash) {
            const active = row.paymentHash ?? this.operationProofs.get(id) ?? row.observedPayment?.transactionHash;
            check(active && active.toLowerCase() === hash.toLowerCase(), 'TRANSACTION_CONFLICT', 'Concurrent recovery cannot substitute a different or unknown payment hash.');
        }
        return this.operations.get(id);
    }
    /** Never overridden by configuration or an attestation supplied by a server. */
    async assertFeeBoundary(transaction) {
        if (this.network.feeModel === 'op-stack') return assertPublicFeeCap();
        const evidence = await estimateEthereumFees({ reader: this.reader, transaction });
        return assertEthereumFeeCap({ transaction, evidence, maxFeeWei: this.policy.maxGasPerTransactionWei });
    }
    estimate(transaction) {
        const estimate = this.network.feeModel === 'op-stack' ? estimateBaseFees : estimateEthereumFees;
        return estimate({ reader: this.reader, transaction });
    }
    async preflightFees(offer) {
        if (this.network.feeModel === 'op-stack') return this.assertFeeBoundary();
        const nonce = await this.nonce();
        await this.assertFeeBoundary(this.makeIntent('approval', offer, nonce));
        await this.assertFeeBoundary(this.makeIntent('payment', offer, nonce + 1n));
    }
    async execute(rawOffer, key) {
        keyCheck(key);
        const offer = structuredClone(rawOffer), id = offer.quote?.quoteId?.toLowerCase();
        check(HASH.test(id ?? ''), 'INVALID_QUOTE', 'Quote ID must be 32 bytes.');
        if (this.operations.has(id))
            return this.reuse(offer, key);
        await this.assertContext();
        if (this.journal.read(id))
            return this.recover(offer, null, key);
        await this.validateOffer(offer);
        // The standard public Base path ends here, before reservation or ANY signer
        // method. A point-in-time estimate is not a transaction-enforced full cap.
        await this.preflightFees(offer);
        const reservation = this.journal.reserve(offer, key);
        if (!reservation.created)
            return this.recover(offer, null, key);
        const task = this.performNew(offer, key);
        this.operations.set(id, task);
        try {
            return await task;
        }
        finally {
            this.operations.delete(id);
            this.operationProofs.delete(id);
        }
    }
    async call(to, abi, name, args) { return abi.decodeFunctionResult(name, await this.reader.send('eth_call', [{ to, data: abi.encodeFunctionData(name, args) }, 'latest']))[0]; }
    async nonce() { return BigInt(await this.reader.send('eth_getTransactionCount', [this.policy.payer, 'pending'])); }
    makeIntent(step, offer, nonce) { return { type: 2, chainId: this.policy.chainId, from: getAddress(this.policy.payer), to: getAddress(step === 'approval' ? this.policy.token : this.policy.router), nonce: nonce.toString(), value: '0', gasLimit: (this.network.feeModel === 'ethereum-eip1559' ? (step === 'approval' ? 250000n : 500000n) : (step === 'approval' ? APPROVAL_GAS : PAYMENT_GAS)).toString(), maxFeePerGas: this.policy.maxFeePerGas, maxPriorityFeePerGas: this.policy.maxPriorityFeePerGas, data: step === 'approval' ? TOKEN.encodeFunctionData('approve', [offer.router, offer.quote.amount]) : ROUTER.encodeFunctionData('pay', [offer.quote, offer.signature]) }; }
    async sendIntent(id, step, phase, intent) {
        await this.assertFeeBoundary(intent);
        const row = this.journal.read(id);
        check(row, 'UNTRACKED_QUOTE', 'A durable reservation is required before submission.');
        const [head, nonce] = await Promise.all([
            this.reader.send('eth_getBlockByNumber', ['latest', false]), this.nonce(),
        ]);
        check(BigInt(head.timestamp) <= uint(row.offer.quote.deadline), 'QUOTE_EXPIRED', 'Quote expired before the exact send intent; no transaction was submitted.');
        check(nonce === BigInt(intent.nonce), 'NONCE_CONFLICT', 'Wallet nonce changed during fee verification; no transaction was submitted.');
        this.journal.beginIntent(id, phase, step, intent);
        const sent = await this.signer.sendTransaction({ ...intent, nonce: safeNumber(intent.nonce), gasLimit: BigInt(intent.gasLimit), maxFeePerGas: BigInt(intent.maxFeePerGas), maxPriorityFeePerGas: BigInt(intent.maxPriorityFeePerGas), value: 0n });
        this.journal.markSubmitted(id, step, sent.hash);
        return sent.hash;
    }
    async performNew(offer, key) {
        const id = offer.quote.quoteId;
        let step = null;
        try {
            check(this.signer && typeof this.signer.sendTransaction === 'function' && typeof this.signer.getAddress === 'function', 'SIGNER_REQUIRED', 'Caller must supply an authorized signer.');
            check(addr(await this.signer.getAddress(), this.policy.payer), 'PAYER_DENIED', 'Signer differs from pinned payer.');
            check(!(await this.call(offer.router, ROUTER, 'consumed', [id])), 'ALREADY_PAID', 'Quote is already consumed; reconcile only.');
            const latest = await this.reader.send('eth_getBlockByNumber', ['latest', false]);
            check(BigInt(latest.timestamp) <= uint(offer.quote.deadline), 'QUOTE_EXPIRED', 'Quote expired on chain.');
            check(await this.call(offer.token, TOKEN, 'balanceOf', [offer.quote.payer]) >= uint(offer.quote.amount), 'INSUFFICIENT_BALANCE', 'Payer has insufficient tokens.');
            check(BigInt(await this.reader.send('eth_getBalance', [this.policy.payer, 'latest'])) >= 2n * uint(this.policy.maxGasPerTransactionWei), 'INSUFFICIENT_GAS', 'Payer lacks native balance for both full reservations.');
            const nonce = await this.nonce(), approvalIntent = this.makeIntent('approval', offer, nonce);
            step = 'approval';
            const approvalHash = await this.sendIntent(id, step, 'reserved', approvalIntent);
            const approval = await this.waitForProof(approvalHash, approvalIntent);
            this.journal.recordApproval(id, ledgerProof(approval));
            check(approval.success, 'APPROVAL_REVERTED', 'Original approval reverted.');
            await this.assertContext();
            const paymentHead = await this.reader.send('eth_getBlockByNumber', ['latest', false]);
            check(BigInt(paymentHead.timestamp) <= uint(offer.quote.deadline), 'QUOTE_EXPIRED', 'Quote expired while waiting for approval finality; no payment will be submitted.');
            check(await this.nonce() === nonce + 1n, 'NONCE_CONFLICT', 'Wallet nonce changed outside the shared submission gate.');
            const paymentIntent = this.makeIntent('payment', offer, nonce + 1n);
            step = 'payment';
            const paymentHash = await this.sendIntent(id, step, 'approved', paymentIntent), payment = await this.waitForProof(paymentHash, paymentIntent);
            if (payment.success)
                await this.verifyPaid(offer, payment);
            this.journal.recordPayment(id, ledgerProof(payment));
            check(payment.success, 'PAYMENT_REVERTED', 'Original payment reverted.');
            return await this.deliver(offer, payment, key);
        }
        catch (error) {
            let row;
            try {
                row = this.journal.read(id);
            }
            catch { }
            if (row && ['settled', 'complete'].includes(row.phase)) {
                this.annotate(error, offer, row.paymentHash);
                throw error;
            }
            if (row?.phase === 'reserved') {
                this.journal.cancelReserved(id);
                throw error;
            }
            if (row && ['failed', 'cancelled'].includes(row.phase))
                throw error;
            if (row && step) {
                try {
                    this.journal.markUnknown(id, step);
                }
                catch { }
            }
            const unknown = new TestnetClientError('PAYMENT_STATE_UNKNOWN', 'Keep reservations and the wallet gate. Recovery is read-only and never resumes an original send.', error);
            unknown.quoteId = id;
            unknown.transactionHash = row?.paymentHash;
            throw unknown;
        }
    }
    async waitForProof(hash, intent) {
        if (this.network.feeModel !== 'ethereum-eip1559') return this.proofFor(hash, intent);
        const deadline = performance.now() + this.finalityWaitMs;
        for (;;) {
            try { return await this.proofFor(hash, intent); }
            catch (error) {
                if (!['FEE_PENDING', 'FEE_NOT_FINALIZED'].includes(error.code)) throw error;
                const remaining = deadline - performance.now();
                if (remaining <= 0) throw new TestnetClientError('FINALITY_TIMEOUT', 'Original transaction has not finalized within the bounded wait. Keep its reservation and recover read-only; never resubmit.', error);
                await new Promise(resolve => setTimeout(resolve, Math.min(this.finalityPollMs, remaining)));
            }
        }
    }
    async proofFor(hash, intent) {
        check(HASH.test(hash ?? '') && intent, 'INVALID_TRANSACTION', 'Proof requires an original hash and exact durable unsigned intent.');
        const account = this.network.feeModel === 'op-stack' ? actualBaseFees : actualEthereumFees;
        const fees = await account({ reader: this.reader, transactionHash: hash, expectedTransaction: intent });
        return { transactionHash: fees.transactionHash, feeWei: fees.totalFeeWei, success: fees.success, blockNumber: safeNumber(fees.blockNumber), blockHash: fees.blockHash, transaction: fees.transaction, receipt: fees.receipt, feeEvidence: fees };
    }
    async verifyPaid(offer, proof) {
        try {
            const settled = await this.chain.verifyPayment({ offer, transactionHash: proof.transactionHash });
            check(settled.blockHash.toLowerCase() === proof.blockHash.toLowerCase() && BigInt(settled.blockNumber) === BigInt(proof.blockNumber), 'PAYMENT_PROOF_MISMATCH', 'Payment and fee proofs identify different canonical blocks.');
            return settled;
        }
        catch (error) {
            error.settlementState = 'reconciliation_required';
            error.doNotRepay = true;
            throw error;
        }
    }
    recover(rawOffer, hash, key) {
        return this.#runRecovery(rawOffer, hash, key, null);
    }
    /** Reconstruct a service record lost after backup restoration. The original
     * public synthetic input is caller-supplied and checked locally; it never
     * replaces the durable offer or grants a fresh send reservation. */
    async recoverFromOriginalInput(rawOffer, rawInput, hash, key, { publicSynthetic } = {}) {
        check(publicSynthetic === true, 'PUBLIC_SYNTHETIC_REQUIRED', 'Reconstruction requires explicit public synthetic data acknowledgment.');
        const offer = structuredClone(rawOffer), input = structuredClone(rawInput);
        const prepared = prepareAudit(input);
        check(prepared.requestHash === offer.quote?.requestHash && prepared.resultHash === offer.resultHash,
            'RECOVERY_INPUT_MISMATCH', 'Original input must reproduce both the signed request hash and promised result hash.');
        return this.#runRecovery(offer, hash, key, input);
    }
    async #runRecovery(rawOffer, hash, key, originalInput) {
        keyCheck(key);
        const offer = structuredClone(rawOffer), id = offer.quote?.quoteId?.toLowerCase();
        check(HASH.test(id ?? '') && (!hash || HASH.test(hash)), 'INVALID_TRANSACTION', 'Quote and transaction hashes must be 32 bytes.');
        if (this.operations.has(id))
            return this.reuse(offer, key, hash);
        await this.assertContext();
        this.requireTracked(offer, key);
        await this.validateOffer(offer, { allowExpired: true, requireKnown: false });
        if (this.operations.has(id))
            return this.reuse(offer, key, hash);
        const task = this.reconcile(offer, hash, key, originalInput);
        this.operations.set(id, task);
        if (hash)
            this.operationProofs.set(id, hash);
        try {
            return await task;
        }
        finally {
            this.operations.delete(id);
            this.operationProofs.delete(id);
        }
    }
    async reconcile(offer, hash, key, originalInput = null) {
        const id = offer.quote.quoteId;
        let row = this.requireTracked(offer, key);
        check(!hash || !row.paymentHash || hash.toLowerCase() === row.paymentHash, 'TRANSACTION_CONFLICT', 'Recovery must use the recorded original transaction.');
        if (row.approvalHash) {
            const p = await this.proofFor(row.approvalHash, row.approvalIntent);
            this.journal.recordApproval(id, ledgerProof(p));
            check(p.success, 'APPROVAL_REVERTED', 'Original approval reverted; recovery sent nothing.');
            row = this.journal.read(id);
        }
        hash = row.paymentHash ?? hash ?? row.observedPayment?.transactionHash;
        check(hash && row.paymentIntent, 'PAYMENT_STATE_UNKNOWN', 'No identified payment is recoverable. Keep the gate; no signer call or automatic search/retransmission occurs.');
        this.operationProofs.set(id.toLowerCase(), hash);
        const p = await this.proofFor(hash, row.paymentIntent);
        if (row.paymentHash) {
            if (p.success)
                await this.verifyPaid(offer, p);
            this.journal.recordPayment(id, ledgerProof(p));
            check(p.success, 'PAYMENT_REVERTED', 'Original payment reverted; recovery sent nothing.');
        }
        else {
            check(p.success, 'PAYMENT_STATE_UNKNOWN', 'A reverted replay cannot resolve an unidentified original send.');
            await this.verifyPaid(offer, p);
            this.journal.recordObservedPayment(id, { ...ledgerProof(p), quoteId: id, requestHash: offer.quote.requestHash, payer: offer.quote.payer, amount: offer.quote.amount });
        }
        return this.deliver(offer, p, key, originalInput);
    }
    annotate(error, offer, hash) { error.quoteId = offer.quote.quoteId; error.transactionHash = hash; error.doNotRepay = true; if (/^(CHAIN_|SETTLEMENT_|FINALITY_|FEE_|PAYMENT_PENDING$|NOT_FINALIZED$|PAYMENT_PROOF_MISMATCH$)/.test(error.code ?? '')) error.settlementState = 'reconciliation_required'; else if (error.settlementState !== 'reconciliation_required') error.settlementState = 'finalized'; }
    async verifyDelivery(response, offer, proof) {
        const chain = await this.verifyPaid(offer, proof), r = response.receipt;
        check(hashJson(response.result) === offer.resultHash, 'RESULT_MISMATCH', 'Result differs from authenticated offer.');
        check(r?.protocol === this.network.protocol && r.testOnly === true && r.publicSynthetic === true && r.localOnly === false && r.finality === 'finalized' && r.origin === this.baseUrl && r.configHash === this.policy.configHash, 'RECEIPT_MISMATCH', 'Receipt is outside pinned public synthetic test deployment.');
        for (const field of ['quoteId', 'requestHash', 'resultHash'])
            check(r[field] === (field === 'resultHash' ? offer[field] : offer.quote[field]), 'RECEIPT_MISMATCH', 'Receipt hashes differ from offer.');
        check(r.transactionHash?.toLowerCase() === proof.transactionHash.toLowerCase() && r.chainId === this.policy.chainId && r.asset === 'MOTE' && r.amount === offer.quote.amount, 'RECEIPT_MISMATCH', 'Receipt payment identity differs.');
        for (const field of ['token', 'router', 'recipient', 'quoteSigner'])
            check(addr(r[field], offer[field]), 'RECEIPT_MISMATCH', 'Receipt destination differs.');
        check(addr(r.payer, offer.quote.payer) && addr(response.receiptSigner, offer.quoteSigner), 'RECEIPT_MISMATCH', 'Receipt payer or signer differs.');
        for (const field of ['blockNumber', 'blockHash', 'transactionIndex', 'logIndex'])
            check(String(r[field]).toLowerCase() === String(chain[field]).toLowerCase(), 'RECEIPT_MISMATCH', 'Receipt inclusion evidence differs.');
        check(r.settledAt === new Date(safeNumber(chain.blockTimestamp) * 1000).toISOString(), 'RECEIPT_MISMATCH', 'Receipt settlement time differs from its canonical inclusion block.');
        check(r.finalized && BigInt(r.finalized.blockNumber) >= BigInt(r.blockNumber) && HASH.test(r.finalized.blockHash), 'RECEIPT_MISMATCH', 'Receipt lacks a finalized anchor.');
        // Anchors may advance between delivery and recovery. Verify the historical
        // signed anchor rather than requiring equality with today's finalized head.
        let anchor;
        try { anchor = await this.reader.send('eth_getBlockByNumber', [`0x${BigInt(r.finalized.blockNumber).toString(16)}`, false]); }
        catch (error) { error.settlementState = 'reconciliation_required'; throw error; }
        check(anchor?.hash?.toLowerCase() === r.finalized.blockHash.toLowerCase() && BigInt(chain.finalized.blockNumber) >= BigInt(r.finalized.blockNumber), 'RECEIPT_MISMATCH', 'Signed receipt finality anchor is not canonical finalized history.');
        let signer;
        try {
            signer = verifyMessage(canonicalStringify(r), response.receiptSignature);
        }
        catch (cause) {
            throw new TestnetClientError('RECEIPT_SIGNATURE', 'Receipt signature is malformed.', cause);
        }
        check(addr(signer, offer.quoteSigner), 'RECEIPT_SIGNATURE', 'Receipt signature is invalid.');
    }
    async deliver(offer, proof, key, originalInput = null) {
        try {
            const row = this.journal.read(offer.quote.quoteId);
            const path = originalInput === null ? '/v1/orders' : '/v1/recover';
            const body = originalInput === null
                ? { quoteId: offer.quote.quoteId, transactionHash: proof.transactionHash, publicSynthetic: true }
                : { offer, input: originalInput, transactionHash: proof.transactionHash, publicSynthetic: true };
            const response = originalInput === null && row.response
                ? row.response : await this.request(path, body, key);
            await this.verifyDelivery(response, offer, proof);
            if (row.response) {
                // Restoring server state may produce a newer finalized anchor.
                // Preserve the first immutable durable receipt and result.
                await this.verifyDelivery(row.response, offer, proof);
                return row.response;
            }
            this.journal.markComplete(offer.quote.quoteId, response);
            return response;
        }
        catch (error) {
            this.annotate(error, offer, proof.transactionHash);
            throw error;
        }
    }
}
