import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, Transaction, getBytes } from 'ethers';
import { BASE_FEE_CONTRACTS, actualBaseFees, assertPublicFeeCap, estimateBaseFees, normalizeBaseFeeTransaction } from '../src/base-fees.mjs';

const q = value => '0x' + BigInt(value).toString(16);
const h = value => '0x' + BigInt(value).toString(16).padStart(64, '0');
const from = '0x' + '11'.repeat(20), to = '0x' + '22'.repeat(20);
const transactionHash = h(777);
const intent = { type: 2, chainId: 84532, from, to, nonce: '7', gasLimit: '100000', maxFeePerGas: '100', maxPriorityFeePerGas: '3', value: '0', data: '0x010203' };
const abi = new Interface([
  'function version() view returns (string)', 'function isFjord() view returns (bool)',
  'function isIsthmus() view returns (bool)', 'function isJovian() view returns (bool)',
  'function getL1FeeUpperBound(uint256) view returns (uint256)', 'function getOperatorFee(uint256) view returns (uint256)',
  'function operatorFeeScalar() view returns (uint32)', 'function operatorFeeConstant() view returns (uint64)',
]);

function fixture() {
  const state = {
    version: '1.6.0', fjord: true, isthmus: true, jovian: true, scalar: 2n, constant: 7n, l1Estimate: 1000n,
    code: '0x60006000', chainId: q(84532), calls: [], overrides: {},
    blocks: Object.fromEntries([10, 12, 13].map(number => [q(number), {
      number: q(number), hash: h(number), parentHash: h(number - 1), timestamp: q(number * 2), baseFeePerGas: q(10), transactions: number === 10 ? [transactionHash] : [],
    }])),
    tx: { hash: transactionHash, type: '0x2', chainId: q(84532), from, to, nonce: q(7), gas: q(100000), maxFeePerGas: q(100), maxPriorityFeePerGas: q(3), value: '0x0', input: intent.data, accessList: [], blockNumber: q(10), blockHash: h(10), transactionIndex: '0x0' },
    receipt: { transactionHash, type: '0x2', status: '0x1', from, to, blockNumber: q(10), blockHash: h(10), transactionIndex: '0x0', gasUsed: q(22001), effectiveGasPrice: q(13), l1Fee: q(31), operatorFeeScalar: q(2), operatorFeeConstant: q(7), logs: [] },
  };
  const reader = {
    async send(method, params) {
      state.calls.push({ method, params: structuredClone(params) });
      if (state.onSend) {
        const custom = await state.onSend(method, params, state.calls);
        if (custom?.handled) return custom.value;
      }
      if (method === 'eth_chainId') return state.chainId;
      if (method === 'eth_getBlockByNumber') return structuredClone(state.blocks[params[0] === 'finalized' || params[0] === 'safe' ? q(12) : params[0] === 'latest' ? q(13) : params[0]] ?? null);
      if (method === 'eth_getTransactionReceipt') { assert.equal(params[0], transactionHash); return structuredClone(state.receipt); }
      if (method === 'eth_getTransactionByHash') { assert.equal(params[0], transactionHash); return structuredClone(state.tx); }
      if (method === 'eth_getCode') { assert.ok(Object.values(BASE_FEE_CONTRACTS).includes(params[0])); return state.code; }
      if (method === 'eth_call') {
        assert.match(params[1], /^0x[0-9a-f]+$/); // Every oracle call is pinned to a block number.
        const parsed = abi.parseTransaction({ data: params[0].data });
        const isL1 = ['operatorFeeScalar', 'operatorFeeConstant'].includes(parsed.name);
        assert.equal(params[0].to, isL1 ? BASE_FEE_CONTRACTS.l1Block : BASE_FEE_CONTRACTS.gasPriceOracle);
        if (state.overrides[parsed.name]) return state.overrides[parsed.name](parsed.args, params[1]);
        const values = { version: state.version, isFjord: state.fjord, isIsthmus: state.isthmus, isJovian: state.jovian, operatorFeeScalar: state.scalar, operatorFeeConstant: state.constant, getL1FeeUpperBound: state.l1Estimate };
        const value = parsed.name === 'getOperatorFee' ? (state.jovian ? parsed.args[0] * state.scalar * 100n : parsed.args[0] * state.scalar / 1_000_000n) + state.constant : values[parsed.name];
        return abi.encodeFunctionResult(parsed.name, [value]);
      }
      throw new Error(`Unexpected method ${method}`);
    },
  };
  return { state, reader };
}

