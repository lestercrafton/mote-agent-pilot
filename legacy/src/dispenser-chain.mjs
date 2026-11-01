import { AbiCoder, Interface, Transaction, ZeroAddress, ZeroHash, getAddress, getCreateAddress, keccak256 } from 'ethers';
import artifactJson from '../artifacts/MoteTestDispenser.json' with { type: 'json' };
import { canonicalStringify, hashJson } from './json.mjs';
import { createTestnetChain, validateTestnetChainConfig } from './testnet-chain.mjs';
import { createEthereumSepoliaReader } from './testnet-rpc.mjs';
import { ETHEREUM_SEPOLIA } from './testnet-networks.mjs';

// Runtime imports only committed public artifacts and read-only adapters. No
// compiler, signer, wallet, credential, local EVM or broadcast implementation.
const artifact = structuredClone(artifactJson);
const dispenserAbi = new Interface(artifact.abi);
const tokenAbi = new Interface(['function balanceOf(address) view returns(uint256)', 'function transfer(address,uint256) returns(bool)', 'event Transfer(address indexed from,address indexed to,uint256 value)']);
const HASH = /^0x[0-9a-fA-F]{64}$/, DATA = /^0x(?:[0-9a-fA-F]{2})*$/;
const ALLOWED_RPC = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call', 'eth_getTransactionByHash', 'eth_getTransactionReceipt']);
const PLAN_KEYS = ['schema', 'chainId', 'genesisHash', 'status', 'publicDeployment', 'authorization', 'broadcastReady', 'tokenEvidenceVerified', 'feesIncluded', 'token', 'expectedTokenRuntimeHash', 'deployer', 'contract', 'transactions', 'limits', 'notices', 'planHash'];
const CONFIG_KEYS = ['schema', 'mode', 'origin', 'chainId', 'genesisHash', 'baseConfigHash', 'plan', 'deployment', 'funding', 'checkpoint', 'runtimeCodeHash', 'configHash'];
const EVIDENCE_KEYS = ['schema', 'chainId', 'genesisHash', 'baseConfigHash', 'planHash', 'deployment', 'funding', 'finalized', 'runtimeCodeHash', 'verificationScope', 'publicNetworkAuthenticityVerified', 'broadcastAuthorization', 'feeBudgetVerified'];
const equal = (a, b) => canonicalStringify(a) === canonicalStringify(b);
const hex = value => `0x${BigInt(value).toString(16)}`;

export class DispenserChainError extends Error {
  constructor(code, message, status = 409) { super(message); this.name = 'DispenserChainError'; this.code = code; this.status = status; this.doNotRepay = true; this.doNotReleaseReservation = true; }
}
function check(value, code, message, status) { if (!value) throw new DispenserChainError(code, message, status); }
function fields(value, names, label) {
  check(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name)), 'INVALID_DISPENSER_CONFIG', `${label} has unsupported or missing fields`, 400);
}
function address(value) { try { const parsed = getAddress(value); if (parsed !== ZeroAddress) return parsed.toLowerCase(); } catch {} throw new DispenserChainError('INVALID_DISPENSER_CONFIG', 'A nonzero public EVM address is required', 400); }
function sameAddress(a, b) { try { return address(a) === address(b); } catch { return false; } }
function hash(value) { check(typeof value === 'string' && HASH.test(value) && value.toLowerCase() !== ZeroHash, 'INVALID_DISPENSER_CONFIG', 'A nonzero hash is required', 400); return value.toLowerCase(); }
function decimal(value, maximum = (1n << 256n) - 1n) { check(typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) <= maximum, 'INVALID_DISPENSER_CONFIG', 'A canonical bounded decimal string is required', 400); return BigInt(value); }
function quantity(value) { check(typeof value === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value), 'INVALID_RPC_EVIDENCE', 'RPC integer is malformed'); return BigInt(value); }
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function anchor(value) { fields(value, ['blockNumber', 'blockHash'], 'Anchor'); decimal(value.blockNumber); return { blockNumber: value.blockNumber, blockHash: hash(value.blockHash) }; }
function deployment(value) { fields(value, ['transactionHash', 'blockNumber', 'blockHash'], 'Deployment evidence'); decimal(value.blockNumber); return { transactionHash: hash(value.transactionHash), blockNumber: value.blockNumber, blockHash: hash(value.blockHash) }; }
function planFingerprint(value) { const { planHash, ...body } = value; return hashJson(body); }
function configFingerprint(value) { const { configHash, ...body } = value; return hashJson(body); }

