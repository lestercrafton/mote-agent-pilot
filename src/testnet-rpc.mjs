import { keccak256 } from 'ethers';
import { BASE_SEPOLIA, ETHEREUM_SEPOLIA } from './testnet-networks.mjs';
export { BASE_SEPOLIA, ETHEREUM_SEPOLIA } from './testnet-networks.mjs';

// Primary references, checked 2026-10-30:
// https://docs.base.org/get-started/connect-to-base
// https://docs.base.org/specifications/transactions/transaction-finality
// https://docs.base.org/specifications/transactions/network-fees
// https://docs.optimism.io/op-stack/transactions/fees
// Base fee estimation must include execution + L1 data + any configured operator
// component. This module does not estimate fees or authorize a spending cap.
export const TESTNET_RPC_LIMITS = Object.freeze({ timeoutMs: 10_000, responseBytes: 1_048_576, requestBytes: 131_072, calldataBytes: 65_536 });

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/;
const DATA = /^0x(?:[0-9a-fA-F]{2})*$/;
const HEAD_TAGS = new Set(['latest', 'safe', 'finalized']);
const METHODS = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getBalance', 'eth_getTransactionCount']);
// Some exact numbered-block state reads have returned this error and later
// succeeded at the same endpoint. Retry only Ethereum Sepolia's exact diagnosis;
// this does not prove backend architecture, retention or eventual availability.
const STATE_METHODS = new Set(['eth_getCode', 'eth_call', 'eth_getBalance', 'eth_getTransactionCount']);
const HISTORICAL_STATE_MISS = /^historical state [0-9a-f]{64} is not available$/;
export const HISTORICAL_STATE_ATTEMPTS = 6;
export const HISTORICAL_STATE_TOTAL_MS = 15_000;
const HISTORICAL_STATE_PAUSE_MS = 200;

