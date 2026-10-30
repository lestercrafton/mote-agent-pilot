// Controlled synthetic RPC transport, NOT chain settlement or public Base. Only
// test files import this; production has no option to enable this fee boundary.
import { Interface, Wallet, getAddress } from 'ethers';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestnetMoteClient, testnetIdentity } from '../../src/testnet-client.mjs';
import { TestnetBudgetJournal } from '../../src/testnet-journal.mjs';
import { canonicalStringify, hashJson, prepareAudit } from '../../src/json.mjs';
import { BASE_FEE_CONTRACTS } from '../../src/base-fees.mjs';
const q = n => '0x' + BigInt(n).toString(16), h = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const a = n => '0x' + BigInt(n).toString(16).padStart(40, '0');
const quoteTypes = { Quote: [{ name: 'quoteId', type: 'bytes32' }, { name: 'requestHash', type: 'bytes32' }, { name: 'payer', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] };
const abi = new Interface(['function balanceOf(address) view returns(uint256)', 'function approve(address,uint256) returns(bool)', 'function consumed(bytes32) view returns(bool)', 'function pay((bytes32 quoteId,bytes32 requestHash,address payer,uint256 amount,uint256 deadline),bytes)', 'function version() view returns(string)', 'function isFjord() view returns(bool)', 'function isIsthmus() view returns(bool)', 'function isJovian() view returns(bool)', 'function operatorFeeScalar() view returns(uint32)', 'function operatorFeeConstant() view returns(uint64)', 'function getOperatorFee(uint256) view returns(uint256)']);
export class FixtureTestnetMoteClient extends TestnetMoteClient {
    // This controlled transport charges an exact, bounded fixture fee. It does not
    // demonstrate that any ordinary public Base transaction can cap its L1 fee.
    assertFeeBoundary() { return undefined; }
}
export async function clientFixture(t, policyChanges = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'mote-testnet-client-'));
    const quoteSigner = Wallet.createRandom(); // Ephemeral unfunded quote key; never persisted.
    const state = { nonce: 0n, sends: [], signerCalls: 0, offers: new Map(), payments: new Map(), txs: new Map(), receipts: new Map(), blocks: new Map(), lostResponse: false, omitL1: false, reorg: false, failIdentity: false, head: 10n };
    const baseUrl = 'https://synthetic-mote.example';
    const config = { mode: 'base-sepolia', chainId: 84532, deployments: { token: { address: a(2), runtimeCodeHash: h(20) }, payments: { address: a(3), runtimeCodeHash: h(30) } } };
    config.configHash = hashJson(config);
    const identity = { origin: baseUrl, chainId: 84532, genesisHash: null, token: a(2), router: a(3), recipient: a(4), quoteSigner: quoteSigner.address, checkpoint: { blockNumber: '1', blockHash: h(1) }, configHash: config.configHash };
    function block(n, hashes = []) { return { number: q(n), hash: h(n), parentHash: h(n - 1n), timestamp: q(BigInt(Math.floor(Date.now() / 1000))), baseFeePerGas: q(10), transactions: hashes }; }
    for (let n = 1n; n <= 10n; n++)
        state.blocks.set(q(n), block(n));
    const chain = { identity, config, async verifyIdentity() { if (state.failIdentity)
            throw new Error('controlled identity unavailable'); return structuredClone(identity); }, async verifyPayment({ offer, transactionHash }) {
            const p = state.payments.get(transactionHash);
            if (!p || p.quoteId.toLowerCase() !== offer.quote.quoteId.toLowerCase() || p.requestHash !== offer.quote.requestHash || p.payer.toLowerCase() !== offer.quote.payer.toLowerCase() || p.amount !== offer.quote.amount)
                throw new Error('controlled Paid mismatch');
            const receipt = state.receipts.get(transactionHash);
            return { ...p, transactionHash, transactionNonce: BigInt(state.txs.get(transactionHash).nonce).toString(), blockNumber: BigInt(receipt.blockNumber).toString(), blockHash: receipt.blockHash, transactionIndex: '0', logIndex: '0', blockTimestamp: BigInt(state.blocks.get(receipt.blockNumber).timestamp).toString(), token: identity.token, router: identity.router, recipient: identity.recipient, finalized: { blockNumber: state.head.toString(), blockHash: h(state.head) }, configHash: identity.configHash };
        } };
    const policy = { enabled: true, chainId: 84532, payer: a(1), token: a(2), router: a(3), recipient: a(4), quoteSigner: quoteSigner.address, serviceOrigin: baseUrl, maxSingleSpend: '10000', maxTotalSpend: '50000', maxGasPerTransactionWei: '10000000', maxGasTotalWei: '50000000', maxFeePerGas: '20', maxPriorityFeePerGas: '3', publicSynthetic: true, configHash: identity.configHash, deploymentAnchorHash: hashJson(config.deployments), ...policyChanges };
    const reader = { readOnly: true, endpoint: 'https://sepolia.base.org', async send(method, params = []) {
            if (method === 'eth_chainId')
                return q(84532);
            if (method === 'eth_getBlockByNumber') {
                const number = ['latest', 'finalized', 'safe'].includes(params[0]) ? q(state.head) : params[0];
                const b = structuredClone(state.blocks.get(number));
                if (state.reorg && b)
                    b.hash = h(99999);
                return b ?? null;
            }
            if (method === 'eth_getTransactionCount')
                return q(state.nonce);
            if (method === 'eth_getBalance')
                return q(1000000000);
            if (method === 'eth_getTransactionReceipt') {
                const r = structuredClone(state.receipts.get(params[0]) ?? null);
                if (r && state.omitL1)
                    delete r.l1Fee;
                return r;
            }
            if (method === 'eth_getTransactionByHash')
                return structuredClone(state.txs.get(params[0]) ?? null);
            if (method === 'eth_getCode')
                return '0x60006000';
            if (method === 'eth_call') {
                const parsed = abi.parseTransaction({ data: params[0].data });
                const values = { balanceOf: 10000000n, consumed: parsed.name === 'consumed' && [...state.payments.values()].some(p => p.quoteId === parsed.args[0]), version: '1.6.0', isFjord: true, isIsthmus: true, isJovian: true, operatorFeeScalar: 0n, operatorFeeConstant: 0n, getOperatorFee: 0n };
                return abi.encodeFunctionResult(parsed.name, [values[parsed.name]]);
            }
            throw new Error(`Unexpected fixture RPC ${method}`);
        } };
    const signer = { async getAddress() { state.signerCalls++; return policy.payer; }, async sendTransaction(tx) {
            state.signerCalls++;
            const step = tx.to.toLowerCase() === policy.token ? 'approval' : 'payment';
            if (state.beforeSend)
                await state.beforeSend(step, tx);
            if (BigInt(tx.nonce) !== state.nonce)
                throw new Error('controlled nonce conflict');
            const hash = h(1000n + state.nonce), bn = ++state.head;
            state.nonce++;
            const normalized = { ...tx, nonce: String(tx.nonce), gasLimit: String(tx.gasLimit), maxFeePerGas: String(tx.maxFeePerGas), maxPriorityFeePerGas: String(tx.maxPriorityFeePerGas), value: String(tx.value) };
            state.sends.push({ step, hash, intent: normalized });
            state.blocks.set(q(bn), block(bn, [hash]));
            state.txs.set(hash, { hash, type: '0x2', chainId: q(84532), from: tx.from, to: tx.to, nonce: q(tx.nonce), gas: q(tx.gasLimit), maxFeePerGas: q(tx.maxFeePerGas), maxPriorityFeePerGas: q(tx.maxPriorityFeePerGas), value: q(tx.value), input: tx.data, accessList: [], blockNumber: q(bn), blockHash: h(bn), transactionIndex: '0x0' });
            const success = state.revertStep !== step;
            state.receipts.set(hash, { transactionHash: hash, type: '0x2', status: success ? '0x1' : '0x0', from: tx.from, to: tx.to, blockNumber: q(bn), blockHash: h(bn), transactionIndex: '0x0', gasUsed: q(step === 'approval' ? 21001 : 50000), effectiveGasPrice: q(13), l1Fee: q(31), logs: [] });
            if (step === 'payment' && success) {
                const parsed = abi.parseTransaction({ data: tx.data });
                const p = parsed.args[0];
                state.payments.set(hash, { quoteId: p.quoteId, requestHash: p.requestHash, payer: p.payer, amount: p.amount.toString() });
            }
            if (state.afterSend)
                await state.afterSend(step, hash);
            return { hash };
        } };
    const fetchImpl = async (url, request = {}) => {
        if (url.endsWith('/.well-known/mote.json'))
            return Response.json({ protocol: 'mote-base-sepolia-test-v1', testOnly: true, quote: '/v1/quotes' });
        const body = JSON.parse(request.body);
        if (body.publicSynthetic !== true)
            throw new Error('fixture requires public synthetic flag');
        if (url.endsWith('/v1/quotes')) {
            const prepared = prepareAudit(body.input), quoteId = h(5000 + state.offers.size), deadline = String(Math.floor(Date.now() / 1000) + 600);
            const quote = { quoteId, requestHash: prepared.requestHash, payer: body.payer, amount: prepared.amount, deadline };
            const domain = { name: 'MotePayments', version: '1', chainId: 84532, verifyingContract: policy.router };
            const offer = { protocol: 'mote-base-sepolia-test-v1', quote, domain, signature: await quoteSigner.signTypedData(domain, quoteTypes, quote), chainId: 84532, token: policy.token, router: policy.router, recipient: policy.recipient, quoteSigner: quoteSigner.address, decimals: 6, asset: 'MOTE', service: 'json.audit', resultHash: prepared.resultHash, expiresAt: new Date(Number(deadline) * 1000).toISOString(), inputBytes: prepared.inputBytes, origin: baseUrl, configHash: identity.configHash, finality: 'finalized', testOnly: true, publicSynthetic: true, localOnly: false };
            offer.offerSignature = await quoteSigner.signMessage(canonicalStringify(offer));
            state.offers.set(quoteId, { offer, result: prepared.result });
            return Response.json(offer);
        }
        if (url.endsWith('/v1/recover')) {
            const prepared = prepareAudit(body.input);
            if (prepared.requestHash !== body.offer.quote.requestHash || prepared.resultHash !== body.offer.resultHash) throw new Error('fixture reconstruction mismatch');
            body.quoteId = body.offer.quote.quoteId;
            state.offers.set(body.quoteId, { offer: body.offer, result: prepared.result });
            state.recoveryRequests = (state.recoveryRequests ?? 0) + 1;
        }
        if (url.endsWith('/v1/orders') || url.endsWith('/v1/recover')) {
            if (state.lostResponse) {
                state.lostResponse = false;
                throw new Error('controlled dropped service response');
            }
            const { offer, result } = state.offers.get(body.quoteId), paid = await chain.verifyPayment({ offer, transactionHash: body.transactionHash });
            const receipt = { protocol: offer.protocol, quoteId: body.quoteId, requestHash: offer.quote.requestHash, resultHash: offer.resultHash, payer: offer.quote.payer, amount: offer.quote.amount, asset: 'MOTE', chainId: 84532, token: offer.token, router: offer.router, recipient: offer.recipient, quoteSigner: offer.quoteSigner, origin: baseUrl, configHash: identity.configHash, transactionHash: body.transactionHash, blockNumber: paid.blockNumber, blockHash: paid.blockHash, transactionIndex: paid.transactionIndex, logIndex: paid.logIndex, settledAt: new Date(Number(paid.blockTimestamp) * 1000).toISOString(), finalized: paid.finalized, finality: 'finalized', testOnly: true, publicSynthetic: true, localOnly: false };
            return Response.json({ result, receipt, receiptSigner: quoteSigner.address, receiptSignature: await quoteSigner.signMessage(canonicalStringify(receipt)) });
        }
        throw new Error('unknown fixture path');
    };
    const options = { path: join(directory, 'authority.sqlite'), policyId: 'synthetic-test-policy', policy, chainIdentity: testnetIdentity(chain) };
    const journal = TestnetBudgetJournal.initialize(options);
    const journals = [journal];
    t.after(() => { for (const j of journals)
        try {
            j.close();
        }
        catch { } rmSync(directory, { recursive: true, force: true }); });
    const clientOptions = { baseUrl, signer, reader, chain, policy, journal, fetchImpl };
    return { state, options, policy, chain, reader, signer, journal, clientOptions, client: new FixtureTestnetMoteClient(clientOptions), reopen() { const j = new TestnetBudgetJournal(options); journals.push(j); return j; } };
}