/** Pure runtime plan validation against the bundled exact compiler artifact. */
function validatePlan(raw, baseConfig) {
  fields(raw, PLAN_KEYS, 'Unsigned dispenser plan');
  const plan = structuredClone(raw), c = plan.contract;
  fields(c, ['name', 'predictedAddress', 'constructorArgs', 'claimAmount', 'distributionCap', 'maxClaims', 'compiler', 'creationBytecodeHash', 'runtimeTemplateHash', 'abiHash'], 'Dispenser contract plan');
  fields(plan.limits, ['supplyMinted', 'claimsPerAddress', 'callerPaysNativeGas', 'sybilResistance', 'withdrawExcess'], 'Dispenser limits');
  check(plan.schema === 'mote-ethereum-sepolia-dispenser-plan-v1' && plan.chainId === 11155111 && plan.genesisHash === ETHEREUM_SEPOLIA.genesisHash && plan.status === 'unsigned-preparation' && ['publicDeployment', 'authorization', 'broadcastReady', 'tokenEvidenceVerified', 'feesIncluded'].every(key => plan[key] === false), 'INVALID_DISPENSER_PLAN', 'Only the exact unsigned Ethereum Sepolia add-on plan is supported', 400);
  check(sameAddress(plan.token, baseConfig.deployments.token.address) && hash(plan.expectedTokenRuntimeHash) === baseConfig.deployments.token.runtimeCodeHash, 'DISPENSER_IDENTITY_MISMATCH', 'Dispenser token differs from the verified original deployment');
  const deployer = address(plan.deployer), token = address(plan.token), claim = decimal(c.claimAmount, 10_000_000n), cap = decimal(c.distributionCap, 10_000_000_000n);
  check(claim > 0n && cap >= claim && cap % claim === 0n && c.maxClaims === (cap / claim).toString(), 'INVALID_DISPENSER_PLAN', 'Claim and lifetime cap are inconsistent', 400);
  check(Array.isArray(plan.transactions) && plan.transactions.length === 2, 'INVALID_DISPENSER_PLAN', 'Exactly deployment and reserve funding are required', 400);
  const nonce = decimal(plan.transactions[0]?.nonce, BigInt(Number.MAX_SAFE_INTEGER - 1));
  const predicted = getCreateAddress({ from: deployer, nonce });
  const args = [getAddress(token), claim.toString(), cap.toString()];
  const creation = artifact.bytecode + AbiCoder.defaultAbiCoder().encode(['address', 'uint256', 'uint256'], args).slice(2);
  const transactions = [
    { purpose: 'deploy-dispenser', chainId: 11155111, from: getAddress(deployer), nonce: nonce.toString(), to: null, value: '0', data: creation },
    { purpose: 'fund-exact-reserve', chainId: 11155111, from: getAddress(deployer), nonce: (nonce + 1n).toString(), to: getAddress(token), value: '0', data: tokenAbi.encodeFunctionData('transfer', [predicted, cap]) },
  ];
  check(equal(plan.transactions, transactions) && c.name === artifact.contractName && c.predictedAddress === predicted && equal(c.constructorArgs, args) && c.compiler === artifact.compiler && c.creationBytecodeHash === keccak256(artifact.bytecode) && c.runtimeTemplateHash === keccak256(artifact.deployedBytecode) && c.abiHash === hashJson(artifact.abi), 'INVALID_DISPENSER_PLAN', 'Exact bytecode, role, nonce, calldata or constructor binding differs', 400);
  check(equal(plan.limits, { supplyMinted: '0', claimsPerAddress: 1, callerPaysNativeGas: true, sybilResistance: false, withdrawExcess: false }) && Array.isArray(plan.notices) && plan.notices.length <= 16 && plan.notices.every(text => typeof text === 'string' && text.length <= 1024) && hash(plan.planHash) === planFingerprint(plan), 'INVALID_DISPENSER_PLAN', 'Unsigned plan fingerprint or limits changed', 400);
  return freeze(plan);
}

