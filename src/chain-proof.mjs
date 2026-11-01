import { Interface, Signature, Transaction } from 'ethers';
import { assert, address, hash32, NETWORKS } from './protocol.mjs';
import { readLimitedText } from '@x402/core/http';
import { validateTransferCalldata } from './attribution.mjs';
import { lookupRpc, locateLogs } from './log-recovery.mjs';

export const USDC_ABI = new Interface([
  'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
  'function authorizationState(address authorizer,bytes32 nonce) view returns (bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)',
]);
const quantity = (x) => { assert(typeof x === 'string' && /^0x[0-9a-f]+$/i.test(x), 'RPC_QUANTITY'); return BigInt(x); };
export function rpcReader(url, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const target = new URL(url);
  assert(target.protocol === 'https:' && !target.username && !target.password && !target.hash && !target.search, 'RPC_URL');
  return async (method, params, { signal } = {}) => {
    assert(['eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_call', 'eth_getLogs'].includes(method), 'READ_ONLY_RPC');
    const timeout = AbortSignal.timeout(timeoutMs);
    const r = await fetchImpl(target.href, { method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    assert(r.ok && !r.redirected, 'RPC_UNAVAILABLE');
    const d = JSON.parse(await readLimitedText(r, 262144));
    assert(d.id === 1 && !d.error && Object.hasOwn(d, 'result'), 'RPC_UNAVAILABLE');
    return d.result;
  };
}
export class FinalizedProof {
  constructor(c, rpc) { this.c = c; this.rpc = rpc; }
  async anchor() {
    assert(quantity(await this.rpc('eth_chainId', [])) === BigInt(NETWORKS[this.c.network].chainId), 'CHAIN_MISMATCH');
    const f = await this.rpc('eth_getBlockByNumber', ['finalized', false]);
    assert(f && hash32(f.hash), 'FINALITY_UNAVAILABLE'); quantity(f.number); quantity(f.timestamp);
    return f;
  }
  async settled(payment, txHash) {
    assert(hash32(txHash), 'TX_HASH');
    const f = await this.anchor();
    const [tx, receipt] = await Promise.all([this.rpc('eth_getTransactionByHash', [txHash]), this.rpc('eth_getTransactionReceipt', [txHash])]);
    if (!tx || !receipt || receipt.blockNumber == null || quantity(receipt.blockNumber) > quantity(f.number)) return null;
    const block = await this.rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
    assert(block?.hash === receipt.blockHash && block.number === receipt.blockNumber && tx.blockHash === receipt.blockHash && tx.blockNumber === receipt.blockNumber && tx.hash === txHash && receipt.transactionHash === txHash, 'NONCANONICAL_RECEIPT');
    assert(quantity(tx.type) === 2n && quantity(receipt.type) === 2n && quantity(tx.chainId) === BigInt(NETWORKS[this.c.network].chainId), 'TRANSACTION_PROFILE');
    const signed = Transaction.from({ type: 2, chainId: quantity(tx.chainId), nonce: Number(quantity(tx.nonce)), to: tx.to, value: quantity(tx.value), data: tx.input, gasLimit: quantity(tx.gas), maxFeePerGas: quantity(tx.maxFeePerGas), maxPriorityFeePerGas: quantity(tx.maxPriorityFeePerGas), accessList: tx.accessList,
      signature: { r: tx.r, s: tx.s, yParity: Number(quantity(tx.yParity ?? tx.v)) } });
    assert(Number.isSafeInteger(signed.nonce) && signed.hash === txHash && address(signed.from) === address(tx.from) && address(receipt.from) === address(tx.from), 'TRANSACTION_SIGNATURE');
    const index = Number(quantity(tx.transactionIndex));
    assert(Number.isSafeInteger(index) && receipt.transactionIndex === tx.transactionIndex && Array.isArray(block.transactions) && block.transactions[index] === txHash, 'BLOCK_MEMBERSHIP');
    assert(quantity(receipt.status) === 1n && address(tx.to) === this.c.asset && address(receipt.to) === this.c.asset && quantity(tx.value) === 0n, 'WRONG_TRANSFER');
    const a = payment.payload.authorization;
    const sig = Signature.from(payment.payload.signature);
    const expected = USDC_ABI.encodeFunctionData('transferWithAuthorization', [a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, sig.v, sig.r, sig.s]);
    validateTransferCalldata(tx.input, expected);
    let used = 0; let moved = 0;
    assert(Array.isArray(receipt.logs) && receipt.logs.length <= 128, 'LOG_LIMIT');
    let previousIndex = -1n;
    for (const log of receipt.logs) {
      assert(log.removed === false && log.transactionHash === txHash && log.blockHash === receipt.blockHash && log.blockNumber === receipt.blockNumber && log.transactionIndex === receipt.transactionIndex && quantity(log.logIndex) > previousIndex, 'LOG_BINDING');
      previousIndex = quantity(log.logIndex);
      if (address(log.address) !== this.c.asset) continue;
      let parsed; try { parsed = USDC_ABI.parseLog(log); } catch { continue; }
      if (parsed) { const encoded = USDC_ABI.encodeEventLog(parsed.fragment, parsed.args); assert(encoded.data.toLowerCase() === log.data.toLowerCase() && JSON.stringify(encoded.topics.map(t => t.toLowerCase())) === JSON.stringify(log.topics.map(t => t.toLowerCase())), 'LOG_ENCODING'); }
      if (parsed?.name === 'AuthorizationUsed' && address(parsed.args.authorizer) === address(a.from) && parsed.args.nonce.toLowerCase() === a.nonce.toLowerCase()) used++;
      if (parsed?.name === 'Transfer' && address(parsed.args.from) === address(a.from) && address(parsed.args.to) === this.c.payTo && parsed.args.value === BigInt(a.value)) moved++;
    }
    assert(used === 1 && moved === 1, 'EVENT_MISMATCH');
    const again = await this.rpc('eth_getBlockByNumber', [f.number, false]);
    assert(again?.hash === f.hash, 'FINALITY_CHANGED');
    const inclusion = await this.rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
    assert(inclusion?.hash === receipt.blockHash && inclusion.transactions?.[index] === txHash, 'INCLUSION_CHANGED');
    return { transaction: txHash, network: this.c.network, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, finalizedBlock: f.number, finalizedHash: f.hash };
  }
  async locate(payment, options) {
    const snapshot = structuredClone(payment), rpc = lookupRpc(this.rpc, options);
    try { const result = await locateLogs({ config: this.c, payment: snapshot, rpc, proof: new FinalizedProof(this.c, rpc), abi: USDC_ABI }); rpc.check(); return result; }
    finally { rpc.close(); }
  }
  async expiredUnused(payment) {
    const f = await this.anchor(); const a = payment.payload.authorization;
    if (quantity(f.timestamp) <= BigInt(a.validBefore)) return false;
    // EIP-1898 block-hash pin. Unsupported archive/state RPC fails closed.
    const result = await this.rpc('eth_call', [{ to: this.c.asset, data: USDC_ABI.encodeFunctionData('authorizationState', [a.from, a.nonce]) }, { blockHash: f.hash, requireCanonical: true }]);
    assert(/^0x[0-9a-fA-F]{64}$/.test(result), 'AUTH_STATE');
    const [used] = USDC_ABI.decodeFunctionResult('authorizationState', result);
    const again = await this.rpc('eth_getBlockByNumber', [f.number, false]);
    assert(again?.hash === f.hash, 'FINALITY_CHANGED');
    return !used;
  }
}
