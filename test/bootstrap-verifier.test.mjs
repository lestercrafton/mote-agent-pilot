import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import ganache from 'ganache';
import { BrowserProvider, Interface } from 'ethers';
import { createBootstrapPlan } from '../src/bootstrap-plan.mjs';
import { bootstrapGasRequirements, createLoopbackBootstrapVerifier, verifyBootstrapStep } from '../src/bootstrap-verifier.mjs';
import { ETHEREUM_FEE_POLICY } from '../src/ethereum-fees.mjs';

// Actual transactions use only public worthless fixture accounts in process.
// Shanghai executes the bytecode; these tests DO NOT establish Amsterdam gas
// sufficiency. Current-fork protocol-event/receipt edges use labelled RPC mocks.
const PUBLIC_FIXTURE = 'test test test test test test test test test test test junk';
const hex = n => `0x${BigInt(n).toString(16)}`;
const H = n => `0x${n.toString(16).padStart(64, '0')}`;
let evm, provider, reader, genesisHash, plan, hashes, receipts;
before(async () => {
  evm = ganache.provider({ chain: { chainId: 11155111, networkId: 11155111, hardfork: 'shanghai', time: new Date('2024-01-01T00:00:00Z') },
    miner: { instamine: 'eager', timestampIncrement: 1 }, wallet: { mnemonic: PUBLIC_FIXTURE, totalAccounts: 6 }, logging: { quiet: true } });
  provider = new BrowserProvider(evm, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 10;
  const accounts = await Promise.all([0, 1, 2, 3].map(i => provider.getSigner(i)));
  const [operator, merchant, quoteSigner, payer] = await Promise.all(accounts.map(a => a.getAddress()));
  plan = createBootstrapPlan({ chainId: 11155111, operator, merchant, quoteSigner, payer, operatorNonce: '0', payerNativeWei: '5000000000000000' });
  reader = { endpoint: 'http://127.0.0.1:18545', send: (method, params = []) => evm.request({ method, params }) };
  genesisHash = (await reader.send('eth_getBlockByNumber', ['0x0', false])).hash;
  hashes = []; receipts = [];
  for (const step of plan.transactions) {
    const tx = step.transaction;
    const sent = await accounts[0].sendTransaction({ ...tx, nonce: Number(tx.nonce), value: BigInt(tx.value), gasLimit: BigInt(tx.gasLimit),
      maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) });
    await sent.wait(); hashes.push(sent.hash); receipts.push(await reader.send('eth_getTransactionReceipt', [sent.hash]));
  }
});
after(async () => { provider?.destroy(); await evm?.disconnect(); });
function modified(change) {
  const counts = new Map();
  return { endpoint: reader.endpoint, async send(method, params = []) {
    const key = JSON.stringify([method, params]); const count = (counts.get(key) ?? 0) + 1; counts.set(key, count);
    const result = structuredClone(await reader.send(method, params));
    const replacement = await change(method, params, result, count);
    return replacement === undefined ? result : replacement;
  } };
}
function verify(index, selected = reader, options = {}) {
  return createLoopbackBootstrapVerifier({ reader: selected, genesisHash })({ plan, index, transactionHash: hashes[index], ...options });
}
async function rejects(index, change, code) {
  await assert.rejects(verify(index, modified(change)), e => e.code === code && e.doNotResubmit && e.doNotReleaseReservation, `Expected ${code}`);
}
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

test('all five exact local-EVM bootstrap steps bind signatures, source, state and finalized fee/debit accounting', async () => {
  for (let index = 0; index < 5; index++) {
    const proof = await verify(index), tx = plan.transactions[index].transaction;
    assert.equal(proof.success, true); assert.equal(proof.planHash, plan.planHash); assert.equal(proof.index, index);
    assert.deepEqual(proof.transaction, tx); assert.equal(proof.transactionHash, hashes[index]); assert.equal(proof.localOnly, true);
    assert.equal(proof.authorization, false); assert.equal(proof.feeWei, (BigInt(receipts[index].gasUsed) * BigInt(receipts[index].effectiveGasPrice)).toString());
    assert.equal(proof.feeCapWei, (BigInt(tx.gasLimit) * BigInt(tx.maxFeePerGas)).toString());
    assert.equal(proof.nativeValueWei, tx.value); assert.equal(proof.totalDebitWei, (BigInt(proof.feeWei) + BigInt(tx.value)).toString());
    assert(Object.isFrozen(proof) && Object.isFrozen(proof.transaction));
    if (index < 3) assert(proof.runtimeHashes[['token', 'router', 'dispenser'][index]]);
    if (index === 0 || index === 3) assert.equal(proof.eventLogIndex, '0');
  }
});