function expectedRuntime(plan) {
  const runtime = Buffer.from(artifact.deployedBytecode.slice(2), 'hex');
  const names = Object.values(artifact.immutableNames ?? {}).sort();
  check(equal(names, ['claimAmount', 'distributionCap', 'token']) && equal(Object.keys(artifact.immutableReferences).sort(), Object.keys(artifact.immutableNames).sort()), 'INVALID_DISPENSER_BUILD', 'Compiler immutable names are incomplete');
  const values = { token: BigInt(address(plan.token)), claimAmount: BigInt(plan.contract.claimAmount), distributionCap: BigInt(plan.contract.distributionCap) }, occupied = new Set();
  for (const [id, positions] of Object.entries(artifact.immutableReferences)) {
    check(Array.isArray(positions) && positions.length > 0, 'INVALID_DISPENSER_BUILD', 'Missing immutable compiler positions');
    for (const { start, length } of positions) {
      check(Number.isSafeInteger(start) && length === 32 && start >= 0 && start + length <= runtime.length, 'INVALID_DISPENSER_BUILD', 'Invalid immutable compiler position');
      for (let offset = start; offset < start + length; offset++) { check(!occupied.has(offset) && runtime[offset] === 0, 'INVALID_DISPENSER_BUILD', 'Immutable compiler slots overlap or are not placeholders'); occupied.add(offset); }
      Buffer.from(values[artifact.immutableNames[id]].toString(16).padStart(64, '0'), 'hex').copy(runtime, start);
    }
  }
  return `0x${runtime.toString('hex')}`;
}

export function createDispenserConfig({ baseConfig, plan, evidence }) {
  const base = validateTestnetChainConfig(baseConfig, baseConfig?.configHash);
  check(base.chainId === 11155111, 'INVALID_DISPENSER_CONFIG', 'Dispenser supports only Ethereum Sepolia', 400);
  plan = validatePlan(plan, base); fields(evidence, EVIDENCE_KEYS, 'Dispenser verification evidence');
  check(evidence.schema === 'mote-dispenser-deployment-evidence-v1' && evidence.chainId === 11155111 && evidence.genesisHash === base.genesisHash && evidence.baseConfigHash === base.configHash && evidence.planHash === plan.planHash && evidence.verificationScope === 'dispenser-deployment-and-funding-only' && evidence.publicNetworkAuthenticityVerified === false && evidence.broadcastAuthorization === false && evidence.feeBudgetVerified === false, 'INVALID_DISPENSER_CONFIG', 'Deployment evidence claims or identities differ', 400);
  const body = { schema: 'mote-ethereum-sepolia-dispenser-config-v1', mode: base.mode, origin: base.origin, chainId: 11155111, genesisHash: base.genesisHash, baseConfigHash: base.configHash, plan, deployment: deployment(evidence.deployment), funding: deployment(evidence.funding), checkpoint: anchor(evidence.finalized), runtimeCodeHash: hash(evidence.runtimeCodeHash) };
  return validateDispenserConfig({ ...body, configHash: configFingerprint(body) }, configFingerprint(body), base);
}

export function validateDispenserConfig(raw, expectedConfigHash, baseConfig) {
  fields(raw, CONFIG_KEYS, 'Dispenser configuration'); const base = validateTestnetChainConfig(baseConfig, baseConfig?.configHash);
  check(base.chainId === 11155111 && raw.schema === 'mote-ethereum-sepolia-dispenser-config-v1' && raw.chainId === 11155111 && raw.mode === base.mode && raw.origin === base.origin && raw.genesisHash === base.genesisHash && raw.baseConfigHash === base.configHash, 'DISPENSER_IDENTITY_MISMATCH', 'Dispenser configuration differs from the original deployment identity');
  const plan = validatePlan(raw.plan, base);
  check(equal(deployment(raw.deployment), raw.deployment) && equal(deployment(raw.funding), raw.funding) && equal(anchor(raw.checkpoint), raw.checkpoint), 'INVALID_DISPENSER_CONFIG', 'Persisted dispenser hashes must use canonical lowercase encoding', 400);
  check(BigInt(raw.deployment.blockNumber) > 0n && BigInt(raw.deployment.blockNumber) <= BigInt(raw.funding.blockNumber) && BigInt(raw.funding.blockNumber) <= BigInt(raw.checkpoint.blockNumber) && BigInt(base.checkpoint.blockNumber) <= BigInt(raw.checkpoint.blockNumber) && raw.deployment.transactionHash !== raw.funding.transactionHash && raw.runtimeCodeHash === keccak256(expectedRuntime(plan)), 'INVALID_DISPENSER_CONFIG', 'Deployment chronology or exact immutable runtime is inconsistent', 400);
  check(hash(raw.configHash) === configFingerprint(raw) && raw.configHash === hash(expectedConfigHash), 'DISPENSER_CONFIG_HASH_MISMATCH', 'Configuration differs from its independently pinned fingerprint');
  return freeze(structuredClone(raw));
}