const reconcile = f => actualBaseFees({ reader: f.reader, transactionHash, expectedTransaction: intent });
async function retained(promise, code) {
  await assert.rejects(promise, error => error.code === code && error.doNotReleaseReservation === true && error.doNotRepay === true);
}

test('fee estimate includes execution, L1 and operator components but grants no total cap or submission', async () => {
  const f = fixture();
  const result = await estimateBaseFees({ reader: f.reader, transaction: intent });
  assert.deepEqual(result.components, { executionMaxWei: '10000000', l1DataUpperBoundEstimateWei: '1000', operatorAtGasLimitWei: '20000007' });
  assert.equal(result.estimatedTotalAtAnchorWei, '30001007');
  assert.equal(result.reservationUpperBoundWei, null);
  assert.equal(result.hardTotalCapEnforced, false);
  assert.equal(result.publicSubmissionAllowed, false);
  assert.equal(result.anchor.requestedTag, 'finalized');
  const encoded = Transaction.from({ ...intent, from: undefined, nonce: 7, accessList: [] }).unsignedSerialized;
  assert.equal(result.unsignedTransactionBytes, getBytes(encoded).length);
  const sizeCall = f.state.calls.find(({ method, params }) => method === 'eth_call' && abi.parseTransaction({ data: params[0].data }).name === 'getL1FeeUpperBound');
  assert.equal(abi.parseTransaction({ data: sizeCall.params[0].data }).args[0], BigInt(result.unsignedTransactionBytes));
  assert.ok(f.state.calls.filter(call => call.method === 'eth_call').every(call => call.params[1] === q(12)));
  assert.ok(f.state.calls.every(call => !/send|sign|wallet/i.test(call.method)));
});

test('ordinary public submission is refused even with forged cap flags or arbitrary evidence', () => {
  for (const evidence of [undefined, { hardTotalCapEnforced: true, reservationUpperBoundWei: '1' }, { publicSubmissionAllowed: true, testOnly: true }, { chainEnforced: true }]) {
    assert.throws(() => assertPublicFeeCap(evidence), error => error.code === 'BASE_TOTAL_FEE_CAP_UNENFORCEABLE' && error.doNotReleaseReservation);
  }
});

test('transaction intent rejects unknown fields, wrong network, unsafe numbers, native value and missing recipients', () => {
  const mutations = [
    { chainId: 8453 }, { type: 0 }, { value: '1' }, { from: '' }, { to: null },
    { nonce: '-1' }, { gasLimit: 100000 }, { gasLimit: '1.5' }, { nonce: '9007199254740992' },
    { maxFeePerGas: '0' }, { maxPriorityFeePerGas: '101' }, { accessList: [] },
    { data: '0x1' }, { privateKey: 'never-used-fixture-text' },
  ];
  for (const change of mutations) assert.throws(() => normalizeBaseFeeTransaction({ ...intent, ...change }), { code: 'FEE_INPUT_INVALID' });
  const missing = { ...intent }; delete missing.data;
  assert.throws(() => normalizeBaseFeeTransaction(missing), { code: 'FEE_INPUT_INVALID' });
});

test('unsupported oracle version, missing code, methods, wrong ABI and negative fee shapes fail closed', async () => {
  for (const [change, code] of [
    [f => { f.state.version = '1.7.0'; }, 'FEE_ORACLE_UNSUPPORTED'],
    [f => { f.state.fjord = false; }, 'FEE_ORACLE_UNSUPPORTED'],
    [f => { f.state.isthmus = false; }, 'FEE_ORACLE_UNSUPPORTED'],
    [f => { f.state.code = '0x'; }, 'FEE_EVIDENCE_UNAVAILABLE'],
    [f => { f.state.overrides.getL1FeeUpperBound = () => { throw new Error('unsupported'); }; }, 'FEE_EVIDENCE_UNAVAILABLE'],
    [f => { f.state.overrides.getL1FeeUpperBound = () => '-0x1'; }, 'FEE_EVIDENCE_INVALID'],
    [f => { f.state.overrides.getL1FeeUpperBound = () => '0x01'; }, 'FEE_EVIDENCE_INVALID'],
    [f => { f.state.overrides.isFjord = () => h(2); }, 'FEE_EVIDENCE_INVALID'],
    [f => { f.state.overrides.getOperatorFee = () => abi.encodeFunctionResult('getOperatorFee', [1]); }, 'FEE_OPERATOR_MISMATCH'],
  ]) {
    const f = fixture(); change(f);
    await retained(estimateBaseFees({ reader: f.reader, transaction: intent }), code);
  }
});

