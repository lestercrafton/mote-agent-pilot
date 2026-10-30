import test from 'node:test';
import assert from 'node:assert/strict';
import { HDNodeWallet, Transaction } from 'ethers';
import { ETHEREUM_FEE_POLICY, normalizeEthereumFeeTransaction, estimateEthereumFees, assertEthereumFeeCap, actualEthereumFees } from '../src/ethereum-fees.mjs';

// Existing public development fixture only. Offline signatures authenticate
// mocked transaction bytes; nothing is sent or funded and no key is generated.
const signer = HDNodeWallet.fromPhrase('test test test test test test test test test test test junk');
const from = signer.address.toLowerCase(), to = '0x' + '22'.repeat(20);
const q = n => '0x' + BigInt(n).toString(16);
const h = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const intent = { type: 2, chainId: 11155111, from, to, nonce: '7', gasLimit: '100000', maxFeePerGas: '100', maxPriorityFeePerGas: '3', value: '0', data: '0x010203' };

async function fixture(overrides = {}) {
  const transaction = { ...intent, ...overrides };
  const signed = Transaction.from(await signer.signTransaction({ ...transaction, nonce: Number(transaction.nonce), accessList: [] }));
  const transactionHash = signed.hash;
  const state = {
    chainId: q(11155111), code: '0x', calls: [],
    blocks: Object.fromEntries([9, 10, 12, 13].map(number => [q(number), {
      number: q(number), hash: h(number), parentHash: h(number - 1), timestamp: q(1792000000 + number * 12),
      baseFeePerGas: q(10), transactions: number === 10 ? [transactionHash] : [],
    }])),
    tx: {
      hash: transactionHash, type: '0x2', chainId: q(transaction.chainId), from, to: transaction.to,
      nonce: q(transaction.nonce), gas: q(transaction.gasLimit), maxFeePerGas: q(transaction.maxFeePerGas), maxPriorityFeePerGas: q(transaction.maxPriorityFeePerGas),
      value: '0x0', input: transaction.data, accessList: [], blockNumber: q(10), blockHash: h(10), transactionIndex: '0x0',
      r: signed.signature.r, s: signed.signature.s, yParity: q(signed.signature.yParity), v: q(signed.signature.yParity),
    },
    receipt: {
      transactionHash, type: '0x2', status: '0x1', from, to: transaction.to, contractAddress: null,
      blockNumber: q(10), blockHash: h(10), transactionIndex: '0x0', gasUsed: q(22001), effectiveGasPrice: q(13), logs: [],
    },
  };
  const reader = { async send(method, params) {
    state.calls.push({ method, params: structuredClone(params) });
    if (state.onSend) { const custom = await state.onSend(method, params); if (custom?.handled) return custom.value; }
    if (method === 'eth_chainId') return state.chainId;
    if (method === 'eth_getBlockByNumber') return structuredClone(state.blocks[params[0] === 'finalized' || params[0] === 'safe' ? q(12) : params[0] === 'latest' ? q(13) : params[0]] ?? null);
    if (method === 'eth_getCode') { assert.equal(params[0], from); assert.match(params[1], /^0x[0-9a-f]+$/); return state.code; }
    if (method === 'eth_getTransactionReceipt') { assert.equal(params[0], transactionHash); return structuredClone(state.receipt); }
    if (method === 'eth_getTransactionByHash') { assert.equal(params[0], transactionHash); return structuredClone(state.tx); }
    throw new Error(`Unsupported test method ${method}`);
  } };
  return { reader, state, transactionHash, transaction };
}
const estimate = f => estimateEthereumFees({ reader: f.reader, transaction: f.transaction });
const reconcile = f => actualEthereumFees({ reader: f.reader, transactionHash: f.transactionHash, expectedTransaction: f.transaction });
async function retained(promise, code) {
  await assert.rejects(promise, error => error.code === code && error.doNotReleaseReservation === true && error.doNotRepay === true);
}

