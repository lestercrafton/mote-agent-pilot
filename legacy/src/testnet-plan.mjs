import { AbiCoder, Interface, ZeroAddress, ZeroHash, getAddress, getCreateAddress, keccak256 } from 'ethers';
import { compileContracts } from '../scripts/compile.mjs';
import { canonicalStringify, hashJson } from './json.mjs';
import { createVerificationBundle } from './verification-bundle.mjs';
import { getTestnetNetwork } from './testnet-networks.mjs';

export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const ETHEREUM_SEPOLIA_CHAIN_ID = 11155111;
const CONFIG_FIELDS = ['chainId', 'deployer', 'initialHolder', 'merchant', 'quoteSigner', 'nonce'];
const ROLE_FIELDS = ['deployer', 'initialHolder', 'merchant', 'quoteSigner'];
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_DATA = /^0x(?:[0-9a-fA-F]{2})*$/;
const abi = AbiCoder.defaultAbiCoder();

export class TestnetPlanError extends Error {
  constructor(code, message) { super(message); this.name = 'TestnetPlanError'; this.code = code; }
}
function check(ok, code, message) { if (!ok) throw new TestnetPlanError(code, message); }
function exactFields(object, fields, code, label) {
  check(object && typeof object === 'object' && !Array.isArray(object)
    && [Object.prototype, null].includes(Object.getPrototypeOf(object)), code, `${label} must be a plain object`);
  check(Object.keys(object).length === fields.length && fields.every((field) => Object.hasOwn(object, field)), code, `${label} requires exactly: ${fields.join(', ')}`);
}
function publicAddress(value, label) {
  let result;
  try { result = getAddress(value); } catch { throw new TestnetPlanError('INVALID_ADDRESS', `${label} must be an explicit public EVM address`); }
  check(result !== ZeroAddress, 'INVALID_ADDRESS', `${label} must not be zero`);
  return result;
}
function quantity(value, label) {
  check(typeof value === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value), 'INVALID_RPC_EVIDENCE', `${label} is not a canonical hexadecimal RPC quantity`);
  return BigInt(value);
}
function rpcHash(value, label) {
  check(typeof value === 'string' && HEX32.test(value), 'INVALID_RPC_EVIDENCE', `${label} is not a 32-byte hash`);
  return value.toLowerCase();
}
function sameAddress(a, b) {
  try { return getAddress(a) === getAddress(b); } catch { return false; }
}
function pinnedArtifacts(verification) {
  // The older compiler helper returns a shared object; never trust a mutable
  // cached artifact after producing the independently recompiled source bundle.
  const artifacts = structuredClone(compileContracts({ writeArtifacts: false }));
  for (const name of ['MoteToken', 'MotePayments']) {
    const artifact = artifacts[name]; const expected = verification.contracts[name];
    check(artifact.compiler === verification.compiler.version
      && keccak256(artifact.bytecode) === expected.creationBytecodeHash
      && keccak256(artifact.deployedBytecode) === expected.runtimeTemplateHash
      && hashJson(artifact.abi) === expected.abiHash,
    'BUILD_MISMATCH', 'Compiler artifacts changed after the verification input was independently reproduced');
  }
  return artifacts;
}

/** Public fingerprint only. It is neither a signature nor permission to spend. */
export function fingerprintTestnetPlan(plan) {
  const { planHash, ...body } = plan;
  return hashJson(body);
}

