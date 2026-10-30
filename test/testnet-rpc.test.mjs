import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASE_SEPOLIA, TESTNET_RPC_LIMITS, createBaseSepoliaReader, inspectBaseSepolia } from '../src/testnet-rpc.mjs';

const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`;
const address = `0x${'11'.repeat(20)}`;
const block = (n) => ({ number: `0x${n.toString(16)}`, hash: hash(n + 1), parentHash: hash(n), timestamp: `0x${(1700000000 + n).toString(16)}` });
function fixture(overrides = {}) {
  const calls = [];
  const reader = {
    async send(method, params) {
      calls.push({ method, params });
      if (overrides.handle) {
        const result = await overrides.handle(method, params, calls);
        if (result !== undefined) return result;
      }
      if (method === 'eth_chainId') return '0x14a34';
      if (method === 'eth_getCode') return '0x60006000';
      if (method === 'eth_getBlockByNumber') {
        const tag = params[0];
        return block({ finalized: 10, safe: 20, latest: 30 }[tag] ?? Number(BigInt(tag)));
      }
      throw new Error(`Unexpected fixture RPC: ${method}`);
    },
  };
  return { reader, calls };
}
function responseFor(request, result, patch = {}) {
  return Response.json({ jsonrpc: '2.0', id: request.id, result, ...patch });
}

test('reader pins endpoint, omits credentials, rejects redirects, and uses unique matching RPC IDs', async () => {
  const seen = [];
  const reader = createBaseSepoliaReader({ fetchImpl: async (url, options) => {
    seen.push({ url, options });
    const request = JSON.parse(options.body);
    assert.equal(url, 'https://sepolia.base.org');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.ok(options.signal instanceof AbortSignal);
    return responseFor(request, '0x14a34');
  } });
  assert.equal(reader.readOnly, true);
  assert.deepEqual(await Promise.all([reader.send('eth_chainId'), reader.send('eth_chainId')]), ['0x14a34', '0x14a34']);
  const ids = seen.map(({ options }) => JSON.parse(options.body).id);
  assert.equal(new Set(ids).size, 2);
  assert.throws(() => createBaseSepoliaReader({ endpoint: 'https://example.com' }), { code: 'RPC_OPTIONS_INVALID' });
});

test('reader denies writes, signing, arbitrary methods and malformed params before invoking fetch', async () => {
  let fetches = 0;
  const reader = createBaseSepoliaReader({ fetchImpl: async () => { fetches++; throw new Error('Must not fetch'); } });
  for (const method of ['eth_sendTransaction', 'eth_sendRawTransaction', 'eth_sign', 'eth_signTypedData_v4', 'wallet_switchEthereumChain', 'personal_sign', 'debug_traceCall', 'admin_addPeer', 'eth_estimateGas']) {
    await assert.rejects(reader.send(method, []), { code: 'RPC_METHOD_DENIED' });
  }
  for (const [method, params] of [
    ['eth_chainId', [1]], ['eth_getBlockByNumber', ['latest', true]],
    ['eth_getBlockByNumber', ['pending', false]], ['eth_getBlockByNumber', ['0x01', false]],
    ['eth_getCode', ['not-an-address', 'latest']], ['eth_getBalance', [address]],
    ['eth_getTransactionReceipt', ['0x01']], ['eth_getTransactionByHash', [hash(1), {}]],
    ['eth_call', [{ to: address, data: '0x123' }, 'latest']],
    ['eth_call', [{ to: [address], data: '0x1234' }, 'latest']],
    ['eth_call', [{ to: address, data: '0x1234', privateKey: 'fixture-forbidden-field' }, 'latest']],
    ['eth_call', [{ to: address, data: '0x1234', value: '0x1' }, 'latest']],
    ['eth_call', [{ to: address, data: '0x1234' }, 'latest', {}]],
    ['eth_call', [{ to: address, data: `0x${'ab'.repeat(TESTNET_RPC_LIMITS.calldataBytes + 1)}` }, 'latest']],
  ]) await assert.rejects(reader.send(method, params), { code: 'RPC_PARAMS_INVALID' });
  assert.equal(fetches, 0);
});

test('reader exposes bounded safe calls needed for a deployment verifier without sending a transaction', async () => {
  const seen = [];
  const reader = createBaseSepoliaReader({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body); seen.push(request.method); return responseFor(request, null);
  } });
  for (const [method, params] of [
    ['eth_getBlockByNumber', ['finalized', false]], ['eth_getCode', [address, '0x1']],
    ['eth_getTransactionReceipt', [hash(2)]], ['eth_getTransactionByHash', [hash(2)]],
    ['eth_getBalance', [address, 'safe']], ['eth_getTransactionCount', [address, 'pending']],
    ['eth_call', [{ to: address, from: address, data: '0x12345678', value: '0x0' }, 'finalized']],
  ]) assert.equal(await reader.send(method, params), null);
  assert.equal(seen.length, 7);
  assert.ok(seen.every((method) => !/send|sign|wallet/i.test(method)));
});

test('reader rejects mismatched IDs, malformed envelopes, duplicate result/error, and remote RPC errors', async () => {
  const replies = [
    (r) => Response.json({ jsonrpc: '2.0', id: r.id + 1, result: '0x14a34' }),
    (r) => Response.json({ jsonrpc: '1.0', id: r.id, result: '0x14a34' }),
    (r) => Response.json([{ jsonrpc: '2.0', id: r.id, result: '0x14a34' }]),
    (r) => Response.json({ jsonrpc: '2.0', id: r.id, result: null, error: { code: -1, message: 'bad' } }),
    (r) => Response.json({ jsonrpc: '2.0', id: r.id }),
    (r) => Response.json({ jsonrpc: '2.0', id: r.id, error: { code: 'wrong', message: 'bad' } }),
    () => new Response('not JSON'),
  ];
  for (const make of replies) {
    const reader = createBaseSepoliaReader({ fetchImpl: async (_url, options) => make(JSON.parse(options.body)) });
    await assert.rejects(reader.send('eth_chainId'), { code: 'RPC_RESPONSE_INVALID' });
  }
  const remote = createBaseSepoliaReader({ fetchImpl: async (_url, options) => Response.json({ jsonrpc: '2.0', id: JSON.parse(options.body).id, error: { code: -32601, message: 'Unsupported tag' } }) });
  await assert.rejects(remote.send('eth_chainId'), { code: 'RPC_REMOTE_ERROR', rpcCode: -32601 });
});

test('reader rejects redirected/wrong-origin, HTTP failures and oversized declared or streamed bodies', async () => {
  for (const [make, code] of [
    [() => ({ redirected: true, url: 'https://elsewhere.example' }), 'RPC_REDIRECT_DENIED'],
    [() => ({ redirected: false, url: 'https://mainnet.base.org' }), 'RPC_REDIRECT_DENIED'],
    [() => new Response('{}', { status: 503 }), 'RPC_HTTP_ERROR'],
    [() => new Response('{}', { status: 302, headers: { location: 'https://elsewhere.example' } }), 'RPC_HTTP_ERROR'],
    [() => new Response('{}', { headers: { 'content-length': String(TESTNET_RPC_LIMITS.responseBytes + 1) } }), 'RPC_RESPONSE_TOO_LARGE'],
    [() => new Response(new Uint8Array(TESTNET_RPC_LIMITS.responseBytes + 1)), 'RPC_RESPONSE_TOO_LARGE'],
  ]) {
    const reader = createBaseSepoliaReader({ fetchImpl: async () => make() });
    await assert.rejects(reader.send('eth_chainId'), { code });
  }
});

test('reader timeout covers fetch and stalled response body even when a mock ignores abort', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const reader = createBaseSepoliaReader({ fetchImpl: async (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  const stalledFetch = reader.send('eth_chainId');
  t.mock.timers.tick(TESTNET_RPC_LIMITS.timeoutMs);
  await assert.rejects(stalledFetch, { code: 'RPC_TIMEOUT' });
  assert.equal(signal.aborted, true);
  const bodyReader = createBaseSepoliaReader({ fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } })) });
  const stalledBody = bodyReader.send('eth_chainId');
  await Promise.resolve();
  t.mock.timers.tick(TESTNET_RPC_LIMITS.timeoutMs);
  await assert.rejects(stalledBody, { code: 'RPC_TIMEOUT' });
});

test('inspection reports observed heads, oracle code and explicit non-deployment/non-fee scope', async () => {
  const { reader, calls } = fixture();
  const snapshot = await inspectBaseSepolia({ reader });
  assert.equal(snapshot.chainId, 84532);
  assert.equal(snapshot.status, 'observed');
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.genesis.number, '0');
  assert.equal(snapshot.heads.finalized.number, '10');
  assert.equal(snapshot.heads.safe.number, '20');
  assert.equal(snapshot.heads.latest.number, '30');
  assert.equal(snapshot.finality.numericConfirmationFallback, false);
  assert.equal(snapshot.deploymentVerified, false);
  assert.equal(snapshot.broadcastEnabled, false);
  assert.equal(snapshot.chainIdentityPinned, false);
  assert.equal(snapshot.readiness, false);
  assert.equal(snapshot.gasPriceOracle.address, BASE_SEPOLIA.gasPriceOracle);
  assert.equal(snapshot.gasPriceOracle.methodsVerified, false);
  assert.equal(snapshot.fees.status, 'not-estimated');
  assert.ok(calls.some((call) => call.method === 'eth_getCode' && call.params[1] === '0xa'));
  assert.deepEqual(calls.filter((call) => call.method === 'eth_getBlockByNumber').map((call) => call.params[0]), ['0x0', 'finalized', 'safe', 'latest', '0x0', '0xa', '0x14', '0x1e']);
});

test('inspection fails closed for wrong/changing chain and malformed or missing finality', async () => {
  for (const [handle, code] of [
    [(method) => method === 'eth_chainId' ? '0x2105' : undefined, 'CHAIN_MISMATCH'],
    [(method, _params, calls) => method === 'eth_chainId' && calls.length > 1 ? '0x1' : undefined, 'CHAIN_MISMATCH'],
    [(method, params) => method === 'eth_getBlockByNumber' && params[0] === 'finalized' ? null : undefined, 'FINALITY_UNAVAILABLE'],
    [(method, params) => { if (method === 'eth_getBlockByNumber' && params[0] === 'safe') throw new Error('unsupported'); }, 'FINALITY_UNAVAILABLE'],
    [(method, params) => method === 'eth_getBlockByNumber' && params[0] === 'finalized' ? { ...block(10), hash: null } : undefined, 'RPC_BLOCK_INVALID'],
    [(method, params) => method === 'eth_getBlockByNumber' && params[0] === 'finalized' ? { ...block(10), number: ['0xa'] } : undefined, 'RPC_BLOCK_INVALID'],
    [(method, params) => method === 'eth_getBlockByNumber' && params[0] === '0x0' ? block(1) : undefined, 'FINALITY_INCONSISTENT'],
  ]) await assert.rejects(inspectBaseSepolia({ reader: fixture({ handle }).reader }), { code });
});

test('inspection rejects inverted heads, same-height hash conflicts, broken ancestry and reorgs', async () => {
  for (const handle of [
    (method, params) => method === 'eth_getBlockByNumber' && params[0] === 'safe' ? block(5) : undefined,
    (method, params) => method === 'eth_getBlockByNumber' && params[0] === 'safe' ? { ...block(10), hash: hash(999) } : undefined,
    (method, params) => method === 'eth_getBlockByNumber' && params[0] === 'safe' ? { ...block(11), parentHash: hash(999) } : undefined,
    (method, params) => method === 'eth_getBlockByNumber' && params[0] === '0xa' ? { ...block(10), hash: hash(999) } : undefined,
  ]) await assert.rejects(inspectBaseSepolia({ reader: fixture({ handle }).reader }), { code: 'FINALITY_INCONSISTENT' });
});

test('inspection fails when oracle code is missing or malformed instead of claiming fee readiness', async () => {
  for (const code of ['0x', '0x123', 'not-code']) {
    const { reader } = fixture({ handle: (method) => method === 'eth_getCode' ? code : undefined });
    await assert.rejects(inspectBaseSepolia({ reader }), { code: 'ORACLE_UNAVAILABLE' });
  }
});

function prunedFetch(message, { finalityMissing = false, canonicalMismatch = false } = {}) {
  const requests = [];
  const backing = fixture();
  const reader = createBaseSepoliaReader({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body); requests.push(request);
    if (request.method === 'eth_getBlockByNumber' && request.params[0] === '0x0') {
      return Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message } });
    }
    if (finalityMissing && request.method === 'eth_getBlockByNumber' && request.params[0] === 'finalized') return responseFor(request, null);
    if (canonicalMismatch && request.method === 'eth_getBlockByNumber' && request.params[0] === '0xa') return responseFor(request, { ...block(10), hash: hash(999) });
    return responseFor(request, await backing.reader.send(request.method, request.params));
  } });
  return { reader, requests };
}

test('known pruned genesis produces an explicitly partial diagnostic with no pinned identity or readiness', async () => {
  const { reader, requests } = prunedFetch('pruned history unavailable: requested 0, earliest available 46500000');
  const snapshot = await inspectBaseSepolia({ reader });
  assert.equal(snapshot.status, 'observed-partial');
  assert.deepEqual(snapshot.genesis, { status: 'unavailable', reason: 'pruned-history', requestedBlock: '0', earliestAvailableBlock: '46500000' });
  assert.equal(snapshot.chainIdentityPinned, false);
  assert.equal(snapshot.readiness, false);
  assert.equal(snapshot.deploymentVerified, false);
  assert.equal(snapshot.broadcastEnabled, false);
  assert.equal(snapshot.finality.canonicalHeadHashesChecked, true);
  assert.equal(snapshot.finality.numericConfirmationFallback, false);
  assert.deepEqual(requests.filter((request) => request.method === 'eth_getBlockByNumber').map((request) => request.params[0]), ['0x0', 'finalized', 'safe', 'latest', '0xa', '0x14', '0x1e']);
});

test('pruned genesis never weakens finality checks or disguises other genesis RPC errors', async () => {
  for (const message of ['block not found', 'missing trie node', 'upstream unavailable', 'pruned history unavailable: requested 1, earliest available 46500000', 'pruned history unavailable: requested 0, earliest available 0']) {
    await assert.rejects(inspectBaseSepolia({ reader: prunedFetch(message).reader }), { code: 'RPC_REMOTE_ERROR' });
  }
  const known = 'pruned history unavailable: requested 0, earliest available 46500000';
  await assert.rejects(inspectBaseSepolia({ reader: prunedFetch(known, { finalityMissing: true }).reader }), { code: 'FINALITY_UNAVAILABLE' });
  await assert.rejects(inspectBaseSepolia({ reader: prunedFetch(known, { canonicalMismatch: true }).reader }), { code: 'FINALITY_INCONSISTENT' });
});
