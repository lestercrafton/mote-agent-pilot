import { Transaction, getBytes, keccak256, toUtf8Bytes } from 'ethers';
import { ETHEREUM_SEPOLIA, createEthereumSepoliaReader } from './testnet-rpc.mjs';

// Reviewed 2026-10-30: EIP-1559 caps the complete network fee for this ordinary
// zero-value Ethereum type-2 profile. Base's separate fees remain unsupported.
// https://eips.ethereum.org/EIPS/eip-1559
// https://eips.ethereum.org/EIPS/eip-7623
// https://eips.ethereum.org/EIPS/eip-2780
// https://eips.ethereum.org/EIPS/eip-7976
// https://eips.ethereum.org/EIPS/eip-8037
// https://github.com/ethereum/go-ethereum/blob/v1.17.7/core/state_transition.go
export const ETHEREUM_FEE_POLICY = Object.freeze({
  reviewedFeeProfile: 'ethereum-type2-geth-v1.17.7',
  // Deliberately narrower than Amsterdam's total gas limit (2^32 - 1).
  // 2^24 is now the protocol execution-gas cap, not its total-gas cap.
  maximumTransactionGas: '16777216', minimumTransactionGas: '21000',
  maximumCalldataBytes: 65_536,
  pragueTimestamp: '1741159776', amsterdamTimestamp: '1791294816',
});
const MAX256 = (1n << 256n) - 1n;
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DATA = /^0x(?:[0-9a-fA-F]{2})*$/;
const FIELDS = ['type', 'chainId', 'from', 'to', 'nonce', 'gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas', 'value', 'data'];
const EVIDENCE_FIELDS = ['schemaVersion', 'kind', 'feeModel', 'chainId', 'transaction', 'transactionFingerprint', 'unsignedTransactionBytes', 'anchor', 'sender', 'gasRules', 'components', 'estimatedTotalAtAnchorWei', 'reservationUpperBoundWei', 'hardTotalCapEnforced', 'publicSubmissionAllowed'];
const EXTRA_TX_FIELDS = ['authorizationList', 'blobVersionedHashes', 'blobs', 'maxFeePerBlobGas', 'sidecar'];
const EXTRA_RECEIPT_FIELDS = ['l1Fee', 'operatorFeeScalar', 'operatorFeeConstant', 'depositNonce', 'depositReceiptVersion'];

export class EthereumFeeError extends Error {
  constructor(code, message, cause) {
    super(message, { cause }); this.name = 'EthereumFeeError'; this.code = code;
    this.doNotReleaseReservation = true; this.doNotRepay = true;
  }
}
const fail = (code, message, cause) => { throw new EthereumFeeError(code, message, cause); };
const check = (value, code, message) => { if (!value) fail(code, message); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const qty = value => '0x' + value.toString(16);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function fields(value, names, label) {
  check(plain(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name)), 'FEE_INPUT_INVALID', `${label} requires exactly the supported public fields.`);
}
function decimal(value, label, maximum = MAX256) {
  check(typeof value === 'string' && UINT.test(value) && BigInt(value) <= maximum, 'FEE_INPUT_INVALID', `${label} must be a bounded unsigned decimal integer string.`);
  return BigInt(value);
}
function rpcInteger(value, label, maximum = MAX256) {
  check(typeof value === 'string' && QUANTITY.test(value) && BigInt(value) <= maximum, 'FEE_EVIDENCE_INVALID', `${label} must be a canonical bounded JSON-RPC quantity.`);
  return BigInt(value);
}
function address(value, label) {
  check(typeof value === 'string' && ADDRESS.test(value) && !/^0x0{40}$/i.test(value), 'FEE_INPUT_INVALID', `${label} must be a nonzero exact EVM address.`);
  return value.toLowerCase();
}
function hash(value, label) {
  check(typeof value === 'string' && HASH.test(value), 'FEE_EVIDENCE_INVALID', `${label} must be a 32-byte hash.`);
  return value.toLowerCase();
}
function signatureScalar(value, label) {
  check(typeof value === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(value) && BigInt(value) > 0n, 'FEE_SIGNATURE_INVALID', `${label} must be a nonzero bounded ECDSA scalar.`);
  // JSON-RPC clients may return r/s as integer quantities rather than bytes32.
  // Normalize only the representation; ECDSA recovery still checks the value.
  return '0x' + BigInt(value).toString(16).padStart(64, '0');
}
const bounded = value => { check(value >= 0n && value <= MAX256, 'FEE_EVIDENCE_INVALID', 'Fee arithmetic exceeds uint256.'); return value; };