function parseBlock(raw, expected) {
  check(raw && typeof raw === 'object', 'FINALITY_UNAVAILABLE', 'Canonical block is unavailable', 503);
  const number = quantity(raw.number).toString(), blockHash = hash(raw.hash), timestamp = quantity(raw.timestamp).toString();
  check((expected === undefined || number === BigInt(expected).toString()) && Array.isArray(raw.transactions) && raw.transactions.every(value => HASH.test(value)), 'SETTLEMENT_REORG', 'Canonical block number or transaction list is inconsistent');
  return { blockNumber: number, blockHash, blockTimestamp: timestamp, transactions: raw.transactions.map(value => value.toLowerCase()) };
}
function compareBlock(a, b) { check(a.blockNumber === b.blockNumber && a.blockHash === b.blockHash && a.blockTimestamp === b.blockTimestamp, 'SETTLEMENT_REORG', 'Canonical history changed during dispenser verification'); }
function blockAnchor(block) { return { blockNumber: block.blockNumber, blockHash: block.blockHash }; }
function scalar(raw) { check(typeof raw === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(raw) && BigInt(raw) > 0n, 'DISPENSER_TRANSACTION_MISMATCH', 'ECDSA scalar is invalid'); return '0x' + BigInt(raw).toString(16).padStart(64, '0'); }
function signedTransaction(tx, expected, transactionHash) {
  check(tx && quantity(tx.type) === 2n && quantity(tx.chainId) === 11155111n && quantity(tx.value) === 0n && Array.isArray(tx.accessList) && tx.accessList.length === 0 && ['authorizationList', 'blobVersionedHashes', 'blobs', 'maxFeePerBlobGas'].every(key => !Object.hasOwn(tx, key)), 'DISPENSER_TRANSACTION_MISMATCH', 'Only exact ordinary zero-value type-2 transactions are supported');
  const nonce = quantity(tx.nonce), gas = quantity(tx.gas), maximum = quantity(tx.maxFeePerGas), priority = quantity(tx.maxPriorityFeePerGas);
  check(nonce <= BigInt(Number.MAX_SAFE_INTEGER) && gas > 0n && maximum > 0n && priority <= maximum && sameAddress(tx.from, expected.from) && (expected.to === null ? tx.to === null : sameAddress(tx.to, expected.to)) && typeof tx.input === 'string' && DATA.test(tx.input) && tx.input.toLowerCase() === expected.data.toLowerCase() && (expected.nonce === undefined || nonce === BigInt(expected.nonce)), 'DISPENSER_TRANSACTION_MISMATCH', 'Sender, recipient, calldata, nonce or fee envelope differs from the pinned transaction');
  try {
    const parity = quantity(tx.yParity ?? tx.v); check(parity <= 1n && (tx.v === undefined || quantity(tx.v) === parity), 'DISPENSER_TRANSACTION_MISMATCH', 'Typed signature parity differs');
    const recovered = Transaction.from({ type: 2, chainId: 11155111, nonce: Number(nonce), to: tx.to, value: 0n, data: tx.input, gasLimit: gas, maxFeePerGas: maximum, maxPriorityFeePerGas: priority, accessList: [], signature: { r: scalar(tx.r), s: scalar(tx.s), yParity: Number(parity) } });
    check(recovered.hash === transactionHash && sameAddress(recovered.from, expected.from), 'DISPENSER_TRANSACTION_MISMATCH', 'Signed transaction hash or recovered sender differs');
  } catch (error) { if (error instanceof DispenserChainError) throw error; throw new DispenserChainError('DISPENSER_TRANSACTION_MISMATCH', 'Transaction signature is malformed'); }
  return nonce.toString();
}

