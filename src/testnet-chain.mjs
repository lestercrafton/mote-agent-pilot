import { Contract, Interface, ZeroAddress, ZeroHash, getAddress, getCreateAddress, keccak256, verifyMessage, verifyTypedData } from 'ethers';
import { canonicalStringify, hashJson } from './json.mjs';
import { createBaseSepoliaReader, createEthereumSepoliaReader } from './testnet-rpc.mjs';
import { getTestnetNetwork } from './testnet-networks.mjs';

// Runtime module: no compiler, local chain, account, signer or broadcast imports.
// Configurations are trusted operator inputs. Their hashes detect drift, not
// provenance or authorization. RPC observations are not independent consensus.
export const QUOTE_TYPES = Object.freeze({ Quote: Object.freeze([
  Object.freeze({ name: 'quoteId', type: 'bytes32' }), Object.freeze({ name: 'requestHash', type: 'bytes32' }),
  Object.freeze({ name: 'payer', type: 'address' }), Object.freeze({ name: 'amount', type: 'uint256' }),
  Object.freeze({ name: 'deadline', type: 'uint256' }),
]) });
export function quoteDomain(chainId, verifyingContract) {
  check(Number.isSafeInteger(chainId) && chainId > 0, 'INVALID_CHAIN', 'Quote chain ID must be a positive safe integer');
  return { name: 'MotePayments', version: '1', chainId, verifyingContract: address(verifyingContract) };
}

const TOKEN_ABI = ['function name() view returns(string)', 'function symbol() view returns(string)',
  'function decimals() view returns(uint8)', 'function totalSupply() view returns(uint256)',
  'event Transfer(address indexed from,address indexed to,uint256 value)'];
const ROUTER_ABI = ['function token() view returns(address)', 'function merchant() view returns(address)',
  'function quoteSigner() view returns(address)', 'function consumed(bytes32) view returns(bool)',
  'function eip712Domain() view returns(bytes1 fields,string name,string version,uint256 chainId,address verifyingContract,bytes32 salt,uint256[] extensions)',
  'function pay((bytes32 quoteId,bytes32 requestHash,address payer,uint256 amount,uint256 deadline) quote,bytes signature)',
  'event Paid(bytes32 indexed quoteId,bytes32 indexed requestHash,address indexed payer,uint256 amount)'];
const tokenInterface = new Interface(TOKEN_ABI); const routerInterface = new Interface(ROUTER_ABI);
const HASH = /^0x[0-9a-fA-F]{64}$/; const DATA = /^0x(?:[0-9a-fA-F]{2})*$/;
const UINT_MAX = (1n << 256n) - 1n;
const CONFIG_KEYS = ['schema', 'mode', 'origin', 'chainId', 'genesisHash', 'checkpoint', 'roles', 'deployments', 'compiler', 'verificationInputHash', 'planHash', 'configHash'];
const DEPLOYMENT_KEYS = ['address', 'transactionHash', 'blockNumber', 'blockHash', 'runtimeCodeHash', 'creationBytecodeHash', 'creationInputHash', 'nonce'];
const OFFER_KEYS = ['protocol', 'quote', 'domain', 'signature', 'offerSignature', 'chainId', 'token', 'router', 'recipient', 'quoteSigner', 'decimals', 'asset', 'service', 'resultHash', 'expiresAt', 'inputBytes', 'origin', 'configHash', 'finality', 'testOnly', 'publicSynthetic', 'localOnly'];

