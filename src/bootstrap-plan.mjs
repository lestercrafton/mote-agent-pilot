import { AbiCoder, Interface, ZeroAddress, getAddress, getCreateAddress, keccak256 } from 'ethers';
import { compileContracts } from '../scripts/compile.mjs';
import { compileDispenser } from '../scripts/compile-dispenser.mjs';
import { createVerificationBundle } from './verification-bundle.mjs';
import { canonicalStringify, hashJson } from './json.mjs';
import { ETHEREUM_SEPOLIA } from './testnet-networks.mjs';

const INPUT = ['chainId', 'operator', 'merchant', 'quoteSigner', 'payer', 'operatorNonce', 'payerNativeWei'];
const ROLES = ['operator', 'merchant', 'quoteSigner', 'payer'];
// Reviewed preparation ceilings include Amsterdam account/code state charges.
// These are signed maximums, not a claim that current-fork execution was tested.
const GAS = ['5000000', '7000000', '5000000', '250000', '250000', '500000', '250000', '500000'];
const MAX_FEE = 2_000_000_000n, PRIORITY = 1_000_000_000n;
const abi = AbiCoder.defaultAbiCoder();
const freeze = (value) => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export class BootstrapError extends Error {
  constructor(code, message) { super(message); this.name = 'BootstrapError'; this.code = code; this.doNotResubmit = true; }
}
function check(ok, code, message) { if (!ok) throw new BootstrapError(code, message); }
function fields(value, expected) {
  check(value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key)),
    'BOOTSTRAP_CONFIG', 'Bootstrap configuration requires exactly the declared public fields');
}
function address(value) { let normalized; try { normalized = getAddress(value); } catch { throw new BootstrapError('BOOTSTRAP_CONFIG', 'Invalid public role address'); }
  check(normalized !== ZeroAddress, 'BOOTSTRAP_CONFIG', 'Zero role address is forbidden'); return normalized.toLowerCase(); }
function integer(value, maximum) { check(typeof value === 'string' && /^(0|[1-9][0-9]{0,17})$/.test(value) && BigInt(value) <= maximum, 'BOOTSTRAP_CONFIG', 'Expected a bounded canonical decimal integer'); return BigInt(value); }