export class TestnetRpcError extends Error {
  constructor(code, message, { cause, rpcCode, rpcMessage } = {}) {
    super(message, { cause }); this.name = 'TestnetRpcError'; this.code = code;
    if (rpcCode !== undefined) this.rpcCode = rpcCode;
    if (rpcMessage !== undefined) this.rpcMessage = rpcMessage;
  }
}
function check(value, code, message) { if (!value) throw new TestnetRpcError(code, message); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function blockTag(value, pending = false) { return typeof value === 'string' && (HEAD_TAGS.has(value) || QUANTITY.test(value) || (pending && value === 'pending')); }
function validateParams(method, params) {
  check(METHODS.has(method), 'RPC_METHOD_DENIED', 'Only the explicit read-only testnet methods are permitted');
  check(Array.isArray(params), 'RPC_PARAMS_INVALID', 'RPC params must be an array');
  if (method === 'eth_chainId') check(params.length === 0, 'RPC_PARAMS_INVALID', 'eth_chainId accepts no params');
  if (method === 'eth_getBlockByNumber') check(params.length === 2 && blockTag(params[0]) && params[1] === false, 'RPC_PARAMS_INVALID', 'Read a numbered/latest/safe/finalized block with transaction hashes only');
  if (['eth_getCode', 'eth_getBalance', 'eth_getTransactionCount'].includes(method)) check(params.length === 2 && typeof params[0] === 'string' && ADDRESS.test(params[0]) && blockTag(params[1], method === 'eth_getTransactionCount'), 'RPC_PARAMS_INVALID', 'Read requires an address and explicit bounded block selector');
  if (['eth_getTransactionReceipt', 'eth_getTransactionByHash'].includes(method)) check(params.length === 1 && typeof params[0] === 'string' && HASH.test(params[0]), 'RPC_PARAMS_INVALID', 'Transaction reads require one 32-byte hash');
  if (method === 'eth_call') {
    check(params.length === 2 && isObject(params[0]) && blockTag(params[1]), 'RPC_PARAMS_INVALID', 'eth_call requires one call object and explicit block selector; state overrides are not permitted');
    const call = params[0];
    check(Object.keys(call).every((key) => ['to', 'from', 'data', 'value'].includes(key)) && typeof call.to === 'string' && ADDRESS.test(call.to) && typeof call.data === 'string' && DATA.test(call.data) && (call.data.length - 2) / 2 <= TESTNET_RPC_LIMITS.calldataBytes, 'RPC_PARAMS_INVALID', 'eth_call requires a target and bounded calldata, with no unknown fields');
    check(call.from === undefined || (typeof call.from === 'string' && ADDRESS.test(call.from)), 'RPC_PARAMS_INVALID', 'Invalid read-call sender');
    check(call.value === undefined || call.value === '0x0', 'RPC_PARAMS_INVALID', 'Read calls must not specify nonzero native value');
  }
}

async function readBoundedJson(response) {
  const declared = response.headers.get('content-length');
  if (declared !== null) check(/^\d+$/.test(declared) && BigInt(declared) <= BigInt(TESTNET_RPC_LIMITS.responseBytes), 'RPC_RESPONSE_TOO_LARGE', 'RPC response exceeds its byte limit');
  check(response.body && typeof response.body.getReader === 'function', 'RPC_RESPONSE_INVALID', 'RPC response must have a readable body');
  const reader = response.body.getReader();
  const chunks = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > TESTNET_RPC_LIMITS.responseBytes) {
        await reader.cancel();
        throw new TestnetRpcError('RPC_RESPONSE_TOO_LARGE', 'RPC response exceeds its byte limit');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (cause) { throw new TestnetRpcError('RPC_RESPONSE_INVALID', 'RPC response was not valid JSON', { cause }); }
}

/** Fixed public read endpoint. No signer, credentials or endpoint override; the only retry is the bounded same-endpoint historical-state miss above. */
export function createBaseSepoliaReader(options = {}) {
  return createFixedReader(BASE_SEPOLIA, options);
}
/** Fixed third-party Ethereum Sepolia read endpoint; no credentials or sends. */
export function createEthereumSepoliaReader(options = {}) {
  return createFixedReader(ETHEREUM_SEPOLIA, options);
}
function createFixedReader(network, options) {
  check(isObject(options) && Object.keys(options).every((key) => key === 'fetchImpl'), 'RPC_OPTIONS_INVALID', 'Only a test fetch implementation can be supplied; endpoint overrides are forbidden');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  check(typeof fetchImpl === 'function', 'RPC_OPTIONS_INVALID', 'A fetch implementation is required');
  let nextId = 1;
  const sendOnce = async (method, params, timeoutMs) => {
      check(Number.isSafeInteger(nextId), 'RPC_REQUEST_LIMIT', 'RPC request identifier limit reached');
      const id = nextId++;
      const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      check(Buffer.byteLength(body) <= TESTNET_RPC_LIMITS.requestBytes, 'RPC_REQUEST_TOO_LARGE', 'RPC request exceeds its byte limit');
      const controller = new AbortController();
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new TestnetRpcError('RPC_TIMEOUT', 'Read-only RPC request exceeded its time limit')); }, timeoutMs);
        timer.unref?.();
      });
      const work = async () => {
        const response = await fetchImpl(network.rpcUrl, {
          method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
          body, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal,
        });
        check(response && !response.redirected && (!response.url || response.url === network.rpcUrl || response.url === `${network.rpcUrl}/`), 'RPC_REDIRECT_DENIED', 'RPC responses must come directly from the fixed endpoint');
        check(response.status >= 200 && response.status < 300, 'RPC_HTTP_ERROR', `RPC endpoint returned HTTP ${response.status}`);
        const reply = await readBoundedJson(response);
        check(isObject(reply) && reply.jsonrpc === '2.0' && reply.id === id && Object.keys(reply).every((key) => ['jsonrpc', 'id', 'result', 'error'].includes(key)), 'RPC_RESPONSE_INVALID', 'RPC response envelope or request ID did not match');
        const hasResult = Object.hasOwn(reply, 'result'); const hasError = Object.hasOwn(reply, 'error');
        check(hasResult !== hasError, 'RPC_RESPONSE_INVALID', 'RPC response must contain exactly one result or error');
        if (hasError) {
          check(isObject(reply.error) && Number.isInteger(reply.error.code) && typeof reply.error.message === 'string', 'RPC_RESPONSE_INVALID', 'Malformed RPC error envelope');
          throw new TestnetRpcError('RPC_REMOTE_ERROR', `Read-only RPC ${method} failed: ${reply.error.message.slice(0, 512)}`, { rpcCode: reply.error.code, rpcMessage: reply.error.message.slice(0, 512) });
        }
        return reply.result;
      };
      try { return await Promise.race([work(), timeout]); }
      catch (cause) {
        if (cause instanceof TestnetRpcError) throw cause;
        if (controller.signal.aborted) throw new TestnetRpcError('RPC_TIMEOUT', 'Read-only RPC request exceeded its time limit', { cause });
        throw new TestnetRpcError('RPC_NETWORK_ERROR', 'Fixed-endpoint read-only RPC request failed', { cause });
      } finally { clearTimeout(timer); controller.abort(); }
  };
  return Object.freeze({
    endpoint: network.rpcUrl,
    readOnly: true,
    async send(method, params = []) {
      validateParams(method, params);
      // Snapshot before the first await, then revalidate the serialized value.
      // Caller mutation and custom accessors cannot redirect a later attempt.
      const fixed = JSON.parse(JSON.stringify(params));
      validateParams(method, fixed);
      const eligible = network.chainId === ETHEREUM_SEPOLIA.chainId && STATE_METHODS.has(method) && QUANTITY.test(fixed[1]);
      const deadline = performance.now() + (eligible ? HISTORICAL_STATE_TOTAL_MS : TESTNET_RPC_LIMITS.timeoutMs);
      for (let attempt = 1; ; attempt++) {
        const remaining = Math.floor(deadline - performance.now());
        check(remaining > 0, 'RPC_TIMEOUT', 'Read-only RPC total time limit reached');
        try {
          const result = await sendOnce(method, fixed, Math.min(TESTNET_RPC_LIMITS.timeoutMs, remaining));
          check(performance.now() < deadline, 'RPC_TIMEOUT', 'Read-only RPC total time limit reached');
          return result;
        }
        catch (error) {
          if (!eligible || attempt >= HISTORICAL_STATE_ATTEMPTS || !historicalStateMiss(method, fixed, error)) throw error;
          check(deadline - performance.now() > HISTORICAL_STATE_PAUSE_MS, 'RPC_TIMEOUT', 'Read-only RPC total time limit reached');
          // The pending retry must keep standalone clients alive.
          await new Promise(resolve => setTimeout(resolve, HISTORICAL_STATE_PAUSE_MS));
        }
      }
    },
  });
}