export class TestnetChainError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'TestnetChainError'; this.code = code; this.status = status; }
}
function check(ok, code, message, status) { if (!ok) throw new TestnetChainError(code, message, status); }
function networkFor(chainId) {
  try { return getTestnetNetwork(chainId); } catch { throw new TestnetChainError('INVALID_CONFIG', 'Only the two explicitly pinned Sepolia testnets are supported'); }
}
function fields(value, keys, label, code = 'INVALID_CONFIG') {
  check(value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)), code, `${label} requires exactly ${keys.join(', ')}`);
}
function address(value) {
  let parsed; try { parsed = getAddress(value); } catch { throw new TestnetChainError('INVALID_ADDRESS', 'Expected a public EVM address'); }
  check(parsed !== ZeroAddress, 'INVALID_ADDRESS', 'Zero addresses are forbidden'); return parsed.toLowerCase();
}
function sameAddress(a, b) { try { return getAddress(a) === getAddress(b); } catch { return false; } }
function hash(value, label = 'hash', code = 'INVALID_CONFIG') {
  check(typeof value === 'string' && HASH.test(value) && value.toLowerCase() !== ZeroHash, code, `${label} must be a nonzero 32-byte hash`); return value.toLowerCase();
}
function decimal(value, label, code = 'INVALID_CONFIG') {
  check(typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) <= UINT_MAX, code, `${label} must be a canonical uint256 decimal string`); return BigInt(value);
}
function quantity(value, label) {
  check(typeof value === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value), 'INVALID_RPC_EVIDENCE', `${label} must be a canonical RPC quantity`); return BigInt(value);
}
const hex = (value) => `0x${BigInt(value).toString(16)}`;
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function checkpoint(value, label) {
  fields(value, ['blockNumber', 'blockHash'], label); decimal(value.blockNumber, `${label}.blockNumber`); hash(value.blockHash, `${label}.blockHash`);
}
function configFingerprint(config) { const { configHash, ...body } = config; return hashJson(body); }
function origin(value, mode) {
  let url; try { url = new URL(value); } catch { throw new TestnetChainError('INVALID_CONFIG', 'A canonical service origin is required'); }
  check(url.origin === value && !url.username && !url.password
    && (url.protocol === 'https:' || (mode === 'local-fixture' && url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))),
  'INVALID_CONFIG', 'Service origin must be canonical HTTPS; only local fixture origins may use loopback HTTP');
}

export function validateTestnetChainConfig(raw, expectedConfigHash) {
  fields(raw, CONFIG_KEYS, 'Chain configuration');
  const network = networkFor(raw.chainId);
  check(raw.schema === network.configSchema && [network.slug, 'local-fixture'].includes(raw.mode),
    'INVALID_CONFIG', 'Configuration schema and mode must match the explicitly pinned network');
  origin(raw.origin, raw.mode); checkpoint(raw.checkpoint, 'checkpoint');
  check(raw.mode !== 'local-fixture' || raw.genesisHash !== null, 'INVALID_CONFIG', 'Local fixture identity requires its genesis hash');
  if (raw.genesisHash !== null) hash(raw.genesisHash, 'genesisHash');
  check(raw.mode === 'local-fixture' || network.genesisHash === null || raw.genesisHash === network.genesisHash,
    'INVALID_CONFIG', 'Public Ethereum Sepolia requires the canonical genesis fingerprint from the pinned registry');
  fields(raw.roles, ['deployer', 'initialHolder', 'merchant', 'quoteSigner'], 'roles');
  for (const value of Object.values(raw.roles)) check(address(value) === value, 'INVALID_CONFIG', 'Configuration addresses must be lowercase');
  fields(raw.deployments, ['token', 'payments'], 'deployments');
  for (const [key, value] of Object.entries(raw.deployments)) {
    fields(value, DEPLOYMENT_KEYS, `${key} deployment`);
    check(address(value.address) === value.address, 'INVALID_CONFIG', 'Deployment addresses must be lowercase');
    for (const name of ['transactionHash', 'blockHash', 'runtimeCodeHash', 'creationBytecodeHash', 'creationInputHash']) hash(value[name], name);
    const number = decimal(value.blockNumber, 'deployment blockNumber'); const nonce = decimal(value.nonce, 'deployment nonce');
    check(number <= BigInt(raw.checkpoint.blockNumber) && nonce < BigInt(Number.MAX_SAFE_INTEGER), 'INVALID_CONFIG', 'Deployment must precede its checkpoint and use a supported nonce');
    check(getCreateAddress({ from: raw.roles.deployer, nonce }).toLowerCase() === value.address, 'INVALID_CONFIG', 'Deployment address must match deployer and creation nonce');
  }
  check(BigInt(raw.deployments.payments.nonce) === BigInt(raw.deployments.token.nonce) + 1n
    && raw.deployments.token.transactionHash !== raw.deployments.payments.transactionHash
    && BigInt(raw.deployments.token.blockNumber) <= BigInt(raw.deployments.payments.blockNumber), 'INVALID_CONFIG', 'Two distinct ordered deployments are required');
  fields(raw.compiler, ['version', 'verificationVersion', 'evmVersion', 'optimizer'], 'compiler');
  fields(raw.compiler.optimizer, ['enabled', 'runs'], 'compiler optimizer');
  check(typeof raw.compiler.version === 'string' && /^0\.8\.\d+\+commit\.[0-9a-f]{8}\.Emscripten\.clang$/.test(raw.compiler.version)
    && raw.compiler.verificationVersion === `v${raw.compiler.version.replace('.Emscripten.clang', '')}`
    && raw.compiler.evmVersion === 'shanghai' && raw.compiler.optimizer.enabled === true && raw.compiler.optimizer.runs === 200,
    'INVALID_CONFIG', 'Compiler identity must preserve the verified Mote build settings');
  hash(raw.verificationInputHash, 'verificationInputHash'); hash(raw.planHash, 'planHash'); hash(raw.configHash, 'configHash');
  check(raw.configHash === configFingerprint(raw) && raw.configHash === hash(expectedConfigHash, 'separately pinned expectedConfigHash'),
    'CONFIG_HASH_MISMATCH', 'Chain configuration differs from its separately pinned operator fingerprint');
  return freeze(structuredClone(raw));
}