/** Offline exact preparation only; no signer, provider, credentials or sends. */
export function createBootstrapPlan(input) {
  fields(input, INPUT);
  check(input.chainId === 11155111, 'BOOTSTRAP_CHAIN', 'Only Ethereum Sepolia bootstrap is permitted');
  const roles = Object.fromEntries(ROLES.map((key) => [key, address(input[key])]));
  check(roles.payer !== roles.operator && roles.payer !== roles.merchant && roles.payer !== roles.quoteSigner
    && roles.quoteSigner !== roles.operator && roles.quoteSigner !== roles.merchant,
  'BOOTSTRAP_ROLES', 'Controlled payer and unfunded quote signer must be distinct from each other and operator/merchant');
  const nonce = integer(input.operatorNonce, BigInt(Number.MAX_SAFE_INTEGER - 4));
  const native = integer(input.payerNativeWei, 7_000_000_000_000_000n);
  check(native >= 3_000_000_000_000_000n, 'BOOTSTRAP_BUDGET', 'Allocation must cover the conservative combined payer journal reservations without a refill');
  const verification = createVerificationBundle();
  const original = structuredClone(compileContracts({ writeArtifacts: false }));
  const dispenser = compileDispenser({ writeArtifact: false });
  for (const name of ['MoteToken', 'MotePayments']) {
    const expected = verification.contracts[name], built = original[name];
    check(built.compiler === verification.compiler.version && keccak256(built.bytecode) === expected.creationBytecodeHash
      && keccak256(built.deployedBytecode) === expected.runtimeTemplateHash && hashJson(built.abi) === expected.abiHash,
    'BOOTSTRAP_BUILD', 'Existing source-verification build and compiler artifacts disagree');
  }
  const predicted = [0, 1, 2].map((offset) => getCreateAddress({ from: roles.operator, nonce: nonce + BigInt(offset) }).toLowerCase());
  const artifact = (name, built, refs, constructorArgs, predictedAddress) => ({ name, address: predictedAddress, constructorArgs,
    abi: built.abi, bytecode: built.bytecode, deployedBytecode: built.deployedBytecode, immutableReferences: refs,
    ...(built.immutableNames ? { immutableNames: built.immutableNames } : {}),
    compiler: built.compiler, creationBytecodeHash: keccak256(built.bytecode), runtimeTemplateHash: keccak256(built.deployedBytecode), abiHash: hashJson(built.abi) });
  const contracts = {
    token: artifact('MoteToken', original.MoteToken, verification.contracts.MoteToken.immutableReferences, [roles.operator], predicted[0]),
    router: artifact('MotePayments', original.MotePayments, verification.contracts.MotePayments.immutableReferences, [predicted[0], roles.merchant, roles.quoteSigner], predicted[1]),
    dispenser: artifact('MoteTestDispenser', dispenser, dispenser.immutableReferences, [predicted[0], '10000000', '10000000000'], predicted[2]),
  };
  const operatorFee = GAS.slice(0, 5).reduce((sum, gas) => sum + BigInt(gas) * MAX_FEE, 0n);
  const payerFee = GAS.slice(5).reduce((sum, gas) => sum + BigInt(gas) * MAX_FEE, 0n);
  const combined = operatorFee + payerFee + native;
  check(combined <= 50_000_000_000_000_000n, 'BOOTSTRAP_BUDGET', 'The eight-step ceiling exceeds the fixed 0.05 Sepolia ETH budget');
  const policy = { maxTotalNativeWei: '50000000000000000', maxFeePerGas: MAX_FEE.toString(), maxPriorityFeePerGas: PRIORITY.toString(),
    operatorFeeCapWei: operatorFee.toString(), payerFeeCapWei: payerFee.toString(), nativeAllocationWei: native.toString(),
    combinedMaximumWei: combined.toString(), gasLimits: GAS.slice() };
  const creation = (key, types) => contracts[key].bytecode + abi.encode(types, contracts[key].constructorArgs).slice(2);
  const steps = [
    ['deploy-token', null, '0', creation('token', ['address'])],
    ['deploy-router', null, '0', creation('router', ['address', 'address', 'address'])],
    ['deploy-dispenser', null, '0', creation('dispenser', ['address', 'uint256', 'uint256'])],
    ['fund-dispenser', predicted[0], '0', new Interface(['function transfer(address,uint256) returns(bool)']).encodeFunctionData('transfer', [predicted[2], '10000000000'])],
    ['fund-payer', roles.payer, native.toString(), '0x'],
  ];
  const transactions = steps.map(([purpose, to, value, data], index) => ({ purpose, transaction: {
    type: 2, chainId: 11155111, from: roles.operator, to, nonce: (nonce + BigInt(index)).toString(), value, data,
    gasLimit: GAS[index], maxFeePerGas: MAX_FEE.toString(), maxPriorityFeePerGas: PRIORITY.toString(), accessList: [],
  } }));
  const body = { schema: 'mote-ethereum-sepolia-bootstrap-plan-v1', chainId: 11155111, network: ETHEREUM_SEPOLIA.slug,
    rpcUrl: ETHEREUM_SEPOLIA.rpcUrl, genesisHash: ETHEREUM_SEPOLIA.genesisHash, authorization: false, publicDeployment: false,
    roles, operatorNonce: nonce.toString(), payerNativeWei: native.toString(), contracts,
    verificationInputHash: verification.inputHash, dispenserCompilerInputHash: hashJson(dispenser.compilerInput),
    policy, policyHash: hashJson(policy), transactions,
    controlledPayerWork: { claimAmount: '10000000', maximumPaymentAmount: '656360', gasLimits: GAS.slice(5), maximumFeeWei: payerFee.toString(), maximumJournalReservationWei: '3000000000000000',
      automaticAuthorityGranted: false, separateSharedPayerJournalRequired: true },
  };
  return freeze({ ...body, planHash: hashJson(body) });
}

export function validateBootstrapPlan(plan) {
  check(plan && typeof plan === 'object', 'BOOTSTRAP_PLAN', 'An exact unsigned bootstrap plan is required');
  const expected = createBootstrapPlan({ chainId: plan.chainId, ...plan.roles, operatorNonce: plan.operatorNonce, payerNativeWei: plan.payerNativeWei });
  check(canonicalStringify(plan) === canonicalStringify(expected), 'BOOTSTRAP_PLAN', 'Bootstrap plan differs from exact source, destinations, nonces, amounts, fees or policy');
  return expected;
}