/** Build two unsigned creation requests. No provider or signing capability. */
export function createTestnetPlan(config) {
  exactFields(config, CONFIG_FIELDS, 'INVALID_CONFIG', 'Deployment configuration');
  let network;
  try { network = getTestnetNetwork(config.chainId); } catch { throw new TestnetPlanError('WRONG_CHAIN', 'Only Base Sepolia 84532 and Ethereum Sepolia 11155111 plans are permitted'); }
  const roles = Object.fromEntries(ROLE_FIELDS.map((name) => [name, publicAddress(config[name], name)]));
  check(typeof config.nonce === 'string' && /^(0|[1-9]\d*)$/.test(config.nonce)
    && config.nonce.length <= 16 && BigInt(config.nonce) <= BigInt(Number.MAX_SAFE_INTEGER - 1),
  'INVALID_NONCE', 'nonce must be a canonical nonnegative decimal string leaving room for two supported nonces');
  const nonce = BigInt(config.nonce);
  const verification = createVerificationBundle();
  const artifacts = pinnedArtifacts(verification);
  const tokenAddress = getCreateAddress({ from: roles.deployer, nonce });
  const paymentsAddress = getCreateAddress({ from: roles.deployer, nonce: nonce + 1n });
  const tokenArgs = [roles.initialHolder];
  const paymentArgs = [tokenAddress, roles.merchant, roles.quoteSigner];
  const body = {
    schema: network.planSchema,
    network: network.slug, chainId: network.chainId,
    status: 'unsigned-preparation', publicDeployment: false, broadcastReady: false, authorization: false,
    feeEstimateIncluded: false, expiryIncluded: false,
    roles, compiler: verification.compiler, verificationInputHash: verification.inputHash,
    contracts: {
      token: {
        contractName: 'MoteToken', identifier: verification.contracts.MoteToken.identifier,
        predictedAddress: tokenAddress, constructorArgs: tokenArgs,
        creationBytecodeHash: verification.contracts.MoteToken.creationBytecodeHash,
      },
      payments: {
        contractName: 'MotePayments', identifier: verification.contracts.MotePayments.identifier,
        predictedAddress: paymentsAddress, constructorArgs: paymentArgs,
        creationBytecodeHash: verification.contracts.MotePayments.creationBytecodeHash,
      },
    },
    transactions: [
      {
        contract: 'MoteToken', chainId: network.chainId, from: roles.deployer,
        nonce: nonce.toString(), to: null, value: '0',
        data: artifacts.MoteToken.bytecode + abi.encode(['address'], tokenArgs).slice(2),
      },
      {
        contract: 'MotePayments', chainId: network.chainId, from: roles.deployer,
        nonce: (nonce + 1n).toString(), to: null, value: '0',
        data: artifacts.MotePayments.bytecode + abi.encode(['address', 'address', 'address'], paymentArgs).slice(2),
      },
    ],
    notices: [
      'This public plan does not authorize signing, funding or broadcasting.',
      'Predicted addresses are not deployed addresses; both creation receipts must be verified.',
      network.feeModel === 'op-stack' ? 'Gas fields, Base L1/operator fees, funding, current nonce and transaction validity require separate checks.'
        : 'Gas fields, funding, current nonce and transaction validity require separate checks; this plan grants no spending authority.',
      network.feeModel === 'op-stack' ? 'Local rehearsals of chain ID 84532 are not Base execution or fee validation.'
        : 'Local rehearsals of chain ID 11155111 are not Ethereum Sepolia execution or finality validation.',
    ],
  };
  return { ...body, planHash: fingerprintTestnetPlan(body) };
}

/** Reject modifications by recomputing all public fields from pinned local builds. */
export function validateTestnetPlan(plan) {
  check(plan && typeof plan === 'object' && !Array.isArray(plan), 'INVALID_PLAN', 'Expected an unsigned deployment plan');
  exactFields(plan.roles, ROLE_FIELDS, 'INVALID_PLAN', 'Plan roles');
  check(Array.isArray(plan.transactions) && plan.transactions.length === 2, 'INVALID_PLAN', 'Plan must contain exactly two creation transactions');
  const expected = createTestnetPlan({ chainId: plan.chainId, ...plan.roles, nonce: plan.transactions[0]?.nonce });
  check(canonicalStringify(plan) === canonicalStringify(expected), 'PLAN_MISMATCH', 'Plan differs from its reconstructed addresses, bytecode, arguments, flags or fingerprint');
  return expected;
}