/** Offline handoff only: caller first runs verifyTestnetDeployment with the
 * complete source bundle. This unsigned record is not a proof of provenance. */
export function createTestnetChainConfig({ plan, evidence, verificationBundle, genesisHash, origin: serviceOrigin, mode }) {
  const network = networkFor(plan?.chainId);
  if (mode === undefined) mode = network.slug;
  if (genesisHash === undefined) genesisHash = mode === 'local-fixture' ? null : network.genesisHash;
  check(plan?.schema === network.planSchema && plan.network === network.slug && evidence?.schema === 'mote-testnet-deployment-verification-v1'
    && verificationBundle?.schema === 'mote-solidity-verification-v1', 'INVALID_CONFIG', 'Use the existing verified plan, deployment evidence and source bundle');
  const { planHash, ...planBody } = plan;
  check(planHash === hashJson(planBody) && evidence.planHash === planHash && evidence.chainId === network.chainId
    && evidence.verificationScope === 'deployment-only' && evidence.source === 'caller-supplied-rpc'
    && evidence.publicNetworkAuthenticityVerified === false && evidence.serviceReadinessVerified === false
    && evidence.feeBudgetVerified === false && evidence.broadcastAuthorization === false
    && plan.authorization === false && plan.broadcastReady === false && plan.publicDeployment === false,
  'INVALID_CONFIG', 'Deployment evidence must match the unsigned verified plan without broadening its claims');
  check(verificationBundle.inputHash === hashJson(verificationBundle.input) && plan.verificationInputHash === verificationBundle.inputHash
    && canonicalStringify(plan.compiler) === canonicalStringify(verificationBundle.compiler), 'INVALID_CONFIG', 'Plan and verification source/compiler fingerprints differ');
  fields(plan.roles, ['deployer', 'initialHolder', 'merchant', 'quoteSigner'], 'plan roles');
  const roles = Object.fromEntries(Object.entries(plan.roles).map(([key, value]) => [key, address(value)]));
  check(evidence.configuration?.tokenName === 'Mote' && evidence.configuration.tokenSymbol === 'MOTE' && evidence.configuration.decimals === 6
    && evidence.configuration.totalSupply === '1000000000000'
    && Object.entries(roles).every(([key, value]) => sameAddress(value, evidence.configuration[key])), 'INVALID_CONFIG', 'Deployment configuration or supply differs from its plan');
  check(Array.isArray(plan.transactions) && plan.transactions.length === 2, 'INVALID_CONFIG', 'Both planned creations are required');
  const deployments = {};
  for (const [index, key] of ['token', 'payments'].entries()) {
    const built = verificationBundle.contracts[index ? 'MotePayments' : 'MoteToken'];
    const planned = plan.contracts[key]; const proved = evidence.contracts?.[key]; const tx = plan.transactions[index];
    const args = index ? [plan.contracts.token.predictedAddress, roles.merchant, roles.quoteSigner] : [roles.initialHolder];
    check(planned && proved && built && planned.contractName === (index ? 'MotePayments' : 'MoteToken')
      && planned.identifier === built.identifier && planned.creationBytecodeHash === built.creationBytecodeHash
      && sameAddress(planned.predictedAddress, proved.address) && proved.creationInputMatches === true
      && proved.runtimeCheck === 'compiler-template-with-immutable-slots-masked'
      && canonicalStringify(planned.constructorArgs.map(address)) === canonicalStringify(args.map(address))
      && tx.contract === planned.contractName && tx.chainId === network.chainId && tx.to === null && tx.value === '0'
      && sameAddress(tx.from, roles.deployer) && typeof tx.data === 'string' && DATA.test(tx.data), 'INVALID_CONFIG', 'Incomplete or conflicting creation evidence');
    const suffixLength = (index ? 3 : 1) * 64;
    const suffix = args.map((value) => address(value).slice(2).padStart(64, '0')).join('');
    check(tx.data.length > suffixLength + 2 && tx.data.slice(-suffixLength).toLowerCase() === suffix
      && keccak256(tx.data.slice(0, -suffixLength)) === built.creationBytecodeHash, 'INVALID_CONFIG', 'Creation bytes or immutable constructor arguments differ from the verified build');
    deployments[key] = { address: address(proved.address), transactionHash: hash(proved.transactionHash), blockNumber: proved.blockNumber,
      blockHash: hash(proved.blockHash), runtimeCodeHash: hash(proved.runtimeCodeHash), creationBytecodeHash: hash(built.creationBytecodeHash),
      creationInputHash: keccak256(tx.data), nonce: tx.nonce };
  }
  const body = { schema: network.configSchema, mode, origin: serviceOrigin, chainId: network.chainId,
    genesisHash: genesisHash === null ? null : hash(genesisHash), checkpoint: structuredClone(evidence.finalized), roles, deployments,
    compiler: structuredClone(plan.compiler), verificationInputHash: plan.verificationInputHash, planHash };
  const config = { ...body, configHash: configFingerprint(body) };
  return validateTestnetChainConfig(config, config.configHash);
}