async function context({ baseConfig, expectedBaseConfigHash, fixtureReader }) {
  const base = validateTestnetChainConfig(baseConfig, expectedBaseConfigHash);
  check(base.chainId === 11155111, 'INVALID_DISPENSER_CONFIG', 'Only Ethereum Sepolia is supported', 400);
  if (base.mode === 'local-fixture') {
    let url; try { url = new URL(fixtureReader?.endpoint); } catch {}
    check(fixtureReader?.readOnly === true && typeof fixtureReader.send === 'function' && url?.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'INVALID_DISPENSER_PROVIDER', 'Explicit fixture reader must use literal loopback HTTP', 400);
  } else check(fixtureReader === undefined && base.mode === 'ethereum-sepolia' && base.genesisHash === ETHEREUM_SEPOLIA.genesisHash, 'INVALID_DISPENSER_PROVIDER', 'Public dispenser verification uses only the fixed Ethereum Sepolia RPC and genesis', 400);
  const reader = fixtureReader ?? createEthereumSepoliaReader();
  const rpc = (method, params = []) => { check(ALLOWED_RPC.has(method), 'READ_ONLY_REQUIRED', 'Unsupported dispenser RPC method'); return reader.send(method, params); };
  const baseChain = await createTestnetChain({ config: base, expectedConfigHash: expectedBaseConfigHash, ...(fixtureReader ? { fixtureReader: { send: rpc } } : {}) });
  const canonical = async number => parseBlock(await rpc('eth_getBlockByNumber', [hex(number), false]), number);
  const finalized = async () => { const result = parseBlock(await rpc('eth_getBlockByNumber', ['finalized', false])); compareBlock(result, await canonical(result.blockNumber)); return result; };
  const begin = async () => { await baseChain.verifyIdentity(); const head = await finalized(); check(quantity(await rpc('eth_chainId')) === 11155111n && (await canonical(0)).blockHash === base.genesisHash, 'DISPENSER_IDENTITY_MISMATCH', 'Ethereum Sepolia chain identity changed'); return head; };
  const finish = async (head, blocks = []) => {
    for (const block of [...blocks, head]) compareBlock(block, await canonical(block.blockNumber));
    const end = await finalized(); check(BigInt(end.blockNumber) >= BigInt(head.blockNumber) && BigInt(end.blockTimestamp) >= BigInt(head.blockTimestamp), 'SETTLEMENT_REORG', 'Finalized history regressed');
    if (end.blockNumber === head.blockNumber) compareBlock(end, head);
    check(quantity(await rpc('eth_chainId')) === 11155111n && (await canonical(0)).blockHash === base.genesisHash, 'DISPENSER_IDENTITY_MISMATCH', 'Chain identity changed during dispenser verification');
  };
  const call = async (to, abi, method, args, block) => abi.decodeFunctionResult(method, await rpc('eth_call', [{ to, data: abi.encodeFunctionData(method, args) }, hex(block.blockNumber)]))[0];
  const mined = async (transactionHash, expected, head, pendingCode = 'DISPENSER_DEPLOYMENT_PENDING') => {
    const [tx, receipt] = await Promise.all([rpc('eth_getTransactionByHash', [transactionHash]), rpc('eth_getTransactionReceipt', [transactionHash])]);
    check(tx && receipt && tx.blockHash != null && tx.blockNumber != null, pendingCode, 'Original transaction is not fully mined; do not resend', 202);
    const nonce = signedTransaction(tx, expected, transactionHash);
    check(hash(tx.hash) === transactionHash && hash(receipt.transactionHash) === transactionHash && hash(tx.blockHash) === hash(receipt.blockHash) && quantity(tx.blockNumber) === quantity(receipt.blockNumber) && quantity(tx.transactionIndex) === quantity(receipt.transactionIndex) && sameAddress(receipt.from, tx.from) && (tx.to === null ? receipt.to === null : sameAddress(receipt.to, tx.to)) && quantity(receipt.type) === 2n, 'DISPENSER_TRANSACTION_MISMATCH', 'Transaction and receipt binding differs');
    const block = await canonical(quantity(receipt.blockNumber));
    check(block.blockHash === receipt.blockHash.toLowerCase(), 'SETTLEMENT_REORG', 'Transaction receipt is no longer canonical');
    check(BigInt(block.blockNumber) <= BigInt(head.blockNumber), 'NOT_FINALIZED', 'Original transaction is not finalized; retain reservation', 202);
    check(BigInt(block.blockTimestamp) <= BigInt(head.blockTimestamp) && (block.blockNumber !== head.blockNumber || block.blockHash === head.blockHash), 'SETTLEMENT_REORG', 'Transaction block contradicts finalized history');
    const index = quantity(receipt.transactionIndex);
    check(index < BigInt(block.transactions.length) && block.transactions[Number(index)] === transactionHash && Array.isArray(receipt.logs), 'DISPENSER_TRANSACTION_MISMATCH', 'Canonical transaction index or logs differ');
    const indices = receipt.logs.map(log => quantity(log.logIndex).toString()); check(new Set(indices).size === indices.length, 'DISPENSER_TRANSACTION_MISMATCH', 'Duplicate numerical log indices');
    return { tx, receipt, block, nonce, index: index.toString() };
  };
  function event(proof, emitter, abi, name, values) {
    const expected = abi.encodeEventLog(abi.getEvent(name), values);
    const logs = proof.receipt.logs.filter(log => sameAddress(log.address, emitter) && log.topics?.[0]?.toLowerCase() === expected.topics[0].toLowerCase());
    check(logs.length === 1, 'DISPENSER_EVENT_MISMATCH', 'Exactly one bound event is required'); const log = logs[0];
    check(log.removed === false && hash(log.transactionHash) === proof.tx.hash.toLowerCase() && hash(log.blockHash) === proof.block.blockHash && quantity(log.blockNumber) === BigInt(proof.block.blockNumber) && quantity(log.transactionIndex) === BigInt(proof.index) && typeof log.data === 'string' && log.data.toLowerCase() === expected.data.toLowerCase() && Array.isArray(log.topics) && equal(log.topics.map(topic => hash(topic)), expected.topics.map(topic => topic.toLowerCase())), 'DISPENSER_EVENT_MISMATCH', 'Event encoding, sender or canonical receipt binding differs');
    return quantity(log.logIndex).toString();
  }
  return { base, baseChain, rpc, begin, finish, canonical, call, mined, event };
}

