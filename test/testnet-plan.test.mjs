import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import ganache from 'ganache';
import solc from 'solc';
import { BrowserProvider, Contract, HDNodeWallet, Interface, ZeroAddress, id, keccak256 } from 'ethers';
import { compileContracts } from '../scripts/compile.mjs';
import { createVerificationBundle } from '../src/verification-bundle.mjs';
import { createTestnetPlan, validateTestnetPlan, fingerprintTestnetPlan, verifyTestnetDeployment } from '../src/testnet-plan.mjs';

// PUBLIC, INSECURE FIXTURES ONLY. Chain ID 84532 is simulated in local Ganache.
// These tests do not contact Base, validate Base execution/fees, or deploy there.
const PUBLIC_FIXTURE = 'test test test test test test test test test test test junk';
const TYPES = { Quote: [
  { name: 'quoteId', type: 'bytes32' }, { name: 'requestHash', type: 'bytes32' },
  { name: 'payer', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
] };
const allowedMethods = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getCode', 'eth_call']);
let eip1193, provider, deployer, payer, merchant, quoteSigner, config, plan, token, payments, artifacts;
const hashes = {};
let paidQuote, paidSignature;

function adapter(transform) {
  const calls = [];
  return {
    calls,
    async send(method, params) {
      assert.ok(allowedMethods.has(method), `Verifier attempted non-read-only RPC: ${method}`);
      calls.push(method);
      const value = await provider.send(method, params);
      return transform ? transform(method, params, structuredClone(value)) : value;
    },
  };
}
const verify = (rpc = adapter(), transactionHashes = hashes) => verifyTestnetDeployment({ plan, provider: rpc, transactionHashes });

before(async () => {
  eip1193 = ganache.provider({
    chain: { chainId: 84532, networkId: 84532, hardfork: 'shanghai' },
    wallet: { mnemonic: PUBLIC_FIXTURE, totalAccounts: 4 }, logging: { quiet: true },
  });
  provider = new BrowserProvider(eip1193, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 20;
  deployer = await provider.getSigner(0); payer = await provider.getSigner(1); merchant = await provider.getSigner(2);
  // Derive an already-public fixture solely for local EIP-712 signing; never save it.
  quoteSigner = HDNodeWallet.fromPhrase(PUBLIC_FIXTURE, undefined, "m/44'/60'/0'/0/3");
  config = { chainId: 84532, deployer: await deployer.getAddress(), initialHolder: await payer.getAddress(), merchant: await merchant.getAddress(), quoteSigner: quoteSigner.address, nonce: '0' };
  plan = createTestnetPlan(config);
  artifacts = compileContracts({ writeArtifacts: false });
  for (const [index, name] of ['token', 'payments'].entries()) {
    const tx = plan.transactions[index];
    const sent = await deployer.sendTransaction({ data: tx.data, nonce: Number(tx.nonce), chainId: 84532n, value: 0n });
    const receipt = await sent.wait();
    assert.equal(receipt.contractAddress, plan.contracts[name].predictedAddress);
    hashes[name] = sent.hash;
  }
  token = new Contract(plan.contracts.token.predictedAddress, artifacts.MoteToken.abi, payer);
  payments = new Contract(plan.contracts.payments.predictedAddress, artifacts.MotePayments.abi, payer);
});
after(async () => { provider?.destroy(); await eip1193?.disconnect(); });

test('verification bundle recompiles all sources without imports and preserves existing bytecode', () => {
  const bundle = createVerificationBundle();
  assert.ok(Object.keys(bundle.input.sources).length > 2);
  assert.ok(bundle.input.sources['@openzeppelin/contracts/token/ERC20/ERC20.sol'].content);
  const output = JSON.parse(solc.compile(JSON.stringify(bundle.input)));
  assert.deepEqual((output.errors ?? []).filter((entry) => entry.severity === 'error'), []);
  for (const name of ['MoteToken', 'MotePayments']) {
    const built = output.contracts[`contracts/${name}.sol`][name];
    assert.equal(`0x${built.evm.bytecode.object}`, artifacts[name].bytecode);
    assert.equal(`0x${built.evm.deployedBytecode.object}`, artifacts[name].deployedBytecode);
    assert.equal(bundle.contracts[name].creationBytecodeHash, keccak256(artifacts[name].bytecode));
  }
  assert.ok(Object.keys(bundle.contracts.MotePayments.immutableReferences).length > 0);
});

test('plan is deterministic, unsigned, zero-value and explicit about prediction and authority', () => {
  assert.deepEqual(createTestnetPlan(config), plan);
  assert.deepEqual(validateTestnetPlan(plan), plan);
  assert.equal(fingerprintTestnetPlan(plan), plan.planHash);
  assert.equal(plan.chainId, 84532);
  assert.equal(plan.publicDeployment, false);
  assert.equal(plan.broadcastReady, false);
  assert.equal(plan.authorization, false);
  assert.equal(plan.feeEstimateIncluded, false);
  assert.equal(plan.expiryIncluded, false);
  assert.deepEqual(plan.transactions.map((tx) => [tx.to, tx.value, tx.nonce]), [[null, '0', '0'], [null, '0', '1']]);
  assert.equal(plan.contracts.payments.constructorArgs[0], plan.contracts.token.predictedAddress);
});

test('configuration rejects secrets, missing roles, zero addresses, other chains and unsafe nonces', () => {
  assert.throws(() => createTestnetPlan({ ...config, privateKey: 'not-a-key' }), { code: 'INVALID_CONFIG' });
  const missing = { ...config }; delete missing.quoteSigner;
  assert.throws(() => createTestnetPlan(missing), { code: 'INVALID_CONFIG' });
  for (const role of ['deployer', 'initialHolder', 'merchant', 'quoteSigner']) {
    assert.throws(() => createTestnetPlan({ ...config, [role]: ZeroAddress }), { code: 'INVALID_ADDRESS' });
  }
  for (const chainId of [1, 8453, 31337, '84532']) assert.throws(() => createTestnetPlan({ ...config, chainId }), { code: 'WRONG_CHAIN' });
  for (const nonce of [-1, 0, '-1', '01', '1.5', '9007199254740991']) assert.throws(() => createTestnetPlan({ ...config, nonce }), { code: 'INVALID_NONCE' });
});

test('plan recomputation rejects changed arguments, bytecode, nonces, flags or added fields even after rehashing', () => {
  const changes = [
    (copy) => { copy.transactions[0].value = '1'; },
    (copy) => { copy.transactions[1].nonce = '3'; },
    (copy) => { copy.transactions[0].data = `${copy.transactions[0].data.slice(0, -2)}ff`; },
    (copy) => { copy.contracts.payments.constructorArgs[1] = config.initialHolder; },
    (copy) => { copy.verificationInputHash = id('other-build'); },
    (copy) => { copy.broadcastReady = true; },
    (copy) => { copy.mnemonic = 'forbidden arbitrary field'; },
  ];
  for (const change of changes) {
    const copy = structuredClone(plan); change(copy); copy.planHash = fingerprintTestnetPlan(copy);
    assert.throws(() => validateTestnetPlan(copy), { code: 'PLAN_MISMATCH' });
  }
  const originalBytecode = artifacts.MoteToken.bytecode;
  try {
    artifacts.MoteToken.bytecode = `0x00${originalBytecode.slice(4)}`;
    assert.throws(() => createTestnetPlan(config), { code: 'BUILD_MISMATCH' });
    assert.throws(() => validateTestnetPlan(plan), { code: 'BUILD_MISMATCH' });
  } finally { artifacts.MoteToken.bytecode = originalBytecode; }
  const originalAbi = artifacts.MoteToken.abi;
  try {
    artifacts.MoteToken.abi = [];
    assert.throws(() => createTestnetPlan(config), { code: 'BUILD_MISMATCH' });
  } finally { artifacts.MoteToken.abi = originalAbi; }
});

test('local rehearsal deploys both exact creations and verifies finalized RPC evidence without claiming public deployment', async () => {
  const rpc = adapter();
  const result = await verify(rpc);
  assert.equal(result.verificationScope, 'deployment-only');
  assert.equal(result.publicNetworkAuthenticityVerified, false);
  assert.equal(result.serviceReadinessVerified, false);
  assert.equal(result.feeBudgetVerified, false);
  assert.equal(result.broadcastAuthorization, false);
  assert.equal(result.contracts.token.address, await token.getAddress());
  assert.equal(result.contracts.payments.address, await payments.getAddress());
  assert.equal(result.configuration.totalSupply, '1000000000000');
  assert.equal(await token.balanceOf(config.initialHolder), 1_000_000_000_000n);
  assert.ok(rpc.calls.every((method) => allowedMethods.has(method)));
});

test('verification rejects a different RPC chain before reading deployment evidence', async () => {
  const rpc = adapter((method, params, value) => method === 'eth_chainId' ? '0x2105' : value);
  await assert.rejects(verify(rpc), { code: 'WRONG_CHAIN' });
  assert.deepEqual(rpc.calls, ['eth_chainId']);
});

test('finalized support, finalized height and canonical hashes are mandatory with no fallback', async () => {
  await assert.rejects(verify(adapter((method, params, value) => {
    if (method === 'eth_getBlockByNumber' && params[0] === 'finalized') throw new Error('unsupported tag');
    return value;
  })), { code: 'FINALITY_UNAVAILABLE' });
  await assert.rejects(verify(adapter((method, params, value) => method === 'eth_getBlockByNumber' && params[0] === 'finalized' ? null : value)), { code: 'FINALITY_UNAVAILABLE' });
  const genesis = await provider.send('eth_getBlockByNumber', ['0x0', false]);
  await assert.rejects(verify(adapter((method, params, value) => method === 'eth_getBlockByNumber' && params[0] === 'finalized' ? genesis : value)), { code: 'NOT_FINALIZED' });
  await assert.rejects(verify(adapter((method, params, value) => {
    if (method === 'eth_getBlockByNumber' && params[0] !== 'finalized') value.hash = id('reorganized-block');
    return value;
  })), { code: 'SETTLEMENT_REORG' });
  for (const [changedHash, code] of [[id('changed-finalized-tag'), 'SETTLEMENT_REORG'], ['malformed-hash', 'INVALID_RPC_EVIDENCE']]) {
    let reads = 0;
    await assert.rejects(verify(adapter((method, params, value) => {
      if (method === 'eth_getBlockByNumber' && params[0] === 'finalized' && ++reads === 2) value.hash = changedHash;
      return value;
    })), { code });
  }
  let readState = false;
  await assert.rejects(verify(adapter((method, params, value) => {
    if (method === 'eth_call') readState = true;
    if (readState && method === 'eth_getBlockByNumber' && params[0] !== 'finalized') value.hash = id('late-reorganization');
    return value;
  })), { code: 'SETTLEMENT_REORG' });
});

test('creation proofs reject missing receipts, reverts, wrong hashes, sender, nonce, value and arguments', async () => {
  await assert.rejects(verify(adapter(), { token: hashes.token, payments: hashes.token }), { code: 'INVALID_PROOF' });
  await assert.rejects(verify(adapter((method, params, value) => method === 'eth_getTransactionReceipt' ? null : value)), { code: 'DEPLOYMENT_PENDING' });
  await assert.rejects(verify(adapter((method, params, value) => {
    if (method === 'eth_getTransactionReceipt') value.status = '0x0'; return value;
  })), { code: 'DEPLOYMENT_REVERTED' });
  for (const [field, replacement] of [['hash', id('other-tx')], ['from', config.initialHolder], ['nonce', '0x8'], ['value', '0x1'], ['input', '0x00'], ['blockHash', id('other-fork')], ['blockNumber', '0x9'], ['blockHash', null]]) {
    await assert.rejects(verify(adapter((method, params, value) => {
      if (method === 'eth_getTransactionByHash' && params[0] === hashes.token) value[field] = replacement;
      return value;
    })), { code: 'DEPLOYMENT_MISMATCH' });
  }
  await assert.rejects(verify(adapter((method, params, value) => {
    if (method === 'eth_getTransactionReceipt') value.contractAddress = config.merchant; return value;
  })), { code: 'DEPLOYMENT_MISMATCH' });
});

test('runtime verification handles real immutable values but rejects changed executable code', async () => {
  const actual = await provider.getCode(await payments.getAddress());
  assert.notEqual(actual, artifacts.MotePayments.deployedBytecode, 'Raw compiler runtime contains unresolved immutable slots');
  await verify();
  await assert.rejects(verify(adapter((method, params, value) => method === 'eth_getCode' ? `0x00${value.slice(4)}` : value)), { code: 'RUNTIME_MISMATCH' });
});

test('verification independently checks supply, router immutables, signature domain and mint allocation', async () => {
  const routerInterface = new Interface(artifacts.MotePayments.abi);
  const tokenInterface = new Interface(artifacts.MoteToken.abi);
  const overrideCall = (iface, methodName, response) => adapter((method, params, value) => {
    if (method === 'eth_call' && params[0].data === iface.encodeFunctionData(methodName)) return iface.encodeFunctionResult(methodName, response);
    return value;
  });
  await assert.rejects(verify(overrideCall(tokenInterface, 'totalSupply', [1n])), { code: 'TOKEN_CONFIG_MISMATCH' });
  await assert.rejects(verify(overrideCall(routerInterface, 'quoteSigner', [config.deployer])), { code: 'ROUTER_CONFIG_MISMATCH' });
  const domain = await payments.eip712Domain();
  const wrongDomain = [...domain]; wrongDomain[3] = 31337n;
  await assert.rejects(verify(overrideCall(routerInterface, 'eip712Domain', wrongDomain)), { code: 'DOMAIN_MISMATCH' });
  await assert.rejects(verify(adapter((method, params, value) => {
    if (method === 'eth_getTransactionReceipt' && params[0] === hashes.token) value.logs = [];
    return value;
  })), { code: 'TOKEN_CONFIG_MISMATCH' });
});

test('local 84532 fixture accepts the first exact payment signed for its actual router domain', async () => {
  const block = await provider.getBlock('latest');
  paidQuote = { quoteId: id('84532-local-fixture-first-quote'), requestHash: id('synthetic-json-input'), payer: config.initialHolder, amount: 10n, deadline: BigInt(block.timestamp + 300) };
  paidSignature = await quoteSigner.signTypedData({ name: 'MotePayments', version: '1', chainId: 84532, verifyingContract: await payments.getAddress() }, TYPES, paidQuote);
  const beforeBalance = await token.balanceOf(config.initialHolder);
  await (await token.approve(await payments.getAddress(), paidQuote.amount)).wait();
  await (await payments.pay(paidQuote, paidSignature)).wait();
  assert.equal(await token.balanceOf(config.initialHolder), beforeBalance - 10n);
  assert.equal(await token.balanceOf(config.merchant), 10n);
  assert.equal(await token.allowance(config.initialHolder, await payments.getAddress()), 0n);
  assert.equal(await payments.consumed(paidQuote.quoteId), true);
});

test('local payment replay and wrong-chain signatures fail; deployment evidence remains valid after use', async () => {
  await assert.rejects(payments.pay.staticCall(paidQuote, paidSignature), (error) => error.revert?.name === 'QuoteAlreadyPaid');
  const quote = { ...paidQuote, quoteId: id('wrong-chain-quote') };
  const signature = await quoteSigner.signTypedData({ name: 'MotePayments', version: '1', chainId: 31337, verifyingContract: await payments.getAddress() }, TYPES, quote);
  await assert.rejects(payments.pay.staticCall(quote, signature), (error) => error.revert?.name === 'InvalidSignature');
  assert.equal(await payments.consumed(quote.quoteId), false);
  const result = await verify();
  assert.equal(result.contracts.token.creationInputMatches, true);
  assert.equal(result.configuration.totalSupply, '1000000000000');
});