function parseBlock(value, label, expected) {
  check(value && typeof value === 'object', 'INVALID_RPC_EVIDENCE', `${label} is unavailable`);
  const number = quantity(value.number, `${label} number`); const blockHash = hash(value.hash, `${label} hash`, 'INVALID_RPC_EVIDENCE');
  const timestamp = quantity(value.timestamp, `${label} timestamp`);
  check(Array.isArray(value.transactions) && value.transactions.every((entry) => typeof entry === 'string' && HASH.test(entry)),
    'INVALID_RPC_EVIDENCE', `${label} must include its transaction hash list`);
  check(expected === undefined || number === BigInt(expected), 'SETTLEMENT_REORG', `${label} has a different block number`, 409);
  return { blockNumber: number.toString(), blockHash, blockTimestamp: timestamp.toString(), tag: hex(number), transactions: value.transactions.map((entry) => entry.toLowerCase()) };
}
function compareBlock(a, b) { check(a.blockNumber === b.blockNumber && a.blockHash === b.blockHash && a.blockTimestamp === b.blockTimestamp, 'SETTLEMENT_REORG', 'Canonical block evidence changed during verification', 409); }
function bindLog(log, receipt, block, transactionHash, expected, code) {
  check(log.removed === false && hash(log.transactionHash, 'log tx hash', 'INVALID_RPC_EVIDENCE') === transactionHash
    && hash(log.blockHash, 'log block hash', 'INVALID_RPC_EVIDENCE') === block.blockHash
    && quantity(log.blockNumber, 'log block number') === BigInt(block.blockNumber)
    && quantity(log.transactionIndex, 'log transaction index') === quantity(receipt.transactionIndex, 'receipt transaction index')
    && typeof log.data === 'string' && log.data.toLowerCase() === expected.data.toLowerCase()
    && Array.isArray(log.topics) && log.topics.every((topic) => typeof topic === 'string' && HASH.test(topic))
    && canonicalStringify(log.topics.map((topic) => topic.toLowerCase())) === canonicalStringify(expected.topics.map((topic) => topic.toLowerCase())),
  code, 'Event is not canonically encoded and bound to this transaction and block', 409);
  const index = quantity(log.logIndex, 'log index');
  const indices = receipt.logs.map((entry) => quantity(entry.logIndex, 'receipt log index').toString());
  check(new Set(indices).size === indices.length, code, 'Receipt contains a duplicate numerical log index', 409);
  return index.toString();
}

/** Fixed-origin read-only runtime. A caller-supplied reader exists solely in the
 * explicit local fixture mode, never as a public endpoint override. */