test('latest estimate detects canonical block changes and never silently uses a confirmation fallback', async () => {
  const f = fixture();
  f.state.onSend = async (method, params) => {
    if (method === 'eth_getBlockByNumber' && params[0] === q(13)) return { handled: true, value: { ...f.state.blocks[q(13)], hash: h(999) } };
  };
  await retained(estimateBaseFees({ reader: f.reader, transaction: intent, blockTag: 'latest' }), 'FEE_CANONICALITY_CHANGED');
  const missing = fixture(); delete missing.state.blocks[q(12)];
  await retained(estimateBaseFees({ reader: missing.reader, transaction: intent }), 'FEE_EVIDENCE_UNAVAILABLE');
});

test('wrong chain before or after fee observation fails closed', async () => {
  for (const late of [false, true]) {
    const f = fixture(); let chainCalls = 0;
    f.state.onSend = async method => method === 'eth_chainId' ? { handled: true, value: q(!late || ++chainCalls > 1 ? 8453 : 84532) } : undefined;
    await retained(estimateBaseFees({ reader: f.reader, transaction: intent }), 'FEE_CHAIN_MISMATCH');
  }
});

test('finalized receipt accounting sums every component at the receipt block, including reverted transactions', async () => {
  for (const status of ['0x1', '0x0']) {
    const f = fixture(); f.state.receipt.status = status;
    const result = await reconcile(f);
    assert.deepEqual(result.components, { executionWei: '286013', l1DataWei: '31', operatorWei: '4400207' });
    assert.equal(result.totalFeeWei, '4686251');
    assert.equal(result.feeWei, result.totalFeeWei);
    assert.equal(result.success, status === '0x1');
    assert.equal(result.blockHash, h(10));
    assert.equal(result.finalityAnchor.hash, h(12));
    assert.equal(result.finalized, true);
    assert.deepEqual(result.transaction, normalizeBaseFeeTransaction(intent));
    assert.deepEqual(result.receipt, f.state.receipt);
    assert.ok(f.state.calls.filter(call => ['eth_call', 'eth_getCode'].includes(call.method)).every(call => call.params[1] === q(10)));
  }
});

test('Isthmus arithmetic uses floor division and Jovian uses the updated scalar', async () => {
  const f = fixture(); f.state.jovian = false; f.state.scalar = 1_000_001n;
  f.state.receipt.operatorFeeScalar = q(f.state.scalar);
  const result = await reconcile(f);
  assert.equal(result.components.operatorWei, '22008');
  assert.equal(result.oracle.fork, 'isthmus');
});

test('zero operator fee requires historical zero evidence when receipt fields are absent', async () => {
  const f = fixture(); f.state.scalar = 0n; f.state.constant = 0n;
  delete f.state.receipt.operatorFeeScalar; delete f.state.receipt.operatorFeeConstant;
  assert.equal((await reconcile(f)).components.operatorWei, '0');
  const unknown = fixture(); delete unknown.state.receipt.operatorFeeScalar; delete unknown.state.receipt.operatorFeeConstant;
  await retained(reconcile(unknown), 'FEE_EVIDENCE_UNAVAILABLE');
  const noHistory = fixture(); noHistory.state.scalar = 0n; noHistory.state.constant = 0n;
  delete noHistory.state.receipt.operatorFeeScalar; delete noHistory.state.receipt.operatorFeeConstant;
  noHistory.state.overrides.getOperatorFee = () => { throw new Error('pruned historical state'); };
  await retained(reconcile(noHistory), 'FEE_EVIDENCE_UNAVAILABLE');
});

