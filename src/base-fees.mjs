import { Interface, Transaction, getBytes, keccak256, toUtf8Bytes } from 'ethers';
import { BASE_SEPOLIA, createBaseSepoliaReader } from './testnet-rpc.mjs';

// Official references checked 2026-10-30. Ordinary type-2 transactions do NOT
// cap the separately charged L1 data fee. An oracle estimate cannot fix that.
// https://docs.optimism.io/op-stack/transactions/fees
// https://docs.base.org/specifications/transactions/network-fees
// https://github.com/ethereum-optimism/optimism/blob/develop/packages/contracts-bedrock/src/L2/GasPriceOracle.sol
// https://specs.optimism.io/protocol/isthmus/exec-engine.html
// https://specs.optimism.io/protocol/jovian/exec-engine.html
export const BASE_FEE_CONTRACTS = Object.freeze({
  gasPriceOracle: BASE_SEPOLIA.gasPriceOracle.toLowerCase(),
  l1Block: '0x4200000000000000000000000000000000000015',
});
const GPO = new Interface([
  'function version() view returns (string)',
  'function isFjord() view returns (bool)',
  'function isIsthmus() view returns (bool)',
  'function isJovian() view returns (bool)',
  'function getL1FeeUpperBound(uint256) view returns (uint256)',
  'function getOperatorFee(uint256) view returns (uint256)',
]);
const L1 = new Interface([
  'function operatorFeeScalar() view returns (uint32)',
  'function operatorFeeConstant() view returns (uint64)',
]);
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DATA = /^0x(?:[0-9a-fA-F]{2})*$/;
const MAX256 = (1n << 256n) - 1n;
const MAX64 = (1n << 64n) - 1n;
const FIELDS = ['type', 'chainId', 'from', 'to', 'nonce', 'gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas', 'value', 'data'];