/** Exact intent: no deployment, self-call, access list, authorization list,
 * blob, native value, fee population, nonce selection, or alternate chain. */
export function normalizeEthereumFeeTransaction(input) {
  fields(input, FIELDS, 'Transaction');
  check(input.type === 2 && input.chainId === ETHEREUM_SEPOLIA.chainId && input.value === '0', 'FEE_INPUT_INVALID', 'Only zero-value Ethereum Sepolia type-2 transactions are supported.');
  const output = { type: 2, chainId: ETHEREUM_SEPOLIA.chainId, from: address(input.from, 'from'), to: address(input.to, 'to') };
  check(output.from !== output.to, 'FEE_INPUT_INVALID', 'Self-calls are outside the ordinary payment profile.');
  for (const key of ['nonce', 'gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas', 'value']) {
    const maximum = key === 'nonce' ? BigInt(Number.MAX_SAFE_INTEGER) : key === 'gasLimit' ? BigInt(ETHEREUM_FEE_POLICY.maximumTransactionGas) : MAX256;
    output[key] = decimal(input[key], key, maximum).toString();
  }
  check(BigInt(output.gasLimit) >= BigInt(ETHEREUM_FEE_POLICY.minimumTransactionGas) && BigInt(output.maxFeePerGas) > 0n && BigInt(output.maxPriorityFeePerGas) <= BigInt(output.maxFeePerGas), 'FEE_INPUT_INVALID', 'Application gas and EIP-1559 fee limits are invalid.');
  check(typeof input.data === 'string' && DATA.test(input.data) && getBytes(input.data).length <= ETHEREUM_FEE_POLICY.maximumCalldataBytes, 'FEE_INPUT_INVALID', 'Transaction calldata must be bounded hexadecimal.');
  output.data = input.data.toLowerCase();
  bounded(BigInt(output.gasLimit) * BigInt(output.maxFeePerGas));
  return output;
}