async function verifyDeployment(ctx, plan, hashes, head) {
  const address_ = address(plan.contract.predictedAddress), runtime = expectedRuntime(plan);
  const created = await ctx.mined(hash(hashes.deployment), plan.transactions[0], head), funded = await ctx.mined(hash(hashes.funding), plan.transactions[1], head);
  check(created.tx.hash !== funded.tx.hash && quantity(created.receipt.status) === 1n && quantity(funded.receipt.status) === 1n && sameAddress(created.receipt.contractAddress, address_) && funded.receipt.contractAddress === null && BigInt(created.block.blockNumber) <= BigInt(funded.block.blockNumber) && (created.block.blockNumber !== funded.block.blockNumber || BigInt(created.index) < BigInt(funded.index)), 'DISPENSER_DEPLOYMENT_MISMATCH', 'Successful ordered exact deployment and funding receipts are required');
  for (const block of [created.block, funded.block, head]) {
    const [code, tokenCode] = await Promise.all([ctx.rpc('eth_getCode', [address_, hex(block.blockNumber)]), ctx.rpc('eth_getCode', [plan.token, hex(block.blockNumber)])]);
    check(code === runtime && typeof tokenCode === 'string' && DATA.test(tokenCode) && keccak256(tokenCode) === plan.expectedTokenRuntimeHash, 'DISPENSER_IDENTITY_MISMATCH', 'Full compiler runtime, immutable slots or original token runtime differs');
  }
  const [token, amount, cap, maxAmount, maxCap] = await Promise.all(['token', 'claimAmount', 'distributionCap', 'MAX_CLAIM_AMOUNT', 'MAX_DISTRIBUTION_CAP'].map(name => ctx.call(address_, dispenserAbi, name, [], head)));
  check(sameAddress(token, plan.token) && amount === BigInt(plan.contract.claimAmount) && cap === BigInt(plan.contract.distributionCap) && maxAmount === 10_000_000n && maxCap === 10_000_000_000n, 'DISPENSER_IDENTITY_MISMATCH', 'Dispenser immutable getters differ from exact constructor');
  ctx.event(funded, plan.token, tokenAbi, 'Transfer', [plan.deployer, address_, cap]);
  const [balance, distributed] = await Promise.all([ctx.call(plan.token, tokenAbi, 'balanceOf', [address_], funded.block), ctx.call(address_, dispenserAbi, 'distributed', [], funded.block)]);
  check(distributed <= cap && distributed % amount === 0n && balance + distributed >= cap, 'DISPENSER_FUNDING_MISMATCH', 'Finalized funding does not cover the immutable distribution reserve');
  return { created, funded, runtimeCodeHash: keccak256(runtime) };
}