export class BaseFeeError extends Error {
  constructor(code, message, cause) {
    super(message, { cause }); this.name = 'BaseFeeError'; this.code = code;
    this.doNotReleaseReservation = true; this.doNotRepay = true;
  }
}
const fail = (code, message, cause) => { throw new BaseFeeError(code, message, cause); };
const check = (value, code, message) => { if (!value) fail(code, message); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const qty = value => '0x' + value.toString(16);
function decimal(value, label, maximum = MAX256) {
  check(typeof value === 'string' && UINT.test(value) && BigInt(value) <= maximum, 'FEE_INPUT_INVALID', `${label} must be a bounded unsigned decimal integer string.`);
  return BigInt(value);
}
function rpcInteger(value, label, maximum = MAX256) {
  check(typeof value === 'string' && QUANTITY.test(value) && BigInt(value) <= maximum, 'FEE_EVIDENCE_INVALID', `${label} must be a canonical bounded JSON-RPC quantity.`);
  return BigInt(value);
}
function address(value, label) {
  check(typeof value === 'string' && ADDRESS.test(value), 'FEE_INPUT_INVALID', `${label} must be an exact EVM address.`);
  return value.toLowerCase();
}
function hash(value, label) {
  check(typeof value === 'string' && HASH.test(value), 'FEE_EVIDENCE_INVALID', `${label} must be a 32-byte hash.`);
  return value.toLowerCase();
}
const bounded = value => { check(value >= 0n && value <= MAX256, 'FEE_EVIDENCE_INVALID', 'Fee arithmetic exceeds uint256.'); return value; };

/** Exact ordinary type-2 intent. No deployment, access list, native transfer,
 * automatic nonce selection, populated fees, or arbitrary extra fields. */
export function normalizeBaseFeeTransaction(input) {
  check(plain(input) && Object.keys(input).length === FIELDS.length && Object.keys(input).every(key => FIELDS.includes(key)), 'FEE_INPUT_INVALID', 'A complete exact type-2 transaction intent is required.');
  check(input.type === 2 && input.chainId === BASE_SEPOLIA.chainId && input.value === '0', 'FEE_INPUT_INVALID', 'Only Base Sepolia type-2 transactions with zero native value are supported.');
  const output = { type: 2, chainId: BASE_SEPOLIA.chainId, from: address(input.from, 'from'), to: address(input.to, 'to') };
  for (const key of ['nonce', 'gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas', 'value']) {
    const maximum = key === 'nonce' ? BigInt(Number.MAX_SAFE_INTEGER) : key === 'gasLimit' ? MAX64 : MAX256;
    output[key] = decimal(input[key], key, maximum).toString();
  }
  check(BigInt(output.gasLimit) >= 21000n && BigInt(output.maxFeePerGas) > 0n && BigInt(output.maxPriorityFeePerGas) <= BigInt(output.maxFeePerGas), 'FEE_INPUT_INVALID', 'Gas and EIP-1559 fee limits are invalid.');
  check(typeof input.data === 'string' && DATA.test(input.data) && getBytes(input.data).length <= 65_536, 'FEE_INPUT_INVALID', 'Transaction calldata must be bounded hexadecimal.');
  output.data = input.data.toLowerCase();
  bounded(BigInt(output.gasLimit) * BigInt(output.maxFeePerGas));
  return output;
}

function transactionEncoding(transaction) {
  const tx = Transaction.from({
    type: 2, chainId: transaction.chainId, to: transaction.to, nonce: Number(transaction.nonce),
    gasLimit: BigInt(transaction.gasLimit), maxFeePerGas: BigInt(transaction.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(transaction.maxPriorityFeePerGas), value: 0n,
    data: transaction.data, accessList: [],
  });
  return { unsignedTransactionBytes: getBytes(tx.unsignedSerialized).length, transactionFingerprint: keccak256(toUtf8Bytes(JSON.stringify(transaction))) };
}

function block(value, label) {
  check(plain(value), 'FEE_EVIDENCE_UNAVAILABLE', `${label} block is unavailable; no confirmation-count fallback is permitted.`);
  return {
    number: rpcInteger(value.number, `${label}.number`).toString(), numberHex: qty(BigInt(value.number)),
    hash: hash(value.hash, `${label}.hash`), parentHash: hash(value.parentHash, `${label}.parentHash`),
    timestamp: rpcInteger(value.timestamp, `${label}.timestamp`).toString(),
    baseFeePerGas: rpcInteger(value.baseFeePerGas, `${label}.baseFeePerGas`).toString(),
  };
}

async function chain(reader) {
  check(reader && typeof reader.send === 'function', 'FEE_INPUT_INVALID', 'A read-only RPC reader is required.');
  check(rpcInteger(await reader.send('eth_chainId', []), 'chainId') === BigInt(BASE_SEPOLIA.chainId), 'FEE_CHAIN_MISMATCH', 'Fee evidence must come from Base Sepolia chain 84532.');
}

async function recheck(reader, anchor) {
  const again = block(await reader.send('eth_getBlockByNumber', [anchor.numberHex, false]), 'canonical');
  check(JSON.stringify(again) === JSON.stringify(anchor), 'FEE_CANONICALITY_CHANGED', 'The fee evidence block changed during inspection; retain reservations.');
}

async function call(reader, target, abi, name, args, anchor) {
  let result;
  try { result = await reader.send('eth_call', [{ to: target, data: abi.encodeFunctionData(name, args) }, anchor.numberHex]); }
  catch (error) { fail('FEE_EVIDENCE_UNAVAILABLE', `Historical ${name} evidence is unavailable; retain reservations.`, error); }
  check(typeof result === 'string' && DATA.test(result) && result.length <= 1026, 'FEE_EVIDENCE_INVALID', `${name} returned malformed ABI data.`);
  try {
    const decoded = abi.decodeFunctionResult(name, result);
    // Decoders may tolerate trailing bytes or noncanonical boolean encodings.
    check(abi.encodeFunctionResult(name, decoded).toLowerCase() === result.toLowerCase(), 'FEE_EVIDENCE_INVALID', `${name} returned noncanonical ABI data.`);
    return decoded[0];
  } catch (error) {
    if (error instanceof BaseFeeError) throw error;
    fail('FEE_EVIDENCE_INVALID', `${name} returned unsupported ABI data.`, error);
  }
}

async function oracle(reader, anchor, gas) {
  const codeHashes = {};
  for (const [name, target] of Object.entries(BASE_FEE_CONTRACTS)) {
    const code = await reader.send('eth_getCode', [target, anchor.numberHex]);
    check(typeof code === 'string' && DATA.test(code) && code.length > 2 && code.length <= 131_074, 'FEE_EVIDENCE_UNAVAILABLE', 'Required fee predeploy code is unavailable.');
    codeHashes[name] = keccak256(code);
  }
  const version = await call(reader, BASE_FEE_CONTRACTS.gasPriceOracle, GPO, 'version', [], anchor);
  check(version === '1.6.0', 'FEE_ORACLE_UNSUPPORTED', 'Only the reviewed GasPriceOracle 1.6.0 fee interface is supported.');
  const fjord = await call(reader, BASE_FEE_CONTRACTS.gasPriceOracle, GPO, 'isFjord', [], anchor);
  const isthmus = await call(reader, BASE_FEE_CONTRACTS.gasPriceOracle, GPO, 'isIsthmus', [], anchor);
  const jovian = await call(reader, BASE_FEE_CONTRACTS.gasPriceOracle, GPO, 'isJovian', [], anchor);
  check(fjord && isthmus, 'FEE_ORACLE_UNSUPPORTED', 'Only reviewed Fjord/Isthmus or Jovian fee accounting is supported.');
  const scalar = await call(reader, BASE_FEE_CONTRACTS.l1Block, L1, 'operatorFeeScalar', [], anchor);
  const constant = await call(reader, BASE_FEE_CONTRACTS.l1Block, L1, 'operatorFeeConstant', [], anchor);
  const expected = bounded((jovian ? gas * scalar * 100n : gas * scalar / 1_000_000n) + constant);
  const reported = await call(reader, BASE_FEE_CONTRACTS.gasPriceOracle, GPO, 'getOperatorFee', [gas], anchor);
  check(reported === expected, 'FEE_OPERATOR_MISMATCH', 'Historical operator fee disagrees with its fork and parameters; retain reservations.');
  return { version, codeHashes, fork: jovian ? 'jovian' : 'isthmus', operatorFeeScalar: scalar.toString(), operatorFeeConstant: constant.toString(), operatorFeeWei: reported.toString() };
}

async function guarded(work) {
  try { return await work(); }
  catch (error) {
    if (error instanceof BaseFeeError) throw error;
    fail('FEE_EVIDENCE_UNAVAILABLE', 'Complete canonical Base fee evidence is unavailable; retain reservations.', error);
  }
}

/** Diagnostic observation only. No margin or policy maximum converts it into
 * a protocol-enforced reservation upper bound. The default anchor is finalized. */
export async function estimateBaseFees({ reader = createBaseSepoliaReader(), transaction, blockTag = 'finalized' } = {}) {
  return guarded(async () => {
    const normalized = normalizeBaseFeeTransaction(transaction);
    check(['latest', 'safe', 'finalized'].includes(blockTag), 'FEE_INPUT_INVALID', 'Use an explicit latest, safe or finalized observation tag.');
    await chain(reader);
    const anchor = block(await reader.send('eth_getBlockByNumber', [blockTag, false]), blockTag);
    const encoding = transactionEncoding(normalized);
    const evidence = await oracle(reader, anchor, BigInt(normalized.gasLimit));
    const l1 = await call(reader, BASE_FEE_CONTRACTS.gasPriceOracle, GPO, 'getL1FeeUpperBound', [encoding.unsignedTransactionBytes], anchor);
    const execution = bounded(BigInt(normalized.gasLimit) * BigInt(normalized.maxFeePerGas));
    const total = bounded(execution + l1 + BigInt(evidence.operatorFeeWei));
    await recheck(reader, anchor); await chain(reader);
    return {
      schemaVersion: 1, kind: 'base-fee-estimate', chainId: BASE_SEPOLIA.chainId,
      transaction: normalized, ...encoding, anchor: { ...anchor, requestedTag: blockTag }, oracle: evidence,
      components: { executionMaxWei: execution.toString(), l1DataUpperBoundEstimateWei: l1.toString(), operatorAtGasLimitWei: evidence.operatorFeeWei },
      estimatedTotalAtAnchorWei: total.toString(), reservationUpperBoundWei: null,
      hardTotalCapEnforced: false, publicSubmissionAllowed: false,
      limitations: ['L1 data fee is not capped by an ordinary type-2 transaction.', 'The oracle size bound is a practical estimate, not a universal guarantee.', 'L1 and operator fee parameters may change before inclusion.'],
    };
  });
}

/** There is deliberately no caller-supplied evidence or boolean escape hatch. */
export function assertPublicFeeCap() {
  fail('BASE_TOTAL_FEE_CAP_UNENFORCEABLE', 'Ordinary Base transactions cannot enforce the complete authorized L2 + L1 + operator fee ceiling. Public submission is disabled.');
}

function bindTransaction(value, expected, transactionHash, receipt) {
  check(plain(value) && hash(value.hash, 'transaction.hash') === transactionHash, 'FEE_TRANSACTION_MISMATCH', 'Transaction evidence does not match the requested hash.');
  check(rpcInteger(value.type, 'transaction.type') === 2n && rpcInteger(value.chainId, 'transaction.chainId') === BigInt(BASE_SEPOLIA.chainId) && Array.isArray(value.accessList) && value.accessList.length === 0, 'FEE_TRANSACTION_MISMATCH', 'Only the exact ordinary type-2 transaction is supported.');
  const actual = normalizeBaseFeeTransaction({
    type: 2, chainId: BASE_SEPOLIA.chainId, from: value.from, to: value.to,
    nonce: rpcInteger(value.nonce, 'transaction.nonce').toString(), gasLimit: rpcInteger(value.gas, 'transaction.gas').toString(),
    maxFeePerGas: rpcInteger(value.maxFeePerGas, 'transaction.maxFeePerGas').toString(),
    maxPriorityFeePerGas: rpcInteger(value.maxPriorityFeePerGas, 'transaction.maxPriorityFeePerGas').toString(),
    value: rpcInteger(value.value, 'transaction.value').toString(), data: value.input,
  });
  check(JSON.stringify(actual) === JSON.stringify(expected), 'FEE_TRANSACTION_MISMATCH', 'Receipt transaction differs from the pinned sender, recipient, calldata, nonce, value, or fee envelope.');
  check(hash(value.blockHash, 'transaction.blockHash') === hash(receipt.blockHash, 'receipt.blockHash') && rpcInteger(value.blockNumber, 'transaction.blockNumber') === rpcInteger(receipt.blockNumber, 'receipt.blockNumber') && rpcInteger(value.transactionIndex, 'transaction.transactionIndex') === rpcInteger(receipt.transactionIndex, 'receipt.transactionIndex'), 'FEE_TRANSACTION_MISMATCH', 'Transaction and receipt block bindings differ.');
}

/** Read-only reconciliation, including reverted transactions. Missing fee or
 * finality evidence is an error: callers must keep their existing reservation. */
export async function actualBaseFees({ reader = createBaseSepoliaReader(), transactionHash, expectedTransaction } = {}) {
  return guarded(async () => {
    const normalized = normalizeBaseFeeTransaction(expectedTransaction);
    const txHash = hash(transactionHash, 'transactionHash');
    await chain(reader);
    const receipt = await reader.send('eth_getTransactionReceipt', [txHash]);
    check(plain(receipt), 'FEE_EVIDENCE_UNAVAILABLE', 'Receipt is not yet available; retain reservations.');
    check(hash(receipt.transactionHash, 'receipt.transactionHash') === txHash && rpcInteger(receipt.type, 'receipt.type') === 2n, 'FEE_TRANSACTION_MISMATCH', 'Receipt does not describe the exact ordinary transaction.');
    const status = rpcInteger(receipt.status, 'receipt.status');
    check(status === 0n || status === 1n, 'FEE_EVIDENCE_INVALID', 'Receipt status must be success or revert.');
    const tx = await reader.send('eth_getTransactionByHash', [txHash]);
    bindTransaction(tx, normalized, txHash, receipt);
    check(address(receipt.from, 'receipt.from') === normalized.from && address(receipt.to, 'receipt.to') === normalized.to, 'FEE_TRANSACTION_MISMATCH', 'Receipt sender or recipient differs from the pinned transaction.');
    const receiptNumber = rpcInteger(receipt.blockNumber, 'receipt.blockNumber');
    const finalized = block(await reader.send('eth_getBlockByNumber', ['finalized', false]), 'finalized');
    check(BigInt(finalized.number) >= receiptNumber, 'FEE_NOT_FINALIZED', 'Transaction is not finalized; retain reservations.');
    const rawBlock = await reader.send('eth_getBlockByNumber', [qty(receiptNumber), false]);
    const included = block(rawBlock, 'receipt');
    check(included.number === receiptNumber.toString() && included.hash === hash(receipt.blockHash, 'receipt.blockHash') && BigInt(finalized.timestamp) >= BigInt(included.timestamp) && (finalized.number !== included.number || finalized.hash === included.hash), 'FEE_CANONICALITY_CHANGED', 'Receipt is not bound to the canonical finalized history.');
    const index = rpcInteger(receipt.transactionIndex, 'receipt.transactionIndex', BigInt(Number.MAX_SAFE_INTEGER));
    check(Array.isArray(rawBlock.transactions) && typeof rawBlock.transactions[Number(index)] === 'string' && hash(rawBlock.transactions[Number(index)], 'block.transaction') === txHash, 'FEE_TRANSACTION_MISMATCH', 'The canonical block does not contain this transaction at its claimed index.');
    const gas = rpcInteger(receipt.gasUsed, 'receipt.gasUsed', MAX64);
    const effective = rpcInteger(receipt.effectiveGasPrice, 'receipt.effectiveGasPrice');
    check(gas >= 21000n && gas <= BigInt(normalized.gasLimit) && BigInt(included.baseFeePerGas) <= BigInt(normalized.maxFeePerGas), 'FEE_EVIDENCE_INVALID', 'Execution gas is below the ordinary transaction minimum or exceeds the signed envelope.');
    const effectiveExpected = BigInt(included.baseFeePerGas) + BigInt(normalized.maxPriorityFeePerGas);
    check(effective === (effectiveExpected < BigInt(normalized.maxFeePerGas) ? effectiveExpected : BigInt(normalized.maxFeePerGas)), 'FEE_EVIDENCE_INVALID', 'Effective gas price disagrees with the signed fee envelope and inclusion block.');
    check(receipt.l1Fee !== undefined, 'FEE_EVIDENCE_UNAVAILABLE', 'The raw receipt lacks the separately charged L1 data fee; retain reservations.');
    const l1 = rpcInteger(receipt.l1Fee, 'receipt.l1Fee');
    const evidence = await oracle(reader, included, gas);
    const scalar = BigInt(evidence.operatorFeeScalar), constant = BigInt(evidence.operatorFeeConstant);
    // OP receipts omit both operator fields when both parameters are zero.
    // Zero is accepted only with historical L1Block + GPO evidence above.
    if (receipt.operatorFeeScalar === undefined && receipt.operatorFeeConstant === undefined) {
      check(scalar === 0n && constant === 0n, 'FEE_EVIDENCE_UNAVAILABLE', 'Nonzero operator fee parameters are missing from the receipt.');
    } else {
      check(receipt.operatorFeeScalar !== undefined && receipt.operatorFeeConstant !== undefined, 'FEE_EVIDENCE_UNAVAILABLE', 'Operator receipt parameters are incomplete.');
      check(rpcInteger(receipt.operatorFeeScalar, 'receipt.operatorFeeScalar', (1n << 32n) - 1n) === scalar && rpcInteger(receipt.operatorFeeConstant, 'receipt.operatorFeeConstant', MAX64) === constant, 'FEE_OPERATOR_MISMATCH', 'Receipt operator parameters differ from historical chain state.');
    }
    const execution = bounded(gas * effective);
    const total = bounded(execution + l1 + BigInt(evidence.operatorFeeWei));
    await recheck(reader, included);
    if (included.number !== finalized.number) await recheck(reader, finalized);
    await chain(reader);
    return {
      schemaVersion: 1, kind: 'base-finalized-transaction-fees', chainId: BASE_SEPOLIA.chainId,
      transactionHash: txHash, transaction: normalized, ...transactionEncoding(normalized),
      blockNumber: included.number, blockHash: included.hash, transactionIndex: index.toString(), success: status === 1n,
      gasUsed: gas.toString(), effectiveGasPrice: effective.toString(),
      components: { executionWei: execution.toString(), l1DataWei: l1.toString(), operatorWei: evidence.operatorFeeWei },
      feeWei: total.toString(), totalFeeWei: total.toString(), oracle: evidence,
      receipt: structuredClone(receipt), canonicalBlock: included,
      finalized: true, finalityAnchor: finalized, doNotRepay: true,
      evidenceTrust: 'Single trusted RPC reports canonical finalized receipt and historical fee state; no independent consensus proof.',
    };
  });
}