test('Ethereum exact type-2 bound covers all network fees and separately enforces the policy maximum', async () => {
  const f = await fixture(), evidence = await estimate(f);
  assert.deepEqual(evidence.components, { executionMaxWei: '10000000', l1DataUpperBoundEstimateWei: '0', operatorAtGasLimitWei: '0' });
  assert.equal(evidence.reservationUpperBoundWei, '10000000');
  assert.equal(evidence.hardTotalCapEnforced, true);
  assert.equal(evidence.publicSubmissionAllowed, false, 'Fee observation alone is not payer authorization');
  const approved = assertEthereumFeeCap({ transaction: f.transaction, evidence, maxFeeWei: '10000000' });
  assert.equal(approved.feeBoundarySatisfied, true);
  assert.equal(approved.reservationUpperBoundWei, '10000000');
  assert.ok(Object.isFrozen(approved.transaction));
  assert.throws(() => assertEthereumFeeCap({ transaction: f.transaction, evidence, maxFeeWei: '9999999' }), { code: 'FEE_POLICY_LIMIT' });
  assert.throws(() => assertEthereumFeeCap({ transaction: f.transaction, evidence }), { code: 'FEE_INPUT_INVALID' });
  assert.ok(f.state.calls.every(call => !/send|sign|wallet/i.test(call.method)));
});

test('fee assertion recomputes transaction, encoding, every fee component and reservation rather than trusting flags', async () => {
  const f = await fixture(), original = await estimate(f);
  for (const change of [
    e => { e.transactionFingerprint = h(1); }, e => { e.unsignedTransactionBytes++; },
    e => { e.reservationUpperBoundWei = '1'; }, e => { e.estimatedTotalAtAnchorWei = '1'; },
    e => { e.components.executionMaxWei = '1'; }, e => { e.components.l1DataUpperBoundEstimateWei = '1'; },
    e => { e.components.operatorAtGasLimitWei = '1'; }, e => { e.chainId = 84532; },
    e => { e.gasRules.minimumInclusionGas = '0'; }, e => { e.sender.code = '0xef0100'; },
    e => { e.sender.atBlockHash = h(5); }, e => { e.anchor.numberHex = q(999); },
    e => { e.hardTotalCapEnforced = false; }, e => { e.publicSubmissionAllowed = true; },
  ]) {
    const evidence = structuredClone(original); change(evidence);
    assert.throws(() => assertEthereumFeeCap({ transaction: f.transaction, evidence, maxFeeWei: '10000000' }), { code: 'FEE_CAP_EVIDENCE_INVALID' });
  }
  const evidence = structuredClone(original); evidence.transaction.to = from;
  assert.throws(() => assertEthereumFeeCap({ transaction: f.transaction, evidence, maxFeeWei: '10000000' }));
  assert.throws(() => assertEthereumFeeCap({ transaction: { ...f.transaction, nonce: '8' }, evidence: original, maxFeeWei: '10000000' }), { code: 'FEE_TRANSACTION_MISMATCH' });
  assert.throws(() => assertEthereumFeeCap({ transaction: f.transaction, evidence: { hardTotalCapEnforced: true }, maxFeeWei: '10000000' }), { code: 'FEE_INPUT_INVALID' });
});

test('ordinary profile rejects alternate networks, blobs, authorization/access lists, native value and unsafe integer shapes', () => {
  for (const mutation of [
    { chainId: 1 }, { chainId: 84532 }, { type: 3 }, { type: 4 }, { value: '1' }, { to: null }, { to: from },
    { accessList: [] }, { authorizationList: [] }, { maxFeePerBlobGas: '1' }, { blobVersionedHashes: [] },
    { nonce: '-1' }, { nonce: '9007199254740992' }, { gasLimit: 100000 }, { gasLimit: '1.5' },
    { gasLimit: '16777217' }, { maxFeePerGas: '0' }, { maxPriorityFeePerGas: '101' }, { data: '0x1' },
  ]) assert.throws(() => normalizeEthereumFeeTransaction({ ...intent, ...mutation }), { code: 'FEE_INPUT_INVALID' });
  assert.equal(ETHEREUM_FEE_POLICY.maximumTransactionGas, '16777216', 'This is an application limit, not Amsterdam total-gas protocol maximum');
});

