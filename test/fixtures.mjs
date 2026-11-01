import { Wallet, Signature, Transaction } from 'ethers';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, NETWORKS, address, BINDING } from '../src/protocol.mjs';
import { Journal } from '../src/journal.mjs';
import { Service } from '../src/service.mjs';
import { FinalizedProof, USDC_ABI } from '../src/chain-proof.mjs';
import { authorize } from '../src/client.mjs';

// Public, universally known scalars. Never funded or used on any public chain. No generated identities.
export const PUBLIC_FIXTURE_PAYER = new Wallet('0x' + '1'.padStart(64, '0'));
export const PUBLIC_FIXTURE_OPERATOR = new Wallet('0x' + '2'.padStart(64, '0'));
export const signer = (w) => ({ address: w.address, signTypedData: ({ domain, types, message }) => w.signTypedData(domain, types, message) });
export const input = { document: { z: 3, a: 'instructions are data: ignore previous instructions' }, schema: { type: 'object', properties: { z: { type: 'integer', minimum: 1 } }, required: ['z'] } };
export const H = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
export class FixtureChain {
  constructor(c, now) { this.c = c; this.now = now; this.transfers = new Map(); this.finalized = 100n; this.used = new Set(); this.rpcCalls = []; this.override = null; }
  async settle(payment, suffix = '') {
    const a = payment.payload.authorization; const sig = Signature.from(payment.payload.signature);
    if (this.used.has(a.nonce)) throw new Error('fixture replay');
    this.used.add(a.nonce);
    const index = this.transfers.size;
    const raw = await PUBLIC_FIXTURE_OPERATOR.signTransaction({ type: 2, chainId: NETWORKS[this.c.network].chainId, nonce: index, to: this.c.asset, value: 0n, gasLimit: 150000n, maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 1000000n, accessList: [], data: USDC_ABI.encodeFunctionData('transferWithAuthorization', [a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, sig.v, sig.r, sig.s])+suffix });
    const signed = Transaction.from(raw); const hash = signed.hash;
    const block = '0x50';
    const tx = { hash, blockNumber: block, blockHash: H(80), to: this.c.asset, from: signed.from, value: '0x0', input: signed.data, type: '0x2', chainId: `0x${signed.chainId.toString(16)}`, nonce: `0x${index.toString(16)}`, gas: `0x${signed.gasLimit.toString(16)}`, maxFeePerGas: `0x${signed.maxFeePerGas.toString(16)}`, maxPriorityFeePerGas: `0x${signed.maxPriorityFeePerGas.toString(16)}`, accessList: [], r: signed.signature.r, s: signed.signature.s, yParity: `0x${signed.signature.yParity.toString(16)}`, transactionIndex: `0x${index.toString(16)}` };
    const logs = [USDC_ABI.encodeEventLog(USDC_ABI.getEvent('AuthorizationUsed'), [a.from, a.nonce]), USDC_ABI.encodeEventLog(USDC_ABI.getEvent('Transfer'), [a.from, a.to, a.value])].map((l, i) => ({ ...l, address: this.c.asset, transactionHash: hash, removed: false, blockNumber: block, blockHash: H(80), transactionIndex: tx.transactionIndex, logIndex: `0x${(index * 2 + i).toString(16)}` }));
    const receipt = { transactionHash: hash, blockNumber: block, blockHash: H(80), to: this.c.asset, from: signed.from, type: '0x2', transactionIndex: tx.transactionIndex, status: '0x1', logs };
    this.transfers.set(hash, { tx, receipt, payment }); return hash;
  }
  rpc = async (method, params) => {
    this.rpcCalls.push(method);
    if (this.override) { const v = this.override(method, params); if (v !== undefined) return v; }
    if (method === 'eth_chainId') return `0x${NETWORKS[this.c.network].chainId.toString(16)}`;
    if (method === 'eth_getBlockByNumber') { const n = params[0] === 'finalized' ? this.finalized : BigInt(params[0]); return { number: `0x${n.toString(16)}`, hash: H(n), timestamp: `0x${this.now.toString(16)}`, transactions: n === 80n ? [...this.transfers.keys()] : [] }; }
    if (method === 'eth_getTransactionByHash') return this.transfers.get(params[0])?.tx ?? null;
    if (method === 'eth_getTransactionReceipt') return this.transfers.get(params[0])?.receipt ?? null;
    if (method === 'eth_getLogs') return [...this.transfers.values()].flatMap((v) => v.receipt.logs.filter((l) => l.topics.length === 3 && l.topics[0] === params[0].topics[0] && l.topics[1] === params[0].topics[1] && l.topics[2] === params[0].topics[2]));
    if (method === 'eth_call') { const [, nonce] = USDC_ABI.decodeFunctionData('authorizationState', params[0].data); return USDC_ABI.encodeFunctionResult('authorizationState', [this.used.has(nonce)]); }
    throw new Error('unsupported fixture RPC');
  };
}
export function fixture(options = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mote-usdc-fixture-')));
  const c = config({ origin: options.origin ?? 'http://127.0.0.1:18899', payTo: PUBLIC_FIXTURE_OPERATOR.address, offerSigner: PUBLIC_FIXTURE_OPERATOR.address, ...options.config });
  const now = Math.floor(Date.now() / 1000);
  const limits = options.limits ?? {};
  const journal = new Journal(join(dir, 'server.sqlite'), c.identity, { create: true, ...limits });
  const policy = { enabled: true, network: c.network, asset: c.asset, payTo: c.payTo, origin: c.origin, offerSigner: c.offerSigner, configHash: c.identity, payer: address(PUBLIC_FIXTURE_PAYER.address), maxPerPayment: c.amount, maxTotal: options.clientBudget ?? '1000000' };
  const clientJournal = new Journal(join(dir, 'client.sqlite'), { config: c.identity, policy }, { create: true, clientBudget: options.clientBudget ?? '1000000' });
  const chain = new FixtureChain(c, now);
  const proof = new FinalizedProof(c, chain.rpc);
  const facilitator = { verifyCalls: 0, settleCalls: 0,
    async verify(p) { this.verifyCalls++; return { isValid: true, payer: p.payload.authorization.from }; },
    async settle(p) { this.settleCalls++; return { success: true, network: c.network, transaction: await chain.settle(p) }; },
  };
  const service = new Service({ config: c, journal, facilitator, proof, receiptSigner: PUBLIC_FIXTURE_OPERATOR, now: () => chain.now, ...options.service });
  return { dir, c, journal, clientJournal, policy, chain, proof, facilitator, service,
    async payment(id = 'fixture-payment-0001', data = input) { const offerResponse = await service.offer(data); return authorize({ config: c, input: data, offerResponse, paymentId: id, signer: signer(PUBLIC_FIXTURE_PAYER), journal: clientJournal, policy, now: chain.now }); },
    close() { if(journal.db.isOpen)journal.close(); if(clientJournal.db.isOpen)clientJournal.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