function historicalStateMiss(method, params, error) {
  return STATE_METHODS.has(method) && QUANTITY.test(params[1]) && error instanceof TestnetRpcError && error.code === 'RPC_REMOTE_ERROR'
    && error.rpcCode === -32000 && typeof error.rpcMessage === 'string' && HISTORICAL_STATE_MISS.test(error.rpcMessage);
}

function parseBlock(block, label, expectedNumber) {
  check(isObject(block) && ['number', 'hash', 'parentHash', 'timestamp'].every((key) => typeof block[key] === 'string') && QUANTITY.test(block.number) && HASH.test(block.hash) && HASH.test(block.parentHash) && QUANTITY.test(block.timestamp), 'RPC_BLOCK_INVALID', `${label} did not return a complete canonical block`);
  check(expectedNumber === undefined || BigInt(block.number) === expectedNumber, 'FINALITY_INCONSISTENT', `${label} returned a different block number`);
  return { number: BigInt(block.number).toString(), numberHex: block.number.toLowerCase(), hash: block.hash.toLowerCase(), parentHash: block.parentHash.toLowerCase(), timestamp: BigInt(block.timestamp).toString() };
}

function prunedGenesis(error) {
  // Only this explicit server diagnosis of unavailable height zero permits a
  // partial observation. Timeouts, generic missing-block errors and malformed
  // responses remain failures; no endpoint or weaker finality fallback is used.
  if (error?.code !== 'RPC_REMOTE_ERROR' || !Number.isInteger(error.rpcCode) || typeof error.rpcMessage !== 'string') return null;
  const match = /^pruned history unavailable: requested 0, earliest available ([1-9][0-9]{0,19})$/.exec(error.rpcMessage);
  return match ? { status: 'unavailable', reason: 'pruned-history', requestedBlock: '0', earliestAvailableBlock: match[1] } : null;
}

