import { AbiCoder, Interface, ZeroAddress, getAddress, getCreateAddress, keccak256 } from 'ethers';
import { compileDispenser } from '../scripts/compile-dispenser.mjs';
import { canonicalStringify, hashJson } from './json.mjs';
import { getTestnetNetwork } from './testnet-networks.mjs';

const fields = ['chainId', 'token', 'tokenRuntimeHash', 'deployer', 'nonce', 'claimAmount', 'distributionCap'];
function check(ok, message) { if (!ok) throw new Error(message); }
function address(value) { const a = getAddress(value); check(a !== ZeroAddress, 'Zero address forbidden'); return a; }
function integer(value, max) {
  check(typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && value.length <= 16, 'Canonical decimal string required');
  const n = BigInt(value); check(n <= max, 'Integer exceeds supported bound'); return n;
}

/** Unsigned add-on only. Does not read keys, contact a provider or authorize sending. */
export function createDispenserPlan(config) {
  check(config && Object.getPrototypeOf(config) === Object.prototype && Object.keys(config).length === fields.length && fields.every(k => Object.hasOwn(config, k)), 'Exact dispenser configuration required');
  check(config.chainId === 11155111, 'Only Ethereum Sepolia is supported');
  const network = getTestnetNetwork(11155111);
  const token = address(config.token), deployer = address(config.deployer);
  check(/^0x[0-9a-f]{64}$/.test(config.tokenRuntimeHash) && config.tokenRuntimeHash !== '0x'+'0'.repeat(64), 'Explicit lowercase nonzero token runtime hash required');
  const nonce = integer(config.nonce, BigInt(Number.MAX_SAFE_INTEGER - 1));
  const claim = integer(config.claimAmount, 10_000_000n), cap = integer(config.distributionCap, 10_000_000_000n);
  check(claim > 0n && cap >= claim && cap % claim === 0n, 'Positive divisible distribution cap required');
  const artifact = compileDispenser({ writeArtifact: false });
  const predictedAddress = getCreateAddress({ from: deployer, nonce });
  const constructorArgs = [token, claim.toString(), cap.toString()];
  const data = artifact.bytecode + AbiCoder.defaultAbiCoder().encode(['address', 'uint256', 'uint256'], constructorArgs).slice(2);
  const body = {
    schema: 'mote-ethereum-sepolia-dispenser-plan-v1', chainId: 11155111,
    genesisHash: network.genesisHash, status: 'unsigned-preparation', publicDeployment: false,
    authorization: false, broadcastReady: false, tokenEvidenceVerified: false, feesIncluded: false,
    token, expectedTokenRuntimeHash: config.tokenRuntimeHash, deployer,
    contract: { name: 'MoteTestDispenser', predictedAddress, constructorArgs,
      claimAmount: claim.toString(), distributionCap: cap.toString(), maxClaims: (cap/claim).toString(),
      compiler: artifact.compiler, creationBytecodeHash: keccak256(artifact.bytecode),
      runtimeTemplateHash: keccak256(artifact.deployedBytecode), abiHash: hashJson(artifact.abi) },
    transactions: [
      { purpose: 'deploy-dispenser', chainId: 11155111, from: deployer, nonce: nonce.toString(), to: null, value: '0', data },
      { purpose: 'fund-exact-reserve', chainId: 11155111, from: deployer, nonce: (nonce+1n).toString(), to: token, value: '0', data: new Interface(['function transfer(address,uint256) returns(bool)']).encodeFunctionData('transfer', [predictedAddress, cap]) },
    ],
    limits: { supplyMinted: '0', claimsPerAddress: 1, callerPaysNativeGas: true, sybilResistance: false, withdrawExcess: false },
    notices: [
      'This plan is not deployment evidence or authorization. It does not validate the caller-provided token hash against a chain.',
      'Verify the token is the intended fixed-supply MoteToken and both existing and new deployment receipts independently before publishing an active address.',
      'No global uniqueness, identity, fairness, test-gas faucet, automatic claim client or real economic value is provided.',
      'The existing two-contract deployment verifier and payment journal do not verify or authorize this add-on.',
      'Amounts transferred beyond the remaining distribution cap cannot be withdrawn. Never use valuable tokens.',
    ],
  };
  return { ...body, planHash: hashJson(body) };
}

export function validateDispenserPlan(plan) {
  check(plan && typeof plan === 'object', 'Expected dispenser plan');
  const expected = createDispenserPlan({ chainId: plan.chainId, token: plan.token,
    tokenRuntimeHash: plan.expectedTokenRuntimeHash, deployer: plan.deployer,
    nonce: plan.transactions?.[0]?.nonce, claimAmount: plan.contract?.claimAmount,
    distributionCap: plan.contract?.distributionCap });
  check(canonicalStringify(plan) === canonicalStringify(expected), 'Dispenser plan differs from exact reconstruction');
  return expected;
}