test('production verification rejects local genesis and loopback factory cannot become an arbitrary endpoint override', async () => {
  await assert.rejects(verifyBootstrapStep({ plan, index: 0, transactionHash: hashes[0], reader }), e => e.code === 'BOOTSTRAP_CHAIN');
  for (const endpoint of ['https://example.invalid', 'http://user@localhost', 'file:///tmp/reader']) {
    assert.throws(() => createLoopbackBootstrapVerifier({ reader: { ...reader, endpoint }, genesisHash }), e => e.code === 'BOOTSTRAP_FIXTURE');
  }
  await assert.rejects(verify(0, reader, { reader: modified(() => {}) }), e => e.code === 'BOOTSTRAP_INPUT');
});

test('modified plans, unauthorized step indices and caller mutation cannot change the pinned intent', async () => {
  const changed = structuredClone(plan); changed.transactions[4].transaction.value = '6000000000000000';
  await assert.rejects(verify(4, reader, { plan: changed }), e => e.code === 'BOOTSTRAP_PLAN');
  for (const index of [-1, 5, 0.5, '1']) await assert.rejects(verify(0, reader, { index }), e => e.code === 'BOOTSTRAP_INPUT');
  const mutable = structuredClone(plan);
  const altered = modified((method, params, raw) => { if (method === 'eth_chainId') mutable.transactions[4].transaction.value = '1'; return raw; });
  const proof = await verify(4, altered, { plan: mutable }); assert.equal(proof.nativeValueWei, plan.payerNativeWei);
});

test('receipt absence and insufficient finality remain separately retryable without surrendering authority', async () => {
  await rejects(0, (m, p) => m === 'eth_getTransactionReceipt' ? null : undefined, 'BOOTSTRAP_PENDING');
  await rejects(4, async (m, p) => m === 'eth_getBlockByNumber' && p[0] === 'finalized'
    ? reader.send(m, [receipts[3].blockNumber, false]) : undefined, 'BOOTSTRAP_NOT_FINALIZED');
});

test('canonical reverted receipts retain actual fees but do not claim native delivery or successful deployments', async () => {
  for (const index of [0, 4]) {
    const proof = await verify(index, modified((m, p, raw) => {
      if (m === 'eth_getTransactionReceipt') return { ...raw, status: '0x0', logs: [], contractAddress: index === 0 ? raw.contractAddress : null };
    }));
    assert.equal(proof.success, false); assert.equal(proof.nativeValueWei, '0'); assert.equal(proof.totalDebitWei, proof.feeWei);
    assert.deepEqual(proof.runtimeHashes, {}); assert(BigInt(proof.feeWei) > 0n);
  }
});

test('signed transaction envelope and ECDSA recovery reject altered identities, fees, values and calldata', async () => {
  for (const [field, value] of [['from', plan.roles.payer], ['nonce', '0x9'], ['gas', '0x1'], ['value', '0x1'], ['input', '0x00'], ['maxFeePerGas', '0x1'], ['chainId', '0x1'], ['type', '0x3'], ['accessList', [{ address: plan.roles.payer, storageKeys: [] }]], ['authorizationList', []]]) {
    await rejects(1, (m, p, raw) => m === 'eth_getTransactionByHash' ? { ...raw, [field]: value } : undefined, 'BOOTSTRAP_TRANSACTION');
  }
  await rejects(1, (m, p, raw) => m === 'eth_getTransactionByHash' ? { ...raw, r: '0x1' } : undefined, 'BOOTSTRAP_SIGNATURE');
  await rejects(1, (m, p, raw) => m === 'eth_getTransactionByHash' ? { ...raw, yParity: raw.v === '0x0' ? '0x1' : '0x0' } : undefined, 'BOOTSTRAP_SIGNATURE');
});

test('receipt block/index/sender/creation binding and canonical membership are mandatory', async () => {
  for (const [field, value] of [['blockHash', H(98)], ['blockNumber', '0x99'], ['transactionIndex', '0x9'], ['from', plan.roles.payer], ['to', plan.roles.payer], ['contractAddress', plan.roles.payer]]) {
    await rejects(0, (m, p, raw) => m === 'eth_getTransactionReceipt' ? { ...raw, [field]: value } : undefined, 'BOOTSTRAP_TRANSACTION');
  }
  await rejects(1, (m, p, raw) => m === 'eth_getBlockByNumber' && p[0] === receipts[1].blockNumber ? { ...raw, transactions: [H(99)] } : undefined, 'BOOTSTRAP_TRANSACTION');
});

test('unsupported extra fees and inconsistent effective fee/gas cannot be undercounted', async () => {
  for (const changes of [{ l1Fee: '0x0' }, { operatorFeeScalar: '0x0' }, { blobGasUsed: '0x1' }, { effectiveGasPrice: '0x1' }, { gasUsed: '0x0' }, { gasUsed: hex(BigInt(plan.transactions[0].transaction.gasLimit) + 1n) }]) {
    await rejects(0, (m, p, raw) => m === 'eth_getTransactionReceipt' ? { ...raw, ...changes } : undefined, 'BOOTSTRAP_FEE');
  }
});