/** Observe one endpoint's network state; this is not a deployment/readiness test. */
export async function inspectBaseSepolia({ reader = createBaseSepoliaReader() } = {}) {
  check(reader && typeof reader.send === 'function', 'RPC_OPTIONS_INVALID', 'A read-only reader is required');
  const chainId = await reader.send('eth_chainId', []);
  check(typeof chainId === 'string' && QUANTITY.test(chainId) && BigInt(chainId) === BigInt(BASE_SEPOLIA.chainId), 'CHAIN_MISMATCH', 'Endpoint did not report Base Sepolia chain 84532');
  let genesis;
  try { genesis = parseBlock(await reader.send('eth_getBlockByNumber', ['0x0', false]), 'genesis', 0n); }
  catch (error) {
    genesis = prunedGenesis(error);
    if (!genesis) throw error;
  }
  const genesisUnavailable = genesis.status === 'unavailable';
  const heads = {};
  // Read oldest assurance first; a normally advancing chain cannot make an
  // earlier latest read fall behind a subsequently read safe/finalized head.
  for (const tag of ['finalized', 'safe', 'latest']) {
    let block;
    try { block = await reader.send('eth_getBlockByNumber', [tag, false]); }
    catch (cause) {
      if (tag === 'latest') throw cause;
      throw new TestnetRpcError('FINALITY_UNAVAILABLE', `${tag} head is unavailable; numeric-confirmation fallback is forbidden`, { cause });
    }
    check(block !== null, tag === 'latest' ? 'RPC_BLOCK_INVALID' : 'FINALITY_UNAVAILABLE', `${tag} head is unavailable; no weaker fallback is permitted`);
    heads[tag] = parseBlock(block, tag);
  }
  const ordered = [...(genesisUnavailable ? [] : [genesis]), heads.finalized, heads.safe, heads.latest];
  for (let i = 1; i < ordered.length; i++) {
    const prior = ordered[i - 1]; const next = ordered[i];
    check(BigInt(prior.number) <= BigInt(next.number) && BigInt(prior.timestamp) <= BigInt(next.timestamp), 'FINALITY_INCONSISTENT', 'Finalized, safe and latest heads are inconsistent');
    if (prior.number === next.number) check(prior.hash === next.hash, 'FINALITY_INCONSISTENT', 'Different head hashes were returned for the same height');
    if (BigInt(next.number) === BigInt(prior.number) + 1n) check(next.parentHash === prior.hash, 'FINALITY_INCONSISTENT', 'Adjacent reported heads have inconsistent ancestry');
  }
  // Re-read each distinct assurance head by height. This detects a tag/height
  // mismatch or reorg during observation without treating block counts as time.
  for (const head of new Map(ordered.map((block) => [block.number, block])).values()) {
    const canonical = parseBlock(await reader.send('eth_getBlockByNumber', [head.numberHex, false]), 'canonical head', BigInt(head.number));
    check(canonical.hash === head.hash && canonical.timestamp === head.timestamp && canonical.parentHash === head.parentHash, 'FINALITY_INCONSISTENT', 'A reported assurance head is no longer canonical');
  }
  const code = await reader.send('eth_getCode', [BASE_SEPOLIA.gasPriceOracle, heads.finalized.numberHex]);
  check(typeof code === 'string' && DATA.test(code) && code.length > 2, 'ORACLE_UNAVAILABLE', 'GasPriceOracle has no readable code at the observed finalized block');
  const lastChainId = await reader.send('eth_chainId', []);
  check(typeof lastChainId === 'string' && QUANTITY.test(lastChainId) && BigInt(lastChainId) === BigInt(BASE_SEPOLIA.chainId), 'CHAIN_MISMATCH', 'Endpoint chain identity changed during observation');
  return {
    schemaVersion: 1, status: genesisUnavailable ? 'observed-partial' : 'observed', readOnly: true,
    chainId: BASE_SEPOLIA.chainId, endpoint: BASE_SEPOLIA.rpcUrl, observedAt: new Date().toISOString(),
    genesis, heads,
    finality: { tagsSupported: true, canonicalHeadHashesChecked: true, numericConfirmationFallback: false, trust: 'Single fixed RPC endpoint report; not independent consensus verification' },
    gasPriceOracle: { address: BASE_SEPOLIA.gasPriceOracle, codeHash: keccak256(code), codeBytes: (code.length - 2) / 2, atBlockNumber: heads.finalized.number, atBlockHash: heads.finalized.hash, methodsVerified: false },
    fees: { status: 'not-estimated', requiredComponents: ['L2 execution', 'L1 data', 'operator fee when configured'], totalSpendCapProvided: false },
    chainIdentityPinned: false, readiness: false, deploymentVerified: false, broadcastEnabled: false,
  };
}