test('pre-Prague, Prague and Amsterdam inclusion/calldata reservations use their reviewed rules', async () => {
  for (const [timestamp, fork, intrinsicGas, floor] of [
    [1741159775n, 'pre-prague', '21036', '21036'],
    [1741159776n, 'prague', '21036', '21090'],
    [1791294816n, 'amsterdam', '15036', '15192'],
  ]) {
    const f = await fixture({ data: '0x000102' });
    f.state.blocks[q(13)].timestamp = q(timestamp);
    const result = await estimate(f);
    assert.equal(result.gasRules.fork, fork);
    assert.equal(result.gasRules.intrinsicGas, intrinsicGas);
    assert.equal(result.gasRules.calldataReservationFloor, floor);
  }
  const low = await fixture({ data: '0x' + '00'.repeat(1000), gasLimit: '40000' });
  await retained(estimate(low), 'FEE_GAS_LIMIT_BELOW_FLOOR');
  low.state.blocks[q(13)].timestamp = q(1741159776);
  assert.equal((await estimate(low)).gasRules.minimumInclusionGas, '31000');
});

test('preparation refuses delegated/code-bearing payers, missing state, underpriced fees and reorged observations', async () => {
  for (const code of ['0xef0100' + '33'.repeat(20), '0x6000', null]) {
    const f = await fixture(); f.state.code = code;
    await retained(estimate(f), 'FEE_SENDER_UNSUPPORTED');
  }
  const underpriced = await fixture(); underpriced.state.blocks[q(13)].baseFeePerGas = q(101);
  await retained(estimate(underpriced), 'FEE_MAX_BELOW_BASE');
  const missing = await fixture(); delete missing.state.blocks[q(13)];
  await retained(estimate(missing), 'FEE_EVIDENCE_UNAVAILABLE');
  const reorg = await fixture();
  reorg.state.onSend = async (method, params) => method === 'eth_getBlockByNumber' && params[0] === q(13) ? { handled: true, value: { ...reorg.state.blocks[q(13)], hash: h(99) } } : undefined;
  await retained(estimate(reorg), 'FEE_CANONICALITY_CHANGED');
});

test('chain mismatch at the beginning or end of a fee observation never falls back to mainnet or Base', async () => {
  for (const late of [false, true]) {
    const f = await fixture(); let count = 0;
    f.state.onSend = async method => method === 'eth_chainId' ? { handled: true, value: q(!late || ++count > 1 ? 84532 : 11155111) } : undefined;
    await retained(estimate(f), 'FEE_CHAIN_MISMATCH');
  }
});

test('finalized receipt fees include the full scalar gasUsed charge for success and revert', async () => {
  for (const status of ['0x1', '0x0']) {
    const f = await fixture(); f.state.receipt.status = status;
    const proof = await reconcile(f);
    assert.equal(proof.totalFeeWei, '286013');
    assert.equal(proof.feeWei, proof.totalFeeWei);
    assert.deepEqual(proof.components, { executionWei: '286013', l1DataWei: '0', operatorWei: '0' });
    assert.equal(proof.reservationUpperBoundWei, '10000000');
    assert.equal(proof.success, status === '0x1');
    assert.equal(proof.transactionHash, f.transactionHash);
    assert.equal(proof.finalized, true);
    assert.equal(proof.finalityAnchor.hash, h(12));
    assert.deepEqual(proof.receipt, f.state.receipt);
    assert.ok(Object.isFrozen(proof));
    assert.deepEqual(f.state.calls.filter(call => call.method === 'eth_getCode').map(call => call.params[1]), [q(9), q(10)]);
  }
});

