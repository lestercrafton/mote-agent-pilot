import { assert, address, hash32 } from './protocol.mjs';

export const LOOKUP_LIMITS = Object.freeze({ pageBlocks: 200n, windowBlocks: 4096n, rpcCalls: 128, timeoutMs: 15000, pageLogs: 4 });
const q = x => { assert(typeof x === 'string' && /^0x[0-9a-f]+$/i.test(x), 'RPC_QUANTITY'); return BigInt(x); };
const hex = n => `0x${n.toString(16)}`;

// One bounded read-only lookup. A caller may shorten, but cannot extend, its deadline.
// Abort races also bound custom RPC implementations which ignore AbortSignal.
export function lookupRpc(rpc, { signal, timeoutMs = LOOKUP_LIMITS.timeoutMs } = {}) {
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= LOOKUP_LIMITS.timeoutMs, 'LOOKUP_DEADLINE');
  assert(signal === undefined || signal instanceof AbortSignal, 'LOOKUP_SIGNAL');
  const expires = performance.now() + timeoutMs, deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const stop = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  let calls = 0;
  const check = () => { assert(!stop.aborted && performance.now() < expires, signal?.aborted ? 'LOOKUP_CANCELLED' : 'LOOKUP_DEADLINE'); };
  const read = async (method, params) => {
    check(); assert(++calls <= LOOKUP_LIMITS.rpcCalls, 'LOOKUP_RPC_LIMIT');
    const snapshot = structuredClone(params);
    let onAbort;
    const cancelled = new Promise((_, reject) => { onAbort = () => { try { check(); } catch (e) { reject(e); } }; stop.addEventListener('abort', onAbort, { once: true }); });
    try { const result = await Promise.race([Promise.resolve().then(() => { check(); return rpc(method, snapshot, { signal: stop }); }), cancelled]); check(); const copy = structuredClone(result); check(); return copy; }
    finally { stop.removeEventListener('abort', onAbort); }
  };
  return Object.assign(read, { check, close: () => { clearTimeout(timer); deadline.abort(); } });
}

// validAfter is zero in this profile. It cannot safely supply a historical start.
// Search a fixed, bounded tail ending before signed validBefore (or at current
// finality while unexpired). This survives long restarts without an unbounded scan.
// A paid authorization outside the tail stays unknown; absence is never proof.
export async function locateLogs({ config: c, payment, rpc, proof, abi }) {
  const f = await proof.anchor();
  const top = q(f.number), expiryText = payment.payload.authorization.validBefore;
  assert(top < (1n << 64n) && typeof expiryText === 'string' && /^(0|[1-9][0-9]*)$/.test(expiryText), 'LOOKUP_RANGE');
  const expiry = BigInt(expiryText); assert(expiry > 0n && expiry < (1n << 64n), 'LOOKUP_RANGE');
  const block = async n => { const b = await rpc('eth_getBlockByNumber', [hex(n), false]); assert(b && q(b.number) === n && hash32(b.hash), 'LOOKUP_BLOCK'); q(b.timestamp); return b; };
  let end = top, endBlock = f;
  if (q(f.timestamp) >= expiry) {
    // First block at/after expiry; EIP-3009 requires timestamp < validBefore.
    let lo = 0n, hi = top;
    while (lo < hi) { const mid = (lo + hi) / 2n, b = await block(mid); if (q(b.timestamp) < expiry) lo = mid + 1n; else hi = mid; }
    const boundary = await block(lo); assert(q(boundary.timestamp) >= expiry, 'LOOKUP_BOUNDARY');
    end = lo - 1n;
    if (end >= 0n) { endBlock = await block(end); assert(q(endBlock.timestamp) < expiry, 'LOOKUP_BOUNDARY'); }
  }
  const stable = async () => {
    assert((await block(top)).hash === f.hash, 'FINALITY_CHANGED');
    if (end >= 0n) assert((await block(end)).hash === endBlock.hash, 'LOOKUP_CHAIN_CHANGED');
  };
  if (end < 0n) { await stable(); return null; }
  const start = end >= LOOKUP_LIMITS.windowBlocks ? end - LOOKUP_LIMITS.windowBlocks + 1n : 0n;
  const a = payment.payload.authorization, topics = abi.encodeFilterTopics('AuthorizationUsed', [a.from, a.nonce]);
  const matches = new Map();
  for (let first = start; first <= end; first += LOOKUP_LIMITS.pageBlocks) {
    const last = first + LOOKUP_LIMITS.pageBlocks - 1n < end ? first + LOOKUP_LIMITS.pageBlocks - 1n : end;
    const logs = await rpc('eth_getLogs', [{ address: c.asset, fromBlock: hex(first), toBlock: hex(last), topics }]);
    assert(Array.isArray(logs) && logs.length <= LOOKUP_LIMITS.pageLogs, 'LOG_LOOKUP_LIMIT');
    for (const log of logs) {
      assert(log && log.removed === false && hash32(log.transactionHash) && hash32(log.blockHash) && address(log.address) === c.asset, 'LOOKUP_LOG');
      assert(q(log.blockNumber) >= first && q(log.blockNumber) <= last && q(log.transactionIndex) < (1n << 64n) && q(log.logIndex) < (1n << 64n), 'LOOKUP_LOG_RANGE');
      assert(log.data === '0x' && Array.isArray(log.topics) && log.topics.length === topics.length && log.topics.every((v, i) => typeof v === 'string' && v.toLowerCase() === topics[i].toLowerCase()), 'LOOKUP_EVENT');
      const normalized = { transactionHash: log.transactionHash.toLowerCase(), blockHash: log.blockHash.toLowerCase(), blockNumber: hex(q(log.blockNumber)), transactionIndex: hex(q(log.transactionIndex)), logIndex: hex(q(log.logIndex)) };
      const key = normalized.transactionHash + ':' + normalized.logIndex, old = matches.get(key);
      assert(!old || JSON.stringify(old) === JSON.stringify(normalized), 'LOOKUP_CONTRADICTION');
      matches.set(key, normalized);
      // One nonce can be consumed once. Do not return early and overlook a later conflict.
      assert(matches.size <= 1, 'LOOKUP_CONTRADICTION');
    }
  }
  await stable();
  const candidate = [...matches.values()][0];
  if (!candidate) return null;
  const settled = await proof.settled(payment, candidate.transactionHash);
  if (!settled) return null;
  assert(settled.blockNumber === candidate.blockNumber && settled.blockHash.toLowerCase() === candidate.blockHash, 'LOOKUP_CONTRADICTION');
  await stable();
  return settled;
}