export async function verifyDispenserDeployment(options) {
  fields(options, ['baseConfig', 'expectedBaseConfigHash', 'plan', 'transactionHashes', ...(Object.hasOwn(options, 'fixtureReader') ? ['fixtureReader'] : [])], 'Deployment verifier options');
  const input = { ...options, baseConfig: structuredClone(options.baseConfig), plan: structuredClone(options.plan), transactionHashes: structuredClone(options.transactionHashes) };
  fields(input.transactionHashes, ['deployment', 'funding'], 'Transaction hashes');
  const ctx = await context(input), plan = validatePlan(input.plan, ctx.base), head = await ctx.begin();
  const proved = await verifyDeployment(ctx, plan, input.transactionHashes, head);
  await ctx.finish(head, [proved.created.block, proved.funded.block]);
  return freeze({ schema: 'mote-dispenser-deployment-evidence-v1', chainId: 11155111, genesisHash: ctx.base.genesisHash, baseConfigHash: ctx.base.configHash, planHash: plan.planHash, deployment: { transactionHash: hash(input.transactionHashes.deployment), ...blockAnchor(proved.created.block) }, funding: { transactionHash: hash(input.transactionHashes.funding), ...blockAnchor(proved.funded.block) }, finalized: blockAnchor(head), runtimeCodeHash: proved.runtimeCodeHash, verificationScope: 'dispenser-deployment-and-funding-only', publicNetworkAuthenticityVerified: false, broadcastAuthorization: false, feeBudgetVerified: false });
}