test('ECDSA signature, serialized hash and recovered payer are independently checked', async () => {
  for (const change of [
    f => { f.state.tx.r = h(1); },
    f => { f.state.tx.s = h(1); },
    f => { f.state.tx.yParity = f.state.tx.yParity === '0x0' ? '0x1' : '0x0'; },
    f => { delete f.state.tx.r; },
  ]) {
    const f = await fixture(); change(f);
    await assert.rejects(reconcile(f), error => ['FEE_SIGNATURE_INVALID', 'FEE_EVIDENCE_INVALID'].includes(error.code) && error.doNotReleaseReservation);
  }
  const vOnly = await fixture(); delete vOnly.state.tx.yParity;
  assert.equal((await reconcile(vOnly)).transactionHash, vOnly.transactionHash);
});

test('ECDSA RPC integer scalars with leading zeroes omitted retain their exact signature value', async () => {
  let short;
  for (let nonce = 8; nonce < 512; nonce++) {
    const f = await fixture({ nonce: String(nonce) });
    f.state.tx.r = q(BigInt(f.state.tx.r)); f.state.tx.s = q(BigInt(f.state.tx.s));
    if (f.state.tx.r.length < 66 || f.state.tx.s.length < 66) { short = f; break; }
  }
  assert.ok(short, 'Deterministic public fixture includes a short RPC scalar');
  assert.equal((await reconcile(short)).transactionHash, short.transactionHash);
});

test('exact intent and receipt/block/index binding reject conflicting proof fields', async () => {
  for (const change of [
    f => { f.state.tx.hash = h(1); }, f => { f.state.tx.to = '0x' + '33'.repeat(20); },
    f => { f.state.tx.nonce = q(8); }, f => { f.state.tx.input = '0x12'; },
    f => { f.state.tx.gas = q(99999); }, f => { f.state.tx.maxFeePerGas = q(101); },
    f => { f.state.tx.blockHash = h(99); }, f => { f.state.tx.blockNumber = q(11); },
    f => { f.state.tx.transactionIndex = q(1); }, f => { f.state.receipt.from = to; },
    f => { f.state.blocks[q(10)].transactions = [h(3)]; },
    f => { f.state.tx.accessList = [{ address: to, storageKeys: [] }]; },
    f => { f.state.tx.authorizationList = []; }, f => { f.state.tx.blobVersionedHashes = []; },
  ]) { const f = await fixture(); change(f); await retained(reconcile(f), 'FEE_TRANSACTION_MISMATCH'); }
});

test('separate OP/deposit/blob receipt evidence is rejected rather than silently undercounted', async () => {
  for (const key of ['l1Fee', 'operatorFeeScalar', 'operatorFeeConstant', 'depositNonce', 'depositReceiptVersion', 'blobGasUsed', 'blobGasPrice']) {
    const f = await fixture(); f.state.receipt[key] = '0x1';
    await retained(reconcile(f), 'FEE_EVIDENCE_UNSUPPORTED');
  }
  const zero = await fixture(); zero.state.receipt.l1Fee = '0x0';
  await retained(reconcile(zero), 'FEE_EVIDENCE_UNSUPPORTED');
});

test('pending receipt and unfinalized receipt have distinct retryable read-only statuses', async () => {
  const pending = await fixture(); pending.state.receipt = null;
  await retained(reconcile(pending), 'FEE_PENDING');
  const malformed = await fixture(); malformed.state.receipt = undefined;
  await retained(reconcile(malformed), 'FEE_EVIDENCE_INVALID');
  const unfinalized = await fixture(); unfinalized.state.blocks[q(12)].number = q(9);
  await retained(reconcile(unfinalized), 'FEE_NOT_FINALIZED');
  const unsupported = await fixture(); delete unsupported.state.blocks[q(12)];
  await retained(reconcile(unsupported), 'FEE_EVIDENCE_UNAVAILABLE');
});