test('missing L1 data, partial operator fields and mismatched historical parameters retain reservations', async () => {
  const cases = [
    [f => { delete f.state.receipt.l1Fee; }, 'FEE_EVIDENCE_UNAVAILABLE'],
    [f => { delete f.state.receipt.operatorFeeConstant; }, 'FEE_EVIDENCE_UNAVAILABLE'],
    [f => { f.state.receipt.operatorFeeScalar = '0x3'; }, 'FEE_OPERATOR_MISMATCH'],
    [f => { f.state.receipt.l1Fee = '-1'; }, 'FEE_EVIDENCE_INVALID'],
    [f => { f.state.receipt.l1Fee = '0x00'; }, 'FEE_EVIDENCE_INVALID'],
    [f => { f.state.receipt = null; }, 'FEE_EVIDENCE_UNAVAILABLE'],
  ];
  for (const [change, code] of cases) { const f = fixture(); change(f); await retained(reconcile(f), code); }
});

test('receipt accounting binds original hash, exact intent, receipt and canonical transaction index', async () => {
  const cases = [
    f => { f.state.tx.hash = h(1); }, f => { f.state.tx.to = from; },
    f => { f.state.tx.nonce = q(8); }, f => { f.state.tx.input = '0x12'; },
    f => { f.state.tx.maxFeePerGas = q(101); }, f => { f.state.tx.gas = q(99999); },
    f => { f.state.tx.blockHash = h(11); }, f => { f.state.tx.blockNumber = q(11); },
    f => { f.state.tx.transactionIndex = q(1); }, f => { f.state.receipt.transactionHash = h(1); },
    f => { f.state.receipt.from = to; }, f => { f.state.blocks[q(10)].transactions = [h(2)]; },
  ];
  for (const change of cases) { const f = fixture(); change(f); await retained(reconcile(f), 'FEE_TRANSACTION_MISMATCH'); }
});

test('pending finality, reorged reverted receipt and late finality-anchor changes all retain reservations', async () => {
  const pending = fixture(); pending.state.blocks[q(12)].number = q(9);
  await retained(reconcile(pending), 'FEE_NOT_FINALIZED');
  const reverted = fixture(); reverted.state.receipt.status = '0x0'; reverted.state.blocks[q(10)].hash = h(99);
  await retained(reconcile(reverted), 'FEE_CANONICALITY_CHANGED');
  const late = fixture(); let reads = 0;
  late.state.onSend = async (method, params) => method === 'eth_getBlockByNumber' && params[0] === q(10) && ++reads > 1 ? { handled: true, value: { ...late.state.blocks[q(10)], hash: h(99) } } : undefined;
  await retained(reconcile(late), 'FEE_CANONICALITY_CHANGED');
  const anchor = fixture(); anchor.state.onSend = async (method, params) => method === 'eth_getBlockByNumber' && params[0] === q(12) ? { handled: true, value: { ...anchor.state.blocks[q(12)], hash: h(99) } } : undefined;
  await retained(reconcile(anchor), 'FEE_CANONICALITY_CHANGED');
});

test('invalid execution prices, gas use and arithmetic overflow fail closed', async () => {
  for (const change of [
    f => { f.state.receipt.gasUsed = q(100001); },
    f => { f.state.receipt.gasUsed = '0x0'; },
    f => { f.state.receipt.gasUsed = '0x1'; },
    f => { f.state.receipt.effectiveGasPrice = q(14); },
    f => { f.state.blocks[q(10)].baseFeePerGas = q(101); },
    f => { f.state.receipt.l1Fee = q((1n << 256n) - 1n); },
  ]) { const f = fixture(); change(f); await retained(reconcile(f), 'FEE_EVIDENCE_INVALID'); }
});

test('Jovian DA footprint receipt fields do not become a spurious second blob fee', async () => {
  const f = fixture(); f.state.receipt.blobGasUsed = q(999999); f.state.receipt.blobGasPrice = q(999999);
  const result = await reconcile(f);
  assert.equal(result.totalFeeWei, '4686251');
  assert.equal(Object.keys(result.components).length, 3);
});