export async function createDispenserChain(options) {
  fields(options, ['config', 'expectedConfigHash', 'baseConfig', 'expectedBaseConfigHash', ...(Object.hasOwn(options, 'fixtureReader') ? ['fixtureReader'] : [])], 'Dispenser adapter options');
  const base = validateTestnetChainConfig(options.baseConfig, options.expectedBaseConfigHash), config = validateDispenserConfig(options.config, options.expectedConfigHash, base), ctx = await context({ ...options, baseConfig: base });
  const plan = config.plan, dispenser = address(plan.contract.predictedAddress);
  const identity = freeze({ schema: 'mote-dispenser-identity-v1', mode: config.mode, origin: config.origin, chainId: 11155111, genesisHash: config.genesisHash, baseConfigHash: base.configHash, dispenserConfigHash: config.configHash, token: base.deployments.token.address, router: base.deployments.payments.address, recipient: base.roles.merchant, quoteSigner: base.roles.quoteSigner, dispenser, claimAmount: plan.contract.claimAmount, distributionCap: plan.contract.distributionCap, maxClaims: plan.contract.maxClaims, claimsPerAddress: 1, testOnly: true, sybilResistance: false, deployment: structuredClone(config.deployment), funding: structuredClone(config.funding), checkpoint: structuredClone(config.checkpoint), runtimeCodeHash: config.runtimeCodeHash });
  const verified = async () => {
    const head = await ctx.begin(), checkpoint = await ctx.canonical(config.checkpoint.blockNumber);
    check(checkpoint.blockHash === config.checkpoint.blockHash && BigInt(head.blockNumber) >= BigInt(checkpoint.blockNumber), 'SETTLEMENT_REORG', 'Pinned dispenser checkpoint changed or is no longer finalized');
    const proof = await verifyDeployment(ctx, plan, { deployment: config.deployment.transactionHash, funding: config.funding.transactionHash }, head);
    check(equal(blockAnchor(proof.created.block), { blockNumber: config.deployment.blockNumber, blockHash: config.deployment.blockHash }) && equal(blockAnchor(proof.funded.block), { blockNumber: config.funding.blockNumber, blockHash: config.funding.blockHash }) && proof.runtimeCodeHash === config.runtimeCodeHash, 'SETTLEMENT_REORG', 'Pinned dispenser deployment or funding changed');
    return { head, blocks: [proof.created.block, proof.funded.block, checkpoint] };
  };
  async function verifyIdentity() { const { head, blocks } = await verified(); await ctx.finish(head, blocks); return identity; }
  async function inspectClaim(input) {
    fields(input, ['payer'], 'Claim inspection'); const payer = address(input.payer), { head, blocks } = await verified();
    const [claimed, distributed, balance] = await Promise.all([ctx.call(dispenser, dispenserAbi, 'claimed', [payer], head), ctx.call(dispenser, dispenserAbi, 'distributed', [], head), ctx.call(identity.token, tokenAbi, 'balanceOf', [dispenser], head)]);
    const cap = BigInt(identity.distributionCap), amount = BigInt(identity.claimAmount);
    check(distributed <= cap && distributed % amount === 0n, 'DISPENSER_IDENTITY_MISMATCH', 'Distribution accounting is invalid');
    const reason = claimed ? 'already_claimed' : distributed === cap ? 'cap_exhausted' : balance < amount ? 'insufficient_funding' : null;
    await ctx.finish(head, blocks);
    return freeze({ payer, claimed, distributed: distributed.toString(), remainingDistribution: (cap - distributed).toString(), dispenserBalance: balance.toString(), claimAmount: identity.claimAmount, eligible: reason === null, reason, finalized: blockAnchor(head), dispenserConfigHash: identity.dispenserConfigHash });
  }
  async function verifyClaim(input) {
    fields(input, ['payer', 'transactionHash', ...(Object.hasOwn(input, 'finalizedAnchor') ? ['finalizedAnchor'] : [])], 'Claim proof');
    const payer = address(input.payer), transactionHash = hash(input.transactionHash), historical = input.finalizedAnchor === undefined ? null : anchor(input.finalizedAnchor);
    const { head, blocks } = await verified();
    const proof = await ctx.mined(transactionHash, { from: payer, to: dispenser, data: dispenserAbi.encodeFunctionData('claim') }, head, 'CLAIM_PENDING');
    check(quantity(proof.receipt.status) === 1n && proof.receipt.contractAddress === null, 'CLAIM_REVERTED', 'Original claim reverted; only finalized fee accounting may release its gas reservation');
    const logs = proof.receipt.logs.filter(log => sameAddress(log.address, dispenser) && log.topics?.[0]?.toLowerCase() === dispenserAbi.getEvent('Claimed').topicHash.toLowerCase());
    check(logs.length === 1, 'DISPENSER_EVENT_MISMATCH', 'Exactly one Claimed event is required');
    let parsed; try { parsed = dispenserAbi.parseLog(logs[0]); } catch { throw new DispenserChainError('DISPENSER_EVENT_MISMATCH', 'Malformed Claimed event'); }
    const total = parsed.args.totalDistributed, amount = BigInt(identity.claimAmount);
    check(total >= amount && total <= BigInt(identity.distributionCap) && total % amount === 0n, 'DISPENSER_EVENT_MISMATCH', 'Claimed event exceeds the fixed distribution cap');
    const logIndex = ctx.event(proof, dispenser, dispenserAbi, 'Claimed', [payer, amount, total]);
    ctx.event(proof, identity.token, tokenAbi, 'Transfer', [dispenser, payer, amount]);
    const [claimed, distributed] = await Promise.all([ctx.call(dispenser, dispenserAbi, 'claimed', [payer], proof.block), ctx.call(dispenser, dispenserAbi, 'distributed', [], proof.block)]);
    check(claimed === true && distributed >= total && distributed <= BigInt(identity.distributionCap), 'CLAIM_MISMATCH', 'Canonical claim state disagrees with the event');
    if (historical) { check(BigInt(historical.blockNumber) >= BigInt(proof.block.blockNumber) && BigInt(historical.blockNumber) <= BigInt(head.blockNumber), 'SETTLEMENT_REORG', 'Historical receipt anchor is outside finalized claim history'); const prior = await ctx.canonical(historical.blockNumber); check(prior.blockHash === historical.blockHash, 'SETTLEMENT_REORG', 'Historical claim receipt anchor changed'); blocks.push(prior); }
    await ctx.finish(head, [...blocks, proof.block]);
    return freeze({ transactionHash, transactionNonce: proof.nonce, blockNumber: proof.block.blockNumber, blockHash: proof.block.blockHash, blockTimestamp: proof.block.blockTimestamp, transactionIndex: proof.index, logIndex, payer, amount: identity.claimAmount, totalDistributed: total.toString(), token: identity.token, dispenser, baseConfigHash: identity.baseConfigHash, dispenserConfigHash: identity.dispenserConfigHash, finalized: blockAnchor(head), success: true });
  }
  await verifyIdentity();
  return Object.freeze({ identity, verifyIdentity, inspectClaim, verifyClaim });
}
