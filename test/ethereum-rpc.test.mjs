import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE_SEPOLIA, ETHEREUM_SEPOLIA, getTestnetNetwork } from '../src/testnet-networks.mjs';
import { createEthereumSepoliaReader, createBaseSepoliaReader, inspectEthereumSepolia, TESTNET_RPC_LIMITS } from '../src/testnet-rpc.mjs';

test('network registry permits only explicit numeric Sepolia IDs and freezes network identity and fee model', () => {
  assert.strictEqual(getTestnetNetwork(11155111), ETHEREUM_SEPOLIA);
  assert.strictEqual(getTestnetNetwork(84532), BASE_SEPOLIA);
  assert.equal(ETHEREUM_SEPOLIA.protocol, 'mote-ethereum-sepolia-test-v1');
  assert.equal(ETHEREUM_SEPOLIA.feeModel, 'ethereum-eip1559');
  assert.equal(BASE_SEPOLIA.feeModel, 'op-stack');
  assert.equal(ETHEREUM_SEPOLIA.genesisHash, '0x25a5cc106eea7138acab33231d7160d69cb777ee0c2c553fcddf5138993e6dd9');
  for (const chainId of [1, 8453, 31337, 17000, '11155111', '84532', 11155111n, undefined, null, {}, NaN]) {
    assert.throws(() => getTestnetNetwork(chainId), { code: 'NETWORK_DENIED' });
  }
  assert.throws(() => { ETHEREUM_SEPOLIA.rpcUrl = 'https://untrusted.example'; }, TypeError);
  assert.throws(() => { BASE_SEPOLIA.feeModel = 'ethereum-eip1559'; }, TypeError);
});

test('Ethereum reader fixes the provider endpoint with no credentials, redirects or endpoint override', async () => {
  const seen = [];
  const reader = createEthereumSepoliaReader({ fetchImpl: async (url, options) => {
    seen.push([url, options]); const request = JSON.parse(options.body);
    return Response.json({ jsonrpc: '2.0', id: request.id, result: ETHEREUM_SEPOLIA.chainIdHex });
  } });
  assert.equal(reader.endpoint, 'https://ethereum-sepolia-rpc.publicnode.com');
  assert.equal(reader.readOnly, true);
  assert.deepEqual(await Promise.all([reader.send('eth_chainId'), reader.send('eth_chainId')]), ['0xaa36a7', '0xaa36a7']);
  assert.equal(new Set(seen.map(([, options]) => JSON.parse(options.body).id)).size, 2);
  for (const [url, options] of seen) {
    assert.equal(url, ETHEREUM_SEPOLIA.rpcUrl); assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer');
  }
  assert.throws(() => createEthereumSepoliaReader({ endpoint: BASE_SEPOLIA.rpcUrl }), { code: 'RPC_OPTIONS_INVALID' });
  assert.throws(() => createEthereumSepoliaReader({ apiKey: 'not-a-key' }), { code: 'RPC_OPTIONS_INVALID' });
  assert.equal(createBaseSepoliaReader().endpoint, BASE_SEPOLIA.rpcUrl);
});

test('Ethereum reader forbids signing, broadcasts, arbitrary methods, state overrides and nonzero call value', async () => {
  let fetched = false;
  const reader = createEthereumSepoliaReader({ fetchImpl: async () => { fetched = true; throw new Error('must not fetch'); } });
  for (const method of ['eth_sendTransaction', 'eth_sendRawTransaction', 'eth_sign', 'eth_signTypedData_v4', 'personal_sign', 'eth_estimateGas', 'debug_traceTransaction']) {
    await assert.rejects(reader.send(method, []), { code: 'RPC_METHOD_DENIED' });
  }
  const call = { to: `0x${'11'.repeat(20)}`, data: '0x12345678' };
  for (const params of [[{ ...call, value: '0x1' }, 'latest'], [call, 'latest', {}], [{ ...call, privateKey: 'forbidden' }, 'latest']]) {
    await assert.rejects(reader.send('eth_call', params), { code: 'RPC_PARAMS_INVALID' });
  }
  assert.equal(fetched, false);
});