function verifyRuntime(actual, template, immutableReferences) {
  check(typeof actual === 'string' && HEX_DATA.test(actual) && actual.length === template.length && actual !== '0x', 'RUNTIME_MISMATCH', 'Deployed code length differs from its compiler runtime template');
  const deployed = Buffer.from(actual.slice(2), 'hex');
  const expected = Buffer.from(template.slice(2), 'hex');
  for (const ranges of Object.values(immutableReferences)) for (const { start, length } of ranges) {
    check(Number.isSafeInteger(start) && Number.isSafeInteger(length) && start >= 0 && length > 0 && start + length <= deployed.length,
      'INVALID_BUILD', 'Invalid compiler immutable-reference range');
    deployed.fill(0, start, start + length); expected.fill(0, start, start + length);
  }
  check(deployed.equals(expected), 'RUNTIME_MISMATCH', 'Deployed code differs outside compiler-declared immutable slots');
  return keccak256(actual);
}

/**
 * Read-only deployment verification against a caller-supplied RPC adapter.
 * This establishes matching finalized RPC evidence, not RPC authenticity, public
 * service readiness, fee bounds, economic value, or permission for any action.
 */
export async function verifyTestnetDeployment({ plan: rawPlan, provider, transactionHashes }) {
  const plan = validateTestnetPlan(rawPlan);
  const network = getTestnetNetwork(plan.chainId);
  exactFields(transactionHashes, ['token', 'payments'], 'INVALID_PROOF', 'Deployment transaction hashes');
  const hashes = Object.fromEntries(Object.entries(transactionHashes).map(([key, value]) => [key, rpcHash(value, key)]));
  check(hashes.token !== hashes.payments, 'INVALID_PROOF', 'Each contract requires its own creation transaction');
  check(provider && typeof provider.send === 'function', 'INVALID_PROVIDER', 'Supply a read-only provider.send(method, params) adapter');
  const rpc = (method, params = []) => provider.send(method, params);
  check(quantity(await rpc('eth_chainId'), 'chainId') === BigInt(network.chainId), 'WRONG_CHAIN', 'RPC does not report the pinned plan network');
  let finalized;
  try { finalized = await rpc('eth_getBlockByNumber', ['finalized', false]); }
  catch { throw new TestnetPlanError('FINALITY_UNAVAILABLE', 'RPC finalized-block support is required; block-count fallback is forbidden'); }
  check(finalized?.hash && finalized.number, 'FINALITY_UNAVAILABLE', 'RPC returned no finalized block');
  const finalizedNumber = quantity(finalized.number, 'finalized block number');
  const finalizedHash = rpcHash(finalized.hash, 'finalized block hash');
  const canonicalFinalized = await rpc('eth_getBlockByNumber', [finalized.number, false]);
  check(canonicalFinalized && quantity(canonicalFinalized.number, 'canonical finalized number') === finalizedNumber
    && rpcHash(canonicalFinalized.hash, 'canonical finalized hash') === finalizedHash,
    'SETTLEMENT_REORG', 'Finalized tag no longer identifies the same canonical block');
  const verification = createVerificationBundle();
  const artifacts = pinnedArtifacts(verification);
  const evidence = {};
  const receipts = {};
  for (const [index, key] of ['token', 'payments'].entries()) {
    const expected = plan.transactions[index];
    const contract = plan.contracts[key];
    const hash = hashes[key];
    const [receipt, tx] = await Promise.all([
      rpc('eth_getTransactionReceipt', [hash]), rpc('eth_getTransactionByHash', [hash]),
    ]);
    check(receipt && tx, 'DEPLOYMENT_PENDING', 'Both deployment transactions must have receipts and transaction data');
    check(rpcHash(receipt.transactionHash, 'receipt transaction hash') === hash && rpcHash(tx.hash, 'transaction hash') === hash,
      'DEPLOYMENT_MISMATCH', 'RPC evidence identifies a different transaction');
    check(quantity(receipt.status, 'receipt status') === 1n, 'DEPLOYMENT_REVERTED', 'A creation transaction reverted');
    check(receipt.to === null && tx.to === null && sameAddress(tx.from, expected.from)
      && sameAddress(receipt.from, expected.from) && sameAddress(receipt.contractAddress, contract.predictedAddress),
    'DEPLOYMENT_MISMATCH', 'Receipt address, sender or creation target differs from the plan');
    check(quantity(tx.nonce, 'transaction nonce') === BigInt(expected.nonce)
      && quantity(tx.value, 'transaction value') === 0n
      && quantity(tx.chainId, 'transaction chainId') === BigInt(network.chainId)
      && typeof tx.input === 'string' && tx.input.toLowerCase() === expected.data.toLowerCase(),
    'DEPLOYMENT_MISMATCH', 'Creation nonce, native value, chain or complete constructor calldata differs from the plan');
    const blockNumber = quantity(receipt.blockNumber, 'receipt block number');
    check(blockNumber <= finalizedNumber, 'NOT_FINALIZED', 'Deployment is newer than the RPC finalized block');
    const blockHash = rpcHash(receipt.blockHash, 'receipt block hash');
    check(typeof tx.blockHash === 'string' && typeof tx.blockNumber === 'string'
      && rpcHash(tx.blockHash, 'transaction block hash') === blockHash
      && quantity(tx.blockNumber, 'transaction block number') === blockNumber,
    'DEPLOYMENT_MISMATCH', 'Transaction and receipt do not identify the same mined block');
    const block = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
    check(block && quantity(block.number, 'canonical receipt block number') === blockNumber
      && rpcHash(block.hash, 'canonical receipt block hash') === blockHash,
      'SETTLEMENT_REORG', 'Deployment receipt is no longer canonical');
    const code = await rpc('eth_getCode', [contract.predictedAddress, finalized.number]);
    const runtimeCodeHash = verifyRuntime(code, artifacts[contract.contractName].deployedBytecode,
      verification.contracts[contract.contractName].immutableReferences);
    evidence[key] = {
      address: contract.predictedAddress, transactionHash: hash,
      blockNumber: blockNumber.toString(), blockHash, runtimeCodeHash,
      runtimeCheck: 'compiler-template-with-immutable-slots-masked',
      creationInputMatches: true,
    };
    receipts[key] = receipt;
  }
  const tokenInterface = new Interface(artifacts.MoteToken.abi);
  const routerInterface = new Interface(artifacts.MotePayments.abi);
  const read = async (address, iface, name, args = []) => {
    const value = await rpc('eth_call', [{ to: address, data: iface.encodeFunctionData(name, args) }, finalized.number]);
    return iface.decodeFunctionResult(name, value);
  };
  const tokenAddress = plan.contracts.token.predictedAddress;
  const routerAddress = plan.contracts.payments.predictedAddress;
  const [name, symbol, decimals, supply, token, merchant, quoteSigner, domain] = await Promise.all([
    read(tokenAddress, tokenInterface, 'name'), read(tokenAddress, tokenInterface, 'symbol'),
    read(tokenAddress, tokenInterface, 'decimals'), read(tokenAddress, tokenInterface, 'totalSupply'),
    read(routerAddress, routerInterface, 'token'), read(routerAddress, routerInterface, 'merchant'),
    read(routerAddress, routerInterface, 'quoteSigner'), read(routerAddress, routerInterface, 'eip712Domain'),
  ]);
  check(name[0] === 'Mote' && symbol[0] === 'MOTE' && decimals[0] === 6n && supply[0] === 1_000_000_000_000n,
    'TOKEN_CONFIG_MISMATCH', 'Token metadata or fixed supply differs from the compiled contract');
  check(sameAddress(token[0], tokenAddress) && sameAddress(merchant[0], plan.roles.merchant)
    && sameAddress(quoteSigner[0], plan.roles.quoteSigner), 'ROUTER_CONFIG_MISMATCH', 'Router immutable token, merchant or quote signer differs from the plan');
  check(domain[0] === '0x0f' && domain[1] === 'MotePayments' && domain[2] === '1'
    && domain[3] === BigInt(network.chainId) && sameAddress(domain[4], routerAddress)
    && domain[5] === ZeroHash && domain[6].length === 0,
  'DOMAIN_MISMATCH', 'Router EIP-712 domain differs from the pinned testnet and planned router');
  const mintEvents = receipts.token.logs.filter((log) => sameAddress(log.address, tokenAddress)).map((log) => {
    try { return tokenInterface.parseLog(log); } catch { return null; }
  }).filter((event) => event?.name === 'Transfer' && event.args.from === ZeroAddress);
  check(mintEvents.length === 1 && sameAddress(mintEvents[0].args.to, plan.roles.initialHolder)
    && mintEvents[0].args.value === 1_000_000_000_000n, 'TOKEN_CONFIG_MISMATCH', 'Creation receipt does not prove the exact initial supply allocation');
  // Number-pinned code/calls above share this finalized anchor. Recheck it after
  // all reads so an observable mid-verification reorganization cannot pass.
  const endingAnchor = await rpc('eth_getBlockByNumber', [finalized.number, false]);
  check(endingAnchor && quantity(endingAnchor.number, 'ending anchor number') === finalizedNumber
    && rpcHash(endingAnchor.hash, 'ending anchor hash') === finalizedHash,
  'SETTLEMENT_REORG', 'The finalized evidence anchor changed during verification');
  let endingFinalized;
  try { endingFinalized = await rpc('eth_getBlockByNumber', ['finalized', false]); }
  catch { throw new TestnetPlanError('FINALITY_UNAVAILABLE', 'Finalized-block support disappeared during verification'); }
  check(endingFinalized?.hash && endingFinalized.number, 'FINALITY_UNAVAILABLE', 'RPC returned no ending finalized block');
  const endingFinalizedNumber = quantity(endingFinalized.number, 'ending finalized block number');
  const endingFinalizedHash = rpcHash(endingFinalized.hash, 'ending finalized block hash');
  check(endingFinalizedNumber >= finalizedNumber,
    'SETTLEMENT_REORG', 'RPC finalized height regressed during verification');
  if (endingFinalizedNumber === finalizedNumber) {
    check(endingFinalizedHash === finalizedHash, 'SETTLEMENT_REORG', 'The finalized hash changed at the same height during verification');
  } else {
    const canonicalEnding = await rpc('eth_getBlockByNumber', [endingFinalized.number, false]);
    check(canonicalEnding && quantity(canonicalEnding.number, 'canonical ending finalized number') === endingFinalizedNumber
      && rpcHash(canonicalEnding.hash, 'canonical ending finalized hash') === endingFinalizedHash,
    'SETTLEMENT_REORG', 'The advanced finalized tag does not match its canonical block');
  }
  check(quantity(await rpc('eth_chainId'), 'ending chainId') === BigInt(network.chainId),
    'WRONG_CHAIN', 'RPC chain identity changed during verification');
  return {
    schema: 'mote-testnet-deployment-verification-v1', planHash: plan.planHash,
    chainId: network.chainId, verificationScope: 'deployment-only',
    source: 'caller-supplied-rpc', publicNetworkAuthenticityVerified: false,
    serviceReadinessVerified: false, feeBudgetVerified: false, broadcastAuthorization: false,
    finalized: { blockNumber: finalizedNumber.toString(), blockHash: finalizedHash },
    contracts: evidence,
    configuration: { tokenName: name[0], tokenSymbol: symbol[0], decimals: 6, totalSupply: supply[0].toString(), ...plan.roles },
  };
}