export async function createTestnetChain(options) {
  check(options && typeof options === 'object' && Object.keys(options).every((key) => ['config', 'expectedConfigHash', 'fixtureReader'].includes(key)), 'INVALID_CONFIG', 'Unknown chain-adapter option');
  const config = validateTestnetChainConfig(options.config, options.expectedConfigHash);
  const network = networkFor(config.chainId);
  check(config.mode === 'local-fixture' ? typeof options.fixtureReader?.send === 'function' : options.fixtureReader === undefined,
    'INVALID_PROVIDER', 'Reader injection requires an explicit local fixture configuration');
  const reader = config.mode === 'local-fixture' ? options.fixtureReader
    : network.slug === 'base-sepolia' ? createBaseSepoliaReader() : createEthereumSepoliaReader();
  const rpc = (method, params = []) => reader.send(method, params);
  const identity = freeze({ origin: config.origin, chainId: config.chainId, genesisHash: config.genesisHash,
    token: config.deployments.token.address, router: config.deployments.payments.address, recipient: config.roles.merchant,
    quoteSigner: config.roles.quoteSigner, checkpoint: structuredClone(config.checkpoint), configHash: config.configHash });
  const domain = freeze(quoteDomain(config.chainId, identity.router));
  const chainId = async () => check(quantity(await rpc('eth_chainId'), 'chain ID') === BigInt(config.chainId), 'CHAIN_IDENTITY_MISMATCH', 'RPC chain identity changed', 409);
  const canonical = async (number) => parseBlock(await rpc('eth_getBlockByNumber', [hex(number), false]), 'canonical block', number);
  const finalized = async () => {
    let value; try { value = await rpc('eth_getBlockByNumber', ['finalized', false]); }
    catch { throw new TestnetChainError('FINALITY_UNAVAILABLE', 'Finalized block support is mandatory; block-count fallback is forbidden', 503); }
    check(value, 'FINALITY_UNAVAILABLE', 'No finalized block is available', 503);
    const block = parseBlock(value, 'finalized block'); compareBlock(block, await canonical(block.blockNumber)); return block;
  };
  const anchors = async () => {
    await chainId();
    const anchor = await canonical(config.checkpoint.blockNumber);
    check(anchor.blockHash === config.checkpoint.blockHash, 'CHAIN_IDENTITY_MISMATCH', 'Pinned deployment checkpoint changed or is unavailable', 409);
    // Pruned public endpoints use null and the pinned deployment checkpoint.
    // A non-null genesis hash is never exposed as a verified identity unchecked.
    if (config.genesisHash !== null) {
      const genesis = await canonical('0');
      check(genesis.blockHash === config.genesisHash, 'CHAIN_IDENTITY_MISMATCH', 'Pinned genesis changed', 409);
    }
  };
  const begin = async () => {
    await anchors(); const head = await finalized();
    check(BigInt(head.blockNumber) >= BigInt(config.checkpoint.blockNumber), 'NOT_FINALIZED', 'Finalized head is older than the pinned deployment checkpoint', 202);
    return head;
  };
  const end = async (head) => {
    compareBlock(head, await canonical(head.blockNumber));
    const ending = await finalized();
    check(BigInt(ending.blockNumber) >= BigInt(head.blockNumber), 'SETTLEMENT_REORG', 'Finalized height regressed', 409);
    if (ending.blockNumber === head.blockNumber) compareBlock(head, ending);
    await anchors();
  };
  // ethers Contract receives a read-only runner with no sendTransaction method.
  const at = (tag) => ({ call: ({ to, data }) => rpc('eth_call', [{ to, data }, tag]) });
  const verifyCodeAndConfiguration = async (head) => {
    for (const deployed of Object.values(config.deployments)) {
      const code = await rpc('eth_getCode', [deployed.address, head.tag]);
      check(typeof code === 'string' && DATA.test(code) && code !== '0x' && keccak256(code) === deployed.runtimeCodeHash,
        'CHAIN_IDENTITY_MISMATCH', 'Deployed runtime code differs from the verified deployment fingerprint', 409);
    }
    const token = new Contract(identity.token, TOKEN_ABI, at(head.tag)); const router = new Contract(identity.router, ROUTER_ABI, at(head.tag));
    const [name, symbol, decimals, supply, linkedToken, merchant, signer, onchainDomain] = await Promise.all([
      token.name(), token.symbol(), token.decimals(), token.totalSupply(), router.token(), router.merchant(), router.quoteSigner(), router.eip712Domain(),
    ]);
    check(name === 'Mote' && symbol === 'MOTE' && decimals === 6n && supply === 1_000_000_000_000n
      && sameAddress(linkedToken, identity.token) && sameAddress(merchant, identity.recipient) && sameAddress(signer, identity.quoteSigner)
      && onchainDomain[0] === '0x0f' && onchainDomain[1] === domain.name && onchainDomain[2] === domain.version
      && onchainDomain[3] === BigInt(config.chainId) && sameAddress(onchainDomain[4], identity.router)
      && onchainDomain[5] === ZeroHash && onchainDomain[6].length === 0,
    'CHAIN_IDENTITY_MISMATCH', 'Token metadata, immutable router configuration or EIP-712 domain drifted', 409);
  };
  const mined = async (transactionHash, pendingCode) => {
    const [tx, receipt] = await Promise.all([rpc('eth_getTransactionByHash', [transactionHash]), rpc('eth_getTransactionReceipt', [transactionHash])]);
    check(tx && receipt && tx.blockHash != null && tx.blockNumber != null, pendingCode, 'Transaction has no complete mined receipt yet', 202);
    check(hash(tx.hash, 'tx hash', 'INVALID_RPC_EVIDENCE') === transactionHash && hash(receipt.transactionHash, 'receipt tx hash', 'INVALID_RPC_EVIDENCE') === transactionHash
      && hash(tx.blockHash, 'tx block hash', 'INVALID_RPC_EVIDENCE') === hash(receipt.blockHash, 'receipt block hash', 'INVALID_RPC_EVIDENCE')
      && quantity(tx.blockNumber, 'tx block number') === quantity(receipt.blockNumber, 'receipt block number')
      && quantity(tx.transactionIndex, 'tx index') === quantity(receipt.transactionIndex, 'receipt tx index')
      && sameAddress(tx.from, receipt.from) && (tx.to === null ? receipt.to === null : sameAddress(tx.to, receipt.to)),
    'PAYMENT_MISMATCH', 'Transaction and receipt are not the same mined transaction', 409);
    const block = await canonical(quantity(receipt.blockNumber, 'receipt block number'));
    check(block.blockHash === receipt.blockHash.toLowerCase(), 'SETTLEMENT_REORG', 'Receipt is no longer canonical', 409);
    const index = quantity(receipt.transactionIndex, 'receipt transaction index');
    check(index < BigInt(block.transactions.length) && block.transactions[Number(index)] === transactionHash,
      'PAYMENT_MISMATCH', 'Canonical block does not contain this transaction at its claimed index', 409);
    return { tx, receipt, block };
  };
  const verifyDeployments = async (head) => {
    for (const [key, deployed] of Object.entries(config.deployments)) {
      const { tx, receipt, block } = await mined(deployed.transactionHash, 'DEPLOYMENT_PENDING');
      check(quantity(receipt.status, 'deployment status') === 1n && tx.to === null && sameAddress(tx.from, config.roles.deployer)
        && sameAddress(receipt.contractAddress, deployed.address) && quantity(tx.chainId, 'deployment chain ID') === BigInt(config.chainId)
        && quantity(tx.value, 'deployment value') === 0n && quantity(tx.nonce, 'deployment nonce') === BigInt(deployed.nonce)
        && typeof tx.input === 'string' && DATA.test(tx.input) && keccak256(tx.input) === deployed.creationInputHash
        && block.blockNumber === deployed.blockNumber && block.blockHash === deployed.blockHash
        && BigInt(block.blockNumber) <= BigInt(head.blockNumber), 'CHAIN_IDENTITY_MISMATCH', 'Pinned deployment transaction or finalized receipt changed', 409);
      if (key === 'token') {
        check(Array.isArray(receipt.logs), 'INVALID_RPC_EVIDENCE', 'Creation receipt logs are unavailable');
        const mint = receipt.logs.filter((log) => sameAddress(log.address, identity.token)).map((log) => {
          try { return { log, event: tokenInterface.parseLog(log) }; } catch { return null; }
        }).filter((entry) => entry?.event?.name === 'Transfer' && entry.event.args.from === ZeroAddress);
        check(mint.length === 1 && sameAddress(mint[0].event.args.to, config.roles.initialHolder) && mint[0].event.args.value === 1_000_000_000_000n,
          'CHAIN_IDENTITY_MISMATCH', 'Creation receipt does not show the verified fixed-supply allocation', 409);
        bindLog(mint[0].log, receipt, block, deployed.transactionHash,
          tokenInterface.encodeEventLog(tokenInterface.getEvent('Transfer'), [ZeroAddress, config.roles.initialHolder, 1_000_000_000_000n]), 'CHAIN_IDENTITY_MISMATCH');
      }
    }
  };
  async function verifyIdentity() {
    const head = await begin(); await verifyDeployments(head); await verifyCodeAndConfiguration(head); await end(head); return identity;
  }
  function validateOffer(offer) {
    fields(offer, OFFER_KEYS, 'offer', 'INVALID_OFFER');
    fields(offer.quote, ['quoteId', 'requestHash', 'payer', 'amount', 'deadline'], 'quote', 'INVALID_OFFER');
    fields(offer.domain, ['name', 'version', 'chainId', 'verifyingContract'], 'domain', 'INVALID_OFFER');
    const q = offer.quote;
    hash(q.quoteId, 'quote ID', 'INVALID_OFFER'); hash(q.requestHash, 'request hash', 'INVALID_OFFER'); address(q.payer);
    check(decimal(q.amount, 'amount', 'INVALID_OFFER') > 0n && decimal(q.deadline, 'deadline', 'INVALID_OFFER') > 0n, 'INVALID_OFFER', 'Quote amount and deadline must be positive');
    check(offer.protocol === network.protocol && offer.chainId === config.chainId && offer.decimals === 6 && offer.asset === 'MOTE'
      && offer.service === 'json.audit' && offer.origin === identity.origin && offer.configHash === identity.configHash && offer.finality === 'finalized'
      && offer.testOnly === true && offer.publicSynthetic === true && offer.localOnly === false
      && sameAddress(offer.token, identity.token) && sameAddress(offer.router, identity.router) && sameAddress(offer.recipient, identity.recipient)
      && sameAddress(offer.quoteSigner, identity.quoteSigner) && canonicalStringify({ ...offer.domain, verifyingContract: address(offer.domain.verifyingContract) }) === canonicalStringify(domain)
      && typeof offer.expiresAt === 'string' && Number.isSafeInteger(Date.parse(offer.expiresAt) / 1000)
      && BigInt(Date.parse(offer.expiresAt) / 1000) === BigInt(q.deadline)
      && new Date(Date.parse(offer.expiresAt)).toISOString() === offer.expiresAt
      && Number.isSafeInteger(offer.inputBytes) && offer.inputBytes >= 0 && offer.inputBytes <= 65536,
    'INVALID_OFFER', 'Offer is not bound to this pilot identity and quote');
    hash(offer.resultHash, 'result hash', 'INVALID_OFFER');
    try {
      const { offerSignature, ...body } = offer;
      check(sameAddress(verifyTypedData(domain, QUOTE_TYPES, q, offer.signature), identity.quoteSigner)
        && sameAddress(verifyMessage(canonicalStringify(body), offerSignature), identity.quoteSigner), 'INVALID_OFFER', 'Offer signatures do not match the configured quote signer');
    } catch (error) { if (error instanceof TestnetChainError) throw error; throw new TestnetChainError('INVALID_OFFER', 'Invalid quote or complete-offer signature'); }
    return routerInterface.encodeFunctionData('pay', [q, offer.signature]);
  }
  async function verifyPayment({ offer, transactionHash, finalizedAnchor }) {
    // Snapshot the authenticated envelope before yielding to the reader. A
    // caller cannot mutate the amount or result binding during proof reads.
    try { offer = structuredClone(offer); } catch { throw new TestnetChainError('INVALID_OFFER', 'Offer must be a plain serializable envelope'); }
    if (finalizedAnchor !== undefined) {
      fields(finalizedAnchor, ['blockNumber', 'blockHash'], 'historical finalized anchor', 'INVALID_PROOF');
      finalizedAnchor = { blockNumber: decimal(finalizedAnchor.blockNumber, 'historical finalized block', 'INVALID_PROOF').toString(),
        blockHash: hash(finalizedAnchor.blockHash, 'historical finalized hash', 'INVALID_PROOF') };
    }
    const input = validateOffer(offer); transactionHash = hash(transactionHash, 'payment transaction hash', 'INVALID_PROOF');
    const head = await begin(); await verifyDeployments(head); await verifyCodeAndConfiguration(head);
    const { tx, receipt, block } = await mined(transactionHash, 'PAYMENT_PENDING');
    check(BigInt(block.blockNumber) <= BigInt(head.blockNumber), 'NOT_FINALIZED', 'Payment has not reached the RPC finalized head', 202);
    let historical;
    if (finalizedAnchor !== undefined) {
      check(BigInt(finalizedAnchor.blockNumber) >= BigInt(block.blockNumber) && BigInt(finalizedAnchor.blockNumber) <= BigInt(head.blockNumber),
        'SETTLEMENT_REORG', 'Stored receipt anchor is outside current finalized payment history', 409);
      historical = await canonical(finalizedAnchor.blockNumber);
      check(historical.blockHash === finalizedAnchor.blockHash, 'SETTLEMENT_REORG', 'Stored receipt finalized anchor is no longer canonical; retain the original proof', 409);
    }
    check(quantity(receipt.status, 'payment status') === 1n, 'PAYMENT_REVERTED', 'Payment transaction reverted', 409);
    check(sameAddress(tx.from, offer.quote.payer) && sameAddress(tx.to, identity.router) && receipt.contractAddress === null
      && quantity(tx.chainId, 'payment chain ID') === BigInt(config.chainId) && quantity(tx.value, 'payment native value') === 0n
      && typeof tx.input === 'string' && tx.input.toLowerCase() === input.toLowerCase()
      && BigInt(block.blockTimestamp) <= BigInt(offer.quote.deadline), 'PAYMENT_MISMATCH', 'Payment sender, router, chain, value, exact calldata or mined deadline differs from the quote', 409);
    check(Array.isArray(receipt.logs), 'INVALID_RPC_EVIDENCE', 'Receipt logs are unavailable');
    const paid = receipt.logs.filter((log) => sameAddress(log.address, identity.router) && log.topics?.[0]?.toLowerCase() === routerInterface.getEvent('Paid').topicHash.toLowerCase());
    check(paid.length === 1, 'PAYMENT_MISMATCH', 'Payment requires exactly one router Paid event', 409);
    const log = paid[0]; let event; try { event = routerInterface.parseLog(log); } catch { throw new TestnetChainError('PAYMENT_MISMATCH', 'Malformed Paid event', 409); }
    const expectedLog = routerInterface.encodeEventLog(routerInterface.getEvent('Paid'), [offer.quote.quoteId, offer.quote.requestHash, offer.quote.payer, offer.quote.amount]);
    check(event.args.quoteId.toLowerCase() === offer.quote.quoteId.toLowerCase() && event.args.requestHash.toLowerCase() === offer.quote.requestHash.toLowerCase()
      && sameAddress(event.args.payer, offer.quote.payer) && event.args.amount === BigInt(offer.quote.amount),
    'PAYMENT_MISMATCH', 'Paid event is not bound to this transaction, block and exact quote', 409);
    const logIndex = bindLog(log, receipt, block, transactionHash, expectedLog, 'PAYMENT_MISMATCH');
    const router = new Contract(identity.router, ROUTER_ABI, at(head.tag));
    check(await router.consumed(offer.quote.quoteId) === true, 'PAYMENT_MISMATCH', 'Finalized router state does not consume the paid quote', 409);
    compareBlock(block, await canonical(block.blockNumber));
    if (historical) compareBlock(historical, await canonical(historical.blockNumber));
    await end(head);
    return freeze({ transactionHash, transactionNonce: quantity(tx.nonce, 'payment nonce').toString(), blockNumber: block.blockNumber,
      blockHash: block.blockHash, transactionIndex: quantity(receipt.transactionIndex, 'receipt transaction index').toString(), logIndex,
      blockTimestamp: block.blockTimestamp, payer: address(offer.quote.payer), amount: offer.quote.amount, quoteId: offer.quote.quoteId.toLowerCase(),
      requestHash: offer.quote.requestHash.toLowerCase(), token: identity.token, router: identity.router, recipient: identity.recipient,
      finalized: { blockNumber: head.blockNumber, blockHash: head.blockHash }, configHash: config.configHash });
  }
  await verifyIdentity();
  return Object.freeze({ identity, config, quoteDomain: domain, verifyIdentity, verifyPayment });
}