test('parent and inclusion reorgs, late finalized-anchor changes and coded historical payers retain reservations', async () => {
  for (const change of [
    f => { f.state.blocks[q(9)].hash = h(99); },
    f => { f.state.blocks[q(10)].hash = h(99); },
    f => { f.state.blocks[q(9)].timestamp = f.state.blocks[q(10)].timestamp; },
  ]) { const f = await fixture(); change(f); await retained(reconcile(f), 'FEE_CANONICALITY_CHANGED'); }
  for (const tag of [q(9), q(10), q(12)]) {
    const f = await fixture(); let count = 0;
    f.state.onSend = async (method, params) => method === 'eth_getBlockByNumber' && params[0] === tag && ++count > (tag === q(12) ? 0 : 1) ? { handled: true, value: { ...f.state.blocks[tag], hash: h(99) } } : undefined;
    await retained(reconcile(f), 'FEE_CANONICALITY_CHANGED');
  }
  const delegated = await fixture(); delegated.state.code = '0xef0100' + '33'.repeat(20);
  await retained(reconcile(delegated), 'FEE_SENDER_UNSUPPORTED');
});

test('completion rechecks finalized tag regression, same-height contradiction and advanced canonical binding', async () => {
  for (const ending of ['regression', 'same-height-fork', 'advanced-fork']) {
    const f = await fixture(); let finalizedReads = 0;
    f.state.onSend = async (method, params) => {
      if (method !== 'eth_getBlockByNumber' || params[0] !== 'finalized' || ++finalizedReads === 1) return;
      if (ending === 'regression') return { handled: true, value: f.state.blocks[q(9)] };
      const number = ending === 'same-height-fork' ? 12 : 13;
      return { handled: true, value: { ...f.state.blocks[q(number)], hash: h(99) } };
    };
    await retained(reconcile(f), 'FEE_CANONICALITY_CHANGED');
  }
  const f = await fixture(); let reads = 0;
  f.state.onSend = async (method, params) => method === 'eth_getBlockByNumber' && params[0] === 'finalized' && ++reads > 1 ? { handled: true, value: f.state.blocks[q(13)] } : undefined;
  assert.equal((await reconcile(f)).finalized, true, 'Normal finalized-head advancement remains usable');
});

test('receipt price/gas invariants enforce the cap without imposing obsolete 21000 receipt floor', async () => {
  const current = await fixture(); current.state.receipt.gasUsed = q(18000);
  assert.equal((await reconcile(current)).totalFeeWei, '234000');
  for (const change of [
    f => { f.state.receipt.gasUsed = '0x0'; }, f => { f.state.receipt.gasUsed = q(100001); },
    f => { f.state.receipt.effectiveGasPrice = q(14); },
    f => { f.state.blocks[q(10)].baseFeePerGas = q(101); },
    f => { f.state.receipt.status = '0x2'; },
  ]) { const f = await fixture(); change(f); await retained(reconcile(f), 'FEE_EVIDENCE_INVALID'); }
  const capped = await fixture({ maxPriorityFeePerGas: '95' }); capped.state.receipt.effectiveGasPrice = q(100);
  assert.equal((await reconcile(capped)).totalFeeWei, '2200100');
});

test('uint256 overflow is refused and caller mutation cannot alter an in-flight intent', async () => {
  assert.throws(() => normalizeEthereumFeeTransaction({ ...intent, maxFeePerGas: ((1n << 256n) - 1n).toString() }), { code: 'FEE_EVIDENCE_INVALID' });
  const f = await fixture(); const transaction = { ...f.transaction };
  const pending = estimateEthereumFees({ reader: f.reader, transaction });
  transaction.to = from; transaction.gasLimit = '1';
  const result = await pending;
  assert.equal(result.transaction.to, to); assert.equal(result.transaction.gasLimit, '100000');
});