test('Ethereum reader rejects mismatched RPC replies, other-origin responses and oversized payloads', async () => {
  for (const [respond, code] of [
    [(request) => Response.json({ jsonrpc: '2.0', id: request.id + 1, result: '0xaa36a7' }), 'RPC_RESPONSE_INVALID'],
    [() => ({ redirected: true, url: BASE_SEPOLIA.rpcUrl }), 'RPC_REDIRECT_DENIED'],
    [() => ({ redirected: false, url: 'https://ethereum-rpc.publicnode.com' }), 'RPC_REDIRECT_DENIED'],
    [() => new Response('{}', { status: 503 }), 'RPC_HTTP_ERROR'],
    [() => new Response(new Uint8Array(TESTNET_RPC_LIMITS.responseBytes + 1)), 'RPC_RESPONSE_TOO_LARGE'],
  ]) {
    const reader = createEthereumSepoliaReader({ fetchImpl: async (_url, options) => respond(JSON.parse(options.body)) });
    await assert.rejects(reader.send('eth_chainId'), { code });
  }
});

function observationFixture(change) {
  const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`;
  const calls = [];
  return { calls, async send(method, params) {
    calls.push([method, params]); let result;
    if (method === 'eth_chainId') result = ETHEREUM_SEPOLIA.chainIdHex;
    else {
      assert.equal(method, 'eth_getBlockByNumber', 'Ethereum observation must not query an OP-stack oracle');
      const number = { finalized: 10, safe: 20, latest: 30 }[params[0]] ?? Number(BigInt(params[0]));
      result = { number: `0x${number.toString(16)}`, hash: number === 0 ? ETHEREUM_SEPOLIA.genesisHash : hash(number + 1),
        parentHash: hash(number), timestamp: `0x${(1700000000 + number).toString(16)}` };
    }
    return change ? change(method, params, result) : result;
  } };
}

test('Ethereum observation verifies canonical genesis and ordered canonical heads without an OP oracle or readiness claim', async () => {
  const reader = observationFixture(); const result = await inspectEthereumSepolia({ reader });
  assert.equal(result.network, 'ethereum-sepolia'); assert.equal(result.chainId, 11155111);
  assert.equal(result.genesis.hash, ETHEREUM_SEPOLIA.genesisHash); assert.equal(result.genesisMatchesRegistry, true);
  assert.equal(result.heads.finalized.number, '10'); assert.equal(result.fees.feeModel, 'ethereum-eip1559');
  assert.equal(result.readiness, false); assert.equal(result.broadcastEnabled, false); assert.equal(result.deploymentVerified, false);
  assert.equal(result.fees.totalSpendCapProvided, false); assert.equal(result.gasPriceOracle, undefined);
});

test('Ethereum observation fails closed on unavailable or incorrect genesis, wrong chain and inconsistent finality', async () => {
  for (const [change, code] of [
    [(method, _params, result) => method === 'eth_chainId' ? BASE_SEPOLIA.chainIdHex : result, 'CHAIN_MISMATCH'],
    [(method, params, result) => method === 'eth_getBlockByNumber' && params[0] === '0x0' ? { ...result, hash: `0x${'11'.repeat(32)}` } : result, 'CHAIN_MISMATCH'],
    [(method, params, result) => { if (method === 'eth_getBlockByNumber' && params[0] === '0x0') throw new Error('pruned genesis'); return result; }, undefined],
    [(method, params, result) => method === 'eth_getBlockByNumber' && params[0] === 'finalized' ? null : result, 'FINALITY_UNAVAILABLE'],
    [(method, params, result) => method === 'eth_getBlockByNumber' && params[0] === '0xa' ? { ...result, hash: `0x${'22'.repeat(32)}` } : result, 'FINALITY_INCONSISTENT'],
  ]) await assert.rejects(inspectEthereumSepolia({ reader: observationFixture(change) }), code ? { code } : /pruned genesis/);
});