test('runtime source and immutable/configuration getters must match at the included block', async () => {
  await rejects(0, (m, p, raw) => m === 'eth_getCode' && same(p[0], plan.contracts.token.address) ? raw.slice(0, -2) + (raw.endsWith('00') ? '01' : '00') : undefined, 'BOOTSTRAP_RUNTIME');
  const abi = new Interface(plan.contracts.dispenser.abi), selector = abi.encodeFunctionData('claimAmount', []);
  await rejects(2, (m, p) => m === 'eth_call' && same(p[0].to, plan.contracts.dispenser.address) && p[0].data === selector
    ? abi.encodeFunctionResult('claimAmount', [1n]) : undefined, 'BOOTSTRAP_CONFIGURATION');
  await rejects(4, (m, p) => m === 'eth_getCode' && same(p[0], plan.roles.payer) ? '0xef0100' : undefined, 'BOOTSTRAP_RECIPIENT');
  await rejects(4, (m, p) => m === 'eth_getCode' && same(p[0], plan.roles.operator) ? '0xef0100' : undefined, 'BOOTSTRAP_SENDER');
});

test('mint and reserve-funding logs reject removal, false identities, data and duplicate numerical indices', async () => {
  for (const changes of [{ removed: true }, { transactionHash: H(99) }, { blockHash: H(99) }, { transactionIndex: '0x9' }, { data: H(1) }]) {
    await rejects(3, (m, p, raw) => m === 'eth_getTransactionReceipt' ? { ...raw, logs: [{ ...raw.logs[0], ...changes }] } : undefined, 'BOOTSTRAP_EVENT');
  }
  await rejects(0, (m, p, raw) => m === 'eth_getTransactionReceipt' ? { ...raw, logs: [raw.logs[0], { ...raw.logs[0], address: plan.roles.payer, logIndex: '0x0' }] } : undefined, 'BOOTSTRAP_EVENT');
});

test('Amsterdam native allocation requires its exact protocol ETH Transfer log, separate from gas charges', async () => {
  const abi = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const event = abi.encodeEventLog(abi.getEvent('Transfer'), [plan.roles.operator, plan.roles.payer, plan.payerNativeWei]);
  const log = { address: '0xfffffffffffffffffffffffffffffffffffffffe', ...event, removed: false, transactionHash: hashes[4],
    blockHash: receipts[4].blockHash, blockNumber: receipts[4].blockNumber, transactionIndex: receipts[4].transactionIndex, logIndex: '0x0' };
  const amsterdam = (m, p, raw) => {
    if (m === 'eth_getBlockByNumber' && raw?.number !== '0x0') return { ...raw, timestamp: hex(BigInt(ETHEREUM_FEE_POLICY.amsterdamTimestamp) + BigInt(raw.number)) };
    if (m === 'eth_getTransactionReceipt') return { ...raw, logs: [log] };
  };
  const proof = await verify(4, modified(amsterdam)); assert.equal(proof.eventLogIndex, '0');
  assert.equal(proof.nativeValueWei, plan.payerNativeWei); assert.equal(proof.feeWei, (BigInt(receipts[4].gasUsed) * BigInt(receipts[4].effectiveGasPrice)).toString());
  await rejects(4, (m, p, raw) => m === 'eth_getTransactionReceipt' ? { ...raw, logs: [] } : amsterdam(m, p, raw), 'BOOTSTRAP_EVENT');
  await rejects(4, (m, p, raw) => m === 'eth_getTransactionReceipt' ? { ...raw, logs: [{ ...log, data: H(1) }] } : amsterdam(m, p, raw), 'BOOTSTRAP_EVENT');
});

test('late canonical changes, finalized regression and same-height hash changes retain reservations', async () => {
  await rejects(1, (m, p, raw, count) => m === 'eth_getBlockByNumber' && p[0] === receipts[1].blockNumber && count > 1 ? { ...raw, hash: H(99) } : undefined, 'BOOTSTRAP_REORG');
  await rejects(1, async (m, p, raw, count) => m === 'eth_getBlockByNumber' && p[0] === 'finalized' && count > 1
    ? reader.send(m, [receipts[3].blockNumber, false]) : undefined, 'BOOTSTRAP_REORG');
  await rejects(1, (m, p, raw, count) => m === 'eth_getBlockByNumber' && p[0] === 'finalized' && count > 1 ? { ...raw, hash: H(99) } : undefined, 'BOOTSTRAP_REORG');
  await rejects(1, (m, p, raw, count) => m === 'eth_chainId' && count > 1 ? '0x1' : undefined, 'BOOTSTRAP_CHAIN');
});