/** Ethereum-only read observation. The canonical genesis is mandatory; there
 * is no OP-stack oracle or L2 fee component and no partial-genesis fallback. */
export async function inspectEthereumSepolia({ reader = createEthereumSepoliaReader() } = {}) {
  check(reader && typeof reader.send === 'function', 'RPC_OPTIONS_INVALID', 'A read-only reader is required');
  const verifyChain = async () => {
    const chainId = await reader.send('eth_chainId', []);
    check(typeof chainId === 'string' && QUANTITY.test(chainId) && BigInt(chainId) === BigInt(ETHEREUM_SEPOLIA.chainId),
      'CHAIN_MISMATCH', 'Endpoint does not report Ethereum Sepolia chain 11155111');
  };
  await verifyChain();
  const genesis = parseBlock(await reader.send('eth_getBlockByNumber', ['0x0', false]), 'genesis', 0n);
  check(genesis.hash === ETHEREUM_SEPOLIA.genesisHash, 'CHAIN_MISMATCH', 'Ethereum Sepolia genesis differs from the canonical client configuration');
  const heads = {};
  for (const tag of ['finalized', 'safe', 'latest']) {
    let raw;
    try { raw = await reader.send('eth_getBlockByNumber', [tag, false]); }
    catch (cause) {
      if (tag === 'latest') throw cause;
      throw new TestnetRpcError('FINALITY_UNAVAILABLE', `${tag} head is unavailable; numeric-confirmation fallback is forbidden`, { cause });
    }
    check(raw !== null, tag === 'latest' ? 'RPC_BLOCK_INVALID' : 'FINALITY_UNAVAILABLE', `${tag} head is unavailable`);
    heads[tag] = parseBlock(raw, tag);
  }
  const ordered = [genesis, heads.finalized, heads.safe, heads.latest];
  for (let index = 1; index < ordered.length; index++) {
    const prior = ordered[index - 1]; const next = ordered[index];
    check(BigInt(prior.number) <= BigInt(next.number) && BigInt(prior.timestamp) <= BigInt(next.timestamp),
      'FINALITY_INCONSISTENT', 'Genesis, finalized, safe and latest observations are not ordered');
    if (prior.number === next.number) check(prior.hash === next.hash, 'FINALITY_INCONSISTENT', 'Reported heads disagree at the same height');
    if (BigInt(next.number) === BigInt(prior.number) + 1n) check(next.parentHash === prior.hash, 'FINALITY_INCONSISTENT', 'Adjacent reported heads have inconsistent ancestry');
  }
  for (const head of new Map(ordered.map((entry) => [entry.number, entry])).values()) {
    const canonical = parseBlock(await reader.send('eth_getBlockByNumber', [head.numberHex, false]), 'canonical head', BigInt(head.number));
    check(canonical.hash === head.hash && canonical.timestamp === head.timestamp && canonical.parentHash === head.parentHash,
      'FINALITY_INCONSISTENT', 'Observed head changed during its canonical recheck');
  }
  await verifyChain();
  return {
    schemaVersion: 1, status: 'observed', readOnly: true, chainId: ETHEREUM_SEPOLIA.chainId,
    network: ETHEREUM_SEPOLIA.slug, endpoint: ETHEREUM_SEPOLIA.rpcUrl, observedAt: new Date().toISOString(),
    genesis, genesisMatchesRegistry: true, heads,
    finality: { tagsSupported: true, canonicalHeadHashesChecked: true, numericConfirmationFallback: false,
      trust: 'Single third-party RPC report checked against a canonical genesis fingerprint; not independent consensus verification' },
    fees: { status: 'not-estimated', feeModel: ETHEREUM_SEPOLIA.feeModel, requiredComponents: ['execution gas for ordinary type-2 transactions'], totalSpendCapProvided: false },
    chainIdentityPinned: false, readiness: false, deploymentVerified: false, broadcastEnabled: false,
  };
}