function unsigned(transaction) {
  return {
    type: 2, chainId: transaction.chainId, to: transaction.to, nonce: Number(transaction.nonce),
    gasLimit: BigInt(transaction.gasLimit), maxFeePerGas: BigInt(transaction.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(transaction.maxPriorityFeePerGas), value: 0n,
    data: transaction.data, accessList: [],
  };
}
function encoding(transaction) {
  return { transactionFingerprint: keccak256(toUtf8Bytes(JSON.stringify(transaction))), unsignedTransactionBytes: getBytes(Transaction.from(unsigned(transaction)).unsignedSerialized).length };
}

function gasRules(transaction, timestamp) {
  const bytes = getBytes(transaction.data);
  let zero = 0n; for (const byte of bytes) if (byte === 0) zero++;
  const size = BigInt(bytes.length), tokens = zero + 4n * (size - zero);
  const amsterdam = timestamp >= BigInt(ETHEREUM_FEE_POLICY.amsterdamTimestamp);
  const prague = timestamp >= BigInt(ETHEREUM_FEE_POLICY.pragueTimestamp);
  const base = amsterdam ? 15000n : 21000n; // Non-self, zero-value, no access list.
  const intrinsic = base + 4n * tokens;
  const floor = amsterdam ? base + 64n * size : prague ? base + 10n * tokens : intrinsic;
  return {
    fork: amsterdam ? 'amsterdam' : prague ? 'prague' : 'pre-prague',
    calldataBytes: bytes.length, intrinsicGas: intrinsic.toString(), calldataReservationFloor: floor.toString(),
    minimumInclusionGas: (intrinsic > floor ? intrinsic : floor).toString(),
    applicationGasLimitMaximum: ETHEREUM_FEE_POLICY.maximumTransactionGas,
  };
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
  check(rpcInteger(await reader.send('eth_chainId', []), 'chainId') === BigInt(ETHEREUM_SEPOLIA.chainId), 'FEE_CHAIN_MISMATCH', 'Fee evidence must come from Ethereum Sepolia chain 11155111.');
}
async function recheck(reader, anchor) {
  const again = block(await reader.send('eth_getBlockByNumber', [anchor.numberHex, false]), 'canonical');
  check(equal(again, anchor), 'FEE_CANONICALITY_CHANGED', 'The fee evidence block changed; retain reservations.');
}
async function bareSender(reader, transaction, anchor) {
  const code = await reader.send('eth_getCode', [transaction.from, anchor.numberHex]);
  check(code === '0x', 'FEE_SENDER_UNSUPPORTED', 'The supported payer must have no code or EIP-7702 delegation at the observed state.');
  return { address: transaction.from, code: '0x', atBlockNumber: anchor.number, atBlockHash: anchor.hash };
}
async function guarded(work) {
  try { return await work(); }
  catch (error) {
    if (error instanceof EthereumFeeError) throw error;
    fail('FEE_EVIDENCE_UNAVAILABLE', 'Complete canonical Ethereum fee evidence is unavailable; retain reservations.', error);
  }
}

/** Computes a protocol-enforced network fee bound, not an execution-success
 * gas estimate. Chain/deployment, payer permissions, and budgets are separate. */
export async function estimateEthereumFees({ reader = createEthereumSepoliaReader(), transaction, blockTag = 'latest' } = {}) {
  return guarded(async () => {
    const normalized = normalizeEthereumFeeTransaction(transaction);
    check(['latest', 'safe', 'finalized'].includes(blockTag), 'FEE_INPUT_INVALID', 'Use an explicit latest, safe or finalized observation tag.');
    await chain(reader);
    const anchor = block(await reader.send('eth_getBlockByNumber', [blockTag, false]), blockTag);
    const rules = gasRules(normalized, BigInt(anchor.timestamp));
    check(BigInt(normalized.gasLimit) >= BigInt(rules.minimumInclusionGas), 'FEE_GAS_LIMIT_BELOW_FLOOR', 'The signed gas limit does not reserve the inclusion/calldata floor at this fork.');
    check(BigInt(normalized.maxFeePerGas) >= BigInt(anchor.baseFeePerGas), 'FEE_MAX_BELOW_BASE', 'Maximum fee is below the observed base fee; no transaction field is automatically increased.');
    const sender = await bareSender(reader, normalized, anchor);
    const cap = bounded(BigInt(normalized.gasLimit) * BigInt(normalized.maxFeePerGas)).toString();
    await recheck(reader, anchor); await chain(reader);
    return freeze({
      schemaVersion: 1, kind: 'ethereum-fee-bound', feeModel: 'ethereum-eip1559', chainId: ETHEREUM_SEPOLIA.chainId,
      transaction: normalized, ...encoding(normalized), anchor: { ...anchor, requestedTag: blockTag }, sender, gasRules: rules,
      components: { executionMaxWei: cap, l1DataUpperBoundEstimateWei: '0', operatorAtGasLimitWei: '0' },
      estimatedTotalAtAnchorWei: cap, reservationUpperBoundWei: cap,
      hardTotalCapEnforced: true, publicSubmissionAllowed: false,
    });
  });
}

/** All amounts and bindings are recomputed. Flags are descriptive, not an
 * authority input. This synchronous check grants only the fee-policy boundary. */
export function assertEthereumFeeCap({ transaction, evidence, maxFeeWei } = {}) {
  const normalized = normalizeEthereumFeeTransaction(transaction);
  const maximum = decimal(maxFeeWei, 'maxFeeWei');
  fields(evidence, EVIDENCE_FIELDS, 'Fee evidence');
  const normalizedEvidence = normalizeEthereumFeeTransaction(evidence.transaction);
  check(equal(normalized, normalizedEvidence), 'FEE_TRANSACTION_MISMATCH', 'Fee evidence does not bind the exact transaction intent.');
  const encoded = encoding(normalized), cap = bounded(BigInt(normalized.gasLimit) * BigInt(normalized.maxFeePerGas));
  check(evidence.schemaVersion === 1 && evidence.kind === 'ethereum-fee-bound' && evidence.feeModel === 'ethereum-eip1559' && evidence.chainId === ETHEREUM_SEPOLIA.chainId && evidence.transactionFingerprint === encoded.transactionFingerprint && evidence.unsignedTransactionBytes === encoded.unsignedTransactionBytes, 'FEE_CAP_EVIDENCE_INVALID', 'Fee model, encoding or transaction fingerprint differs from the exact Ethereum intent.');
  fields(evidence.anchor, ['number', 'numberHex', 'hash', 'parentHash', 'timestamp', 'baseFeePerGas', 'requestedTag'], 'Fee anchor');
  const anchor = evidence.anchor;
  check(qty(decimal(anchor.number, 'anchor.number')) === anchor.numberHex && ['latest', 'safe', 'finalized'].includes(anchor.requestedTag), 'FEE_CAP_EVIDENCE_INVALID', 'Fee anchor is malformed.');
  hash(anchor.hash, 'anchor.hash'); hash(anchor.parentHash, 'anchor.parentHash');
  check(decimal(anchor.baseFeePerGas, 'anchor.baseFeePerGas') <= BigInt(normalized.maxFeePerGas), 'FEE_CAP_EVIDENCE_INVALID', 'Observed base fee exceeds the authorized envelope.');
  const rules = gasRules(normalized, decimal(anchor.timestamp, 'anchor.timestamp'));
  check(equal(evidence.gasRules, rules) && BigInt(normalized.gasLimit) >= BigInt(rules.minimumInclusionGas), 'FEE_CAP_EVIDENCE_INVALID', 'Fee evidence does not match the fork-specific inclusion floor.');
  check(equal(evidence.sender, { address: normalized.from, code: '0x', atBlockNumber: anchor.number, atBlockHash: anchor.hash }), 'FEE_CAP_EVIDENCE_INVALID', 'Sender observation is not bound to this intent and anchor.');
  check(equal(evidence.components, { executionMaxWei: cap.toString(), l1DataUpperBoundEstimateWei: '0', operatorAtGasLimitWei: '0' }) && evidence.reservationUpperBoundWei === cap.toString() && evidence.estimatedTotalAtAnchorWei === cap.toString() && evidence.hardTotalCapEnforced === true && evidence.publicSubmissionAllowed === false, 'FEE_CAP_EVIDENCE_INVALID', 'Fee components or reserved upper bound differ from the signed gas envelope.');
  check(cap <= maximum, 'FEE_POLICY_LIMIT', 'Exact transaction gas ceiling exceeds the independently supplied fee policy.');
  return freeze({ transaction: normalized, transactionFingerprint: encoded.transactionFingerprint, reservationUpperBoundWei: cap.toString(), feeBoundarySatisfied: true });
}

function bindTransaction(value, expected, transactionHash, receipt) {
  check(plain(value) && hash(value.hash, 'transaction.hash') === transactionHash, 'FEE_TRANSACTION_MISMATCH', 'Transaction evidence does not match the requested hash.');
  check(rpcInteger(value.type, 'transaction.type') === 2n && rpcInteger(value.chainId, 'transaction.chainId') === BigInt(ETHEREUM_SEPOLIA.chainId) && Array.isArray(value.accessList) && value.accessList.length === 0 && EXTRA_TX_FIELDS.every(key => !Object.hasOwn(value, key)), 'FEE_TRANSACTION_MISMATCH', 'Only the ordinary type-2 empty-access-list profile is supported.');
  const actual = normalizeEthereumFeeTransaction({
    type: 2, chainId: ETHEREUM_SEPOLIA.chainId, from: value.from, to: value.to,
    nonce: rpcInteger(value.nonce, 'transaction.nonce').toString(), gasLimit: rpcInteger(value.gas, 'transaction.gas').toString(),
    maxFeePerGas: rpcInteger(value.maxFeePerGas, 'transaction.maxFeePerGas').toString(),
    maxPriorityFeePerGas: rpcInteger(value.maxPriorityFeePerGas, 'transaction.maxPriorityFeePerGas').toString(),
    value: rpcInteger(value.value, 'transaction.value').toString(), data: value.input,
  });
  check(equal(actual, expected), 'FEE_TRANSACTION_MISMATCH', 'Transaction differs from the pinned sender, recipient, calldata, nonce, value or fee envelope.');
  check(hash(value.blockHash, 'transaction.blockHash') === hash(receipt.blockHash, 'receipt.blockHash') && rpcInteger(value.blockNumber, 'transaction.blockNumber') === rpcInteger(receipt.blockNumber, 'receipt.blockNumber') && rpcInteger(value.transactionIndex, 'transaction.transactionIndex') === rpcInteger(receipt.transactionIndex, 'receipt.transactionIndex'), 'FEE_TRANSACTION_MISMATCH', 'Transaction and receipt block bindings differ.');
  try {
    const parity = rpcInteger(value.yParity ?? value.v, 'transaction.yParity', 1n);
    if (value.v !== undefined) check(rpcInteger(value.v, 'transaction.v', 1n) === parity, 'FEE_SIGNATURE_INVALID', 'Typed transaction parity fields disagree.');
    const signed = Transaction.from({ ...unsigned(actual), signature: { r: signatureScalar(value.r, 'transaction.r'), s: signatureScalar(value.s, 'transaction.s'), yParity: Number(parity) } });
    check(signed.hash === transactionHash && signed.from?.toLowerCase() === actual.from, 'FEE_SIGNATURE_INVALID', 'ECDSA signature or serialized transaction hash differs from the pinned payer intent.');
  } catch (error) {
    if (error instanceof EthereumFeeError) throw error;
    fail('FEE_SIGNATURE_INVALID', 'A canonical recoverable type-2 ECDSA signature is required.', error);
  }
}

/** Reverts also consume fees. A successful fee proof is not a Mote Paid proof
 * and does not itself change a journal, resubmit a transaction, or deliver work. */
export async function actualEthereumFees({ reader = createEthereumSepoliaReader(), transactionHash, expectedTransaction } = {}) {
  return guarded(async () => {
    const normalized = normalizeEthereumFeeTransaction(expectedTransaction), txHash = hash(transactionHash, 'transactionHash');
    await chain(reader);
    const receipt = await reader.send('eth_getTransactionReceipt', [txHash]);
    check(receipt !== null, 'FEE_PENDING', 'Receipt is not yet available; retain reservations and do not resend.');
    check(plain(receipt), 'FEE_EVIDENCE_INVALID', 'Receipt response is malformed; retain reservations.');
    check(hash(receipt.transactionHash, 'receipt.transactionHash') === txHash && rpcInteger(receipt.type, 'receipt.type') === 2n && receipt.contractAddress === null, 'FEE_TRANSACTION_MISMATCH', 'Receipt does not describe the exact ordinary transaction.');
    check(EXTRA_RECEIPT_FIELDS.every(key => !Object.hasOwn(receipt, key)) && ['blobGasUsed', 'blobGasPrice'].every(key => receipt[key] === undefined || rpcInteger(receipt[key], key) === 0n), 'FEE_EVIDENCE_UNSUPPORTED', 'Unexpected separate fee or deposit fields cannot be silently omitted.');
    const status = rpcInteger(receipt.status, 'receipt.status');
    check(status === 0n || status === 1n, 'FEE_EVIDENCE_INVALID', 'Receipt status must be success or revert.');
    const tx = await reader.send('eth_getTransactionByHash', [txHash]);
    bindTransaction(tx, normalized, txHash, receipt);
    check(address(receipt.from, 'receipt.from') === normalized.from && address(receipt.to, 'receipt.to') === normalized.to, 'FEE_TRANSACTION_MISMATCH', 'Receipt sender or recipient differs from the pinned transaction.');
    const number = rpcInteger(receipt.blockNumber, 'receipt.blockNumber');
    check(number > 0n, 'FEE_EVIDENCE_INVALID', 'Ordinary payment receipts cannot be in genesis.');
    const finalized = block(await reader.send('eth_getBlockByNumber', ['finalized', false]), 'finalized');
    check(BigInt(finalized.number) >= number, 'FEE_NOT_FINALIZED', 'Transaction is not finalized; retain reservations.');
    const rawBlock = await reader.send('eth_getBlockByNumber', [qty(number), false]), included = block(rawBlock, 'receipt');
    check(included.number === number.toString() && included.hash === hash(receipt.blockHash, 'receipt.blockHash') && BigInt(finalized.timestamp) >= BigInt(included.timestamp) && (finalized.number !== included.number || finalized.hash === included.hash), 'FEE_CANONICALITY_CHANGED', 'Receipt is not bound to canonical finalized history.');
    const index = rpcInteger(receipt.transactionIndex, 'receipt.transactionIndex', BigInt(Number.MAX_SAFE_INTEGER));
    check(Array.isArray(rawBlock.transactions) && typeof rawBlock.transactions[Number(index)] === 'string' && hash(rawBlock.transactions[Number(index)], 'block.transaction') === txHash, 'FEE_TRANSACTION_MISMATCH', 'Canonical block does not contain the exact transaction at its claimed index.');
    const parent = block(await reader.send('eth_getBlockByNumber', [qty(number - 1n), false]), 'parent');
    check(parent.number === (number - 1n).toString() && parent.hash === included.parentHash && BigInt(parent.timestamp) < BigInt(included.timestamp), 'FEE_CANONICALITY_CHANGED', 'Receipt parent block binding is inconsistent.');
    await bareSender(reader, normalized, parent); await bareSender(reader, normalized, included);
    const gas = rpcInteger(receipt.gasUsed, 'receipt.gasUsed'), effective = rpcInteger(receipt.effectiveGasPrice, 'receipt.effectiveGasPrice');
    check(gas > 0n && gas <= BigInt(normalized.gasLimit) && BigInt(included.baseFeePerGas) <= BigInt(normalized.maxFeePerGas), 'FEE_EVIDENCE_INVALID', 'Gas or base fee is outside the signed envelope.');
    // Inclusion gas reservations are not a generic historical receipt lower
    // bound. Amsterdam also changes the old blanket 21000 assumption.
    const rules = gasRules(normalized, BigInt(included.timestamp));
    check(BigInt(normalized.gasLimit) >= BigInt(rules.minimumInclusionGas), 'FEE_EVIDENCE_INVALID', 'Signed gas limit was below the inclusion floor at its mined fork.');
    const expectedEffective = BigInt(included.baseFeePerGas) + BigInt(normalized.maxPriorityFeePerGas);
    check(effective === (expectedEffective < BigInt(normalized.maxFeePerGas) ? expectedEffective : BigInt(normalized.maxFeePerGas)), 'FEE_EVIDENCE_INVALID', 'Effective gas price disagrees with the signed envelope and inclusion base fee.');
    const total = bounded(gas * effective), cap = bounded(BigInt(normalized.gasLimit) * BigInt(normalized.maxFeePerGas));
    check(total <= cap, 'FEE_EVIDENCE_INVALID', 'Observed fee exceeds its signed protocol ceiling.');
    await recheck(reader, parent); await recheck(reader, included);
    if (included.number !== finalized.number) await recheck(reader, finalized);
    const ending = block(await reader.send('eth_getBlockByNumber', ['finalized', false]), 'ending finalized');
    check(BigInt(ending.number) >= BigInt(finalized.number) && BigInt(ending.timestamp) >= BigInt(finalized.timestamp) && (ending.number !== finalized.number || equal(ending, finalized)), 'FEE_CANONICALITY_CHANGED', 'Finalized history regressed or changed during fee verification; retain reservations.');
    await recheck(reader, ending);
    await chain(reader);
    return freeze({
      schemaVersion: 1, kind: 'ethereum-finalized-transaction-fees', feeModel: 'ethereum-eip1559', chainId: ETHEREUM_SEPOLIA.chainId,
      transactionHash: txHash, transaction: normalized, ...encoding(normalized),
      blockNumber: included.number, blockHash: included.hash, transactionIndex: index.toString(), success: status === 1n,
      gasUsed: gas.toString(), effectiveGasPrice: effective.toString(),
      components: { executionWei: total.toString(), l1DataWei: '0', operatorWei: '0' },
      feeWei: total.toString(), totalFeeWei: total.toString(), reservationUpperBoundWei: cap.toString(),
      receipt: structuredClone(receipt), canonicalBlock: included, parentBlock: parent, gasRules: rules,
      finalized: true, finalityAnchor: finalized, doNotRepay: true,
      evidenceTrust: 'Single trusted RPC reports canonical finalized state; ECDSA transaction hash independently reconstructed. No independent consensus proof.',
    });
  });
}