test('reviewed intrinsic and fresh-state floors fit the revised budget but never imply execution sufficiency', () => {
  const current = plan.transactions.map((_, index) => bootstrapGasRequirements({ plan, index, timestamp: ETHEREUM_FEE_POLICY.amsterdamTimestamp }));
  for (const requirements of current) {
    assert.equal(requirements.fork, 'amsterdam'); assert.equal(requirements.knownWorkFits, true);
    assert.equal(requirements.executionSufficiencyVerified, false); assert.equal(requirements.assumesFreshState, true);
    assert(BigInt(requirements.knownWorkFloorGas) <= BigInt(requirements.plannedGasLimit));
  }
  assert.equal(current[4].intrinsicGas, '21000'); assert.equal(current[4].freshStateGas, '183600');
  assert.equal(current[4].knownWorkFloorGas, '204600');
  assert.equal(current[3].freshStateGas, '97920'); assert(BigInt(current[3].knownWorkFloorGas) > 100000n);
  for (let index = 0; index < 3; index++) {
    const artifact = plan.contracts[['token', 'router', 'dispenser'][index]], size = BigInt((artifact.deployedBytecode.length - 2) / 2);
    const slots = [4n, 0n, 1n][index];
    assert.equal(current[index].freshStateGas, ((size + 120n + 64n * slots) * 1530n).toString());
    assert(BigInt(current[index].knownWorkFloorGas) > [2000000n, 3000000n, 2000000n][index]);
  }
  const pre = bootstrapGasRequirements({ plan, index: 4, timestamp: '1704067200' });
  assert.equal(pre.fork, 'pre-prague'); assert.equal(pre.intrinsicGas, '21000'); assert.equal(pre.freshStateGas, '0');
  assert(BigInt(plan.policy.combinedMaximumWei) <= 50000000000000000n);
});

test('an actual reverted planned router creation yields finalized fees without successful deployment evidence', async () => {
  const operator = await provider.getSigner(0);
  const failingPlan = createBootstrapPlan({ chainId: 11155111, ...plan.roles, operatorNonce: '5', payerNativeWei: plan.payerNativeWei });
  // Fixture only: consume the planned token nonce without creating that token.
  // The exact subsequent router creation therefore reverts InvalidConfiguration.
  await (await operator.sendTransaction({ to: plan.roles.payer, nonce: 5, value: 0n, gasLimit: 21000n,
    type: 2, maxFeePerGas: BigInt(plan.policy.maxFeePerGas), maxPriorityFeePerGas: BigInt(plan.policy.maxPriorityFeePerGas) })).wait();
  const tx = failingPlan.transactions[1].transaction;
  const sent = await operator.sendTransaction({ ...tx, nonce: Number(tx.nonce), value: 0n, gasLimit: BigInt(tx.gasLimit),
    maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) });
  await assert.rejects(sent.wait(), e => e.receipt?.status === 0);
  const proof = await createLoopbackBootstrapVerifier({ reader, genesisHash })({ plan: failingPlan, index: 1, transactionHash: sent.hash });
  assert.equal(proof.success, false); assert(BigInt(proof.feeWei) > 0n); assert.equal(proof.nativeValueWei, '0');
  assert.deepEqual(proof.runtimeHashes, {}); assert.equal(proof.totalDebitWei, proof.feeWei);
});

test('stored finalized anchors remain canonical across reopening and later head advancement', async () => {
  const original = await verify(1), finalizedAnchor = original.finalized;
  await reader.send('evm_mine', []);
  const proof = await verify(1, reader, { finalizedAnchor });
  assert.equal(proof.transactionHash, original.transactionHash); assert.equal(proof.feeWei, original.feeWei);
  assert(BigInt(proof.finalized.blockNumber) > BigInt(finalizedAnchor.blockNumber));
  await assert.rejects(verify(1, reader, { finalizedAnchor: { ...finalizedAnchor, blockHash: H(99) } }), e => e.code === 'BOOTSTRAP_REORG' && e.doNotReleaseReservation);
  for (const blockNumber of ['0', (BigInt(proof.finalized.blockNumber) + 1n).toString()]) {
    await assert.rejects(verify(1, reader, { finalizedAnchor: { ...finalizedAnchor, blockNumber } }), e => e.code === 'BOOTSTRAP_REORG');
  }
  await assert.rejects(verify(1, reader, { finalizedAnchor: { ...finalizedAnchor, blockNumber: '01' } }), e => e.code === 'BOOTSTRAP_INPUT');
  const late = modified((m, p, raw, count) => m === 'eth_getBlockByNumber' && p[0] === hex(finalizedAnchor.blockNumber) && count > 1
    ? { ...raw, hash: H(99) } : undefined);
  await assert.rejects(verify(1, late, { finalizedAnchor }), e => e.code === 'BOOTSTRAP_REORG' && e.doNotResubmit);
});
