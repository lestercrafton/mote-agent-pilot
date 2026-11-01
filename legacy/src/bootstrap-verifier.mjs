import { Interface, Transaction, ZeroAddress, ZeroHash, getBytes, getCreateAddress, keccak256 } from 'ethers';
import { validateBootstrapPlan } from './bootstrap-plan.mjs';
import { canonicalStringify } from './json.mjs';
import { ETHEREUM_SEPOLIA, createEthereumSepoliaReader } from './testnet-rpc.mjs';
import { ETHEREUM_FEE_POLICY } from './ethereum-fees.mjs';

// Read-only, exact five-step bootstrap profile. This does not broaden the
// zero-value payment client or grant permission to sign/broadcast anything.
// Reviewed 2026-10-30: EIP-1559; EIP-8037 receipt semantics; Geth v1.17.7
// core/state_transition.go settleGas and core/state_processor.go receipt creation.
// Receipt gasUsed already includes charged execution AND state gas, including
// creation/new-account charges. Native transferred value is accounted separately.
// https://eips.ethereum.org/EIPS/eip-1559
// https://eips.ethereum.org/EIPS/eip-8037#receipt-semantics
// https://github.com/ethereum/go-ethereum/blob/v1.17.7/core/state_transition.go
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DATA = /^0x(?:[0-9a-fA-F]{2})*$/;
const QTY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/;
const MAX = (1n << 256n) - 1n;
const EXTRA_TX = ['authorizationList', 'blobVersionedHashes', 'blobs', 'maxFeePerBlobGas', 'sidecar'];
const EXTRA_FEES = ['l1Fee', 'operatorFeeScalar', 'operatorFeeConstant', 'depositNonce', 'depositReceiptVersion'];
const same = (a, b) => canonicalStringify(a) === canonicalStringify(b);
const hex = n => `0x${BigInt(n).toString(16)}`;
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
export class BootstrapVerificationError extends Error {
  constructor(code, message, cause) {
    super(message, { cause }); this.name = 'BootstrapVerificationError'; this.code = code;
    this.doNotResubmit = true; this.doNotRepay = true; this.doNotReleaseReservation = true;
  }
}
function check(ok, code, message) { if (!ok) throw new BootstrapVerificationError(code, message); }
function quantity(v, label, max = MAX) { check(typeof v === 'string' && QTY.test(v) && BigInt(v) <= max, 'BOOTSTRAP_EVIDENCE', `${label} must be a bounded canonical RPC quantity`); return BigInt(v); }
function hash(v, label) { check(typeof v === 'string' && HASH.test(v), 'BOOTSTRAP_EVIDENCE', `${label} must be a 32-byte hash`); return v.toLowerCase(); }
function address(v, label) { check(typeof v === 'string' && ADDRESS.test(v), 'BOOTSTRAP_EVIDENCE', `${label} must be an address`); return v.toLowerCase(); }
function scalar(v) { check(typeof v === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(v) && BigInt(v) > 0n, 'BOOTSTRAP_SIGNATURE', 'Nonzero bounded ECDSA scalars are required'); return `0x${BigInt(v).toString(16).padStart(64, '0')}`; }
function block(v, label, expectedNumber) {
  check(plain(v), 'BOOTSTRAP_EVIDENCE', `${label} block is unavailable`);
  const number = quantity(v.number, `${label}.number`).toString();
  check(expectedNumber === undefined || number === BigInt(expectedNumber).toString(), 'BOOTSTRAP_REORG', `${label} block number changed`);
  return { blockNumber: number, blockHash: hash(v.hash, `${label}.hash`), parentHash: hash(v.parentHash, `${label}.parentHash`),
    timestamp: quantity(v.timestamp, `${label}.timestamp`).toString(), baseFeePerGas: quantity(v.baseFeePerGas, `${label}.baseFeePerGas`).toString() };
}
function unsigned(tx) { return { type: 2, chainId: tx.chainId, to: tx.to, nonce: Number(tx.nonce), value: BigInt(tx.value), data: tx.data,
  gasLimit: BigInt(tx.gasLimit), maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas), accessList: [] }; }

function gasRequirements(plan, index, timestamp) {
  check(Number.isSafeInteger(index) && index >= 0 && index < 5, 'BOOTSTRAP_INPUT', 'Only five exact bootstrap steps have reviewed gas requirements');
  check(typeof timestamp === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(timestamp) && BigInt(timestamp) <= MAX,
    'BOOTSTRAP_INPUT', 'Timestamp must be a bounded decimal integer');
  const tx = plan.transactions[index].transaction, bytes = getBytes(tx.data), size = BigInt(bytes.length);
  let zero = 0n; for (const byte of bytes) if (byte === 0) zero++;
  const tokens = zero + 4n * (size - zero), creation = index < 3;
  const amsterdam = BigInt(timestamp) >= BigInt(ETHEREUM_FEE_POLICY.amsterdamTimestamp);
  const prague = BigInt(timestamp) >= BigInt(ETHEREUM_FEE_POLICY.pragueTimestamp);
  const base = amsterdam ? (creation ? 24000n : index === 4 ? 21000n : 15000n) : creation ? 53000n : 21000n;
  const intrinsic = base + tokens * 4n + (creation ? 2n * ((size + 31n) / 32n) : 0n);
  const calldataFloor = amsterdam ? base + 64n * size : prague ? 21000n + 10n * tokens : intrinsic;
  const runtimeBytes = creation ? BigInt(getBytes(plan.contracts[['token', 'router', 'dispenser'][index]].deployedBytecode).length) : 0n;
  // Exact sources initialize four token slots (name/symbol/supply/holder
  // balance), no router storage slots, and one dispenser guard slot. Funding
  // assumes a new balance slot; native allocation assumes a fresh account.
  // These are intentionally only known work components, not all EVM execution.
  const slots = [4n, 0n, 1n, 1n, 0n][index];
  const state = amsterdam ? ((creation ? runtimeBytes + 120n : index === 4 ? 120n : 0n) + slots * 64n) * 1530n : 0n;
  const codeHashExecution = amsterdam && creation ? 6n * ((runtimeBytes + 31n) / 32n) : 0n;
  const knownWork = intrinsic + state + codeHashExecution;
  const minimum = knownWork > calldataFloor ? knownWork : calldataFloor;
  return freeze({ reviewedProfile: ETHEREUM_FEE_POLICY.reviewedFeeProfile, fork: amsterdam ? 'amsterdam' : prague ? 'prague' : 'pre-prague',
    intrinsicGas: intrinsic.toString(), calldataFloorGas: calldataFloor.toString(), freshStateGas: state.toString(),
    knownCodeHashGas: codeHashExecution.toString(), knownWorkFloorGas: minimum.toString(), plannedGasLimit: tx.gasLimit,
    knownWorkFits: BigInt(tx.gasLimit) >= minimum, assumesFreshState: true, executionSufficiencyVerified: false,
    furtherRequirement: 'A successful current-fork RPC estimate for the unchanged exact transaction within its signed gas limit is still required before signing.' });
}

/** Offline necessary bounds only. This is not an execution estimate or authority. */
export function bootstrapGasRequirements({ plan, index, timestamp } = {}) {
  return gasRequirements(validateBootstrapPlan(structuredClone(plan)), index, timestamp);
}
function bindTransaction(raw, receipt, expected, txHash) {
  check(plain(raw) && hash(raw.hash, 'tx.hash') === txHash, 'BOOTSTRAP_TRANSACTION', 'Exact transaction is unavailable');
  check(quantity(raw.type, 'tx.type') === 2n && quantity(raw.chainId, 'tx.chainId') === 11155111n
    && Array.isArray(raw.accessList) && raw.accessList.length === 0 && EXTRA_TX.every(k => !Object.hasOwn(raw, k)),
  'BOOTSTRAP_TRANSACTION', 'Only exact type-2 transactions without access lists, blobs or authorizations are supported');
  const actual = { type: 2, chainId: 11155111, from: address(raw.from, 'tx.from'), to: raw.to === null ? null : address(raw.to, 'tx.to'),
    nonce: quantity(raw.nonce, 'tx.nonce', BigInt(Number.MAX_SAFE_INTEGER)).toString(), value: quantity(raw.value, 'tx.value').toString(), data: raw.input,
    gasLimit: quantity(raw.gas, 'tx.gas').toString(), maxFeePerGas: quantity(raw.maxFeePerGas, 'tx.maxFeePerGas').toString(),
    maxPriorityFeePerGas: quantity(raw.maxPriorityFeePerGas, 'tx.maxPriorityFeePerGas').toString(), accessList: [] };
  check(typeof actual.data === 'string' && DATA.test(actual.data), 'BOOTSTRAP_TRANSACTION', 'Transaction input is not hexadecimal');
  actual.data = actual.data.toLowerCase();
  check(same(actual, expected), 'BOOTSTRAP_TRANSACTION', 'Transaction differs from the exact reviewed source, role, nonce, value or fee envelope');
  check(hash(raw.blockHash, 'tx.blockHash') === hash(receipt.blockHash, 'receipt.blockHash')
    && quantity(raw.blockNumber, 'tx.blockNumber') === quantity(receipt.blockNumber, 'receipt.blockNumber')
    && quantity(raw.transactionIndex, 'tx.index') === quantity(receipt.transactionIndex, 'receipt.index'),
  'BOOTSTRAP_TRANSACTION', 'Transaction and receipt are not bound to the same block and index');
  try {
    const parity = quantity(raw.yParity ?? raw.v, 'tx.yParity', 1n);
    if (raw.v !== undefined) check(quantity(raw.v, 'tx.v', 1n) === parity, 'BOOTSTRAP_SIGNATURE', 'Signature parity fields disagree');
    const signed = Transaction.from({ ...unsigned(actual), signature: { r: scalar(raw.r), s: scalar(raw.s), yParity: Number(parity) } });
    check(signed.hash === txHash && signed.from?.toLowerCase() === expected.from, 'BOOTSTRAP_SIGNATURE', 'Signed hash or recovered sender differs from the planned operator');
  } catch (error) { if (error instanceof BootstrapVerificationError) throw error; throw new BootstrapVerificationError('BOOTSTRAP_SIGNATURE', 'Canonical ECDSA reconstruction failed', error); }
}

function matchingRuntime(code, artifact) {
  check(typeof code === 'string' && DATA.test(code) && code !== '0x' && code.length === artifact.deployedBytecode.length,
    'BOOTSTRAP_RUNTIME', 'Created runtime is missing or has a different size');
  const actual = getBytes(code), expected = getBytes(artifact.deployedBytecode);
  for (const refs of Object.values(artifact.immutableReferences)) for (const { start, length } of refs) {
    check(Number.isSafeInteger(start) && Number.isSafeInteger(length) && length > 0 && start >= 0 && start + length <= actual.length,
      'BOOTSTRAP_RUNTIME', 'Invalid compiler immutable references');
    actual.fill(0, start, start + length); expected.fill(0, start, start + length);
  }
  check(keccak256(actual) === keccak256(expected), 'BOOTSTRAP_RUNTIME', 'Runtime differs from the exact source template outside compiler immutable slots');
  return keccak256(code);
}
function verifyTransfer(receipt, included, txHash, token, from, to, amount) {
  const abi = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const event = abi.encodeEventLog(abi.getEvent('Transfer'), [from, to, amount]);
  const candidates = receipt.logs.filter(log => typeof log.address === 'string' && log.address.toLowerCase() === token
    && Array.isArray(log.topics) && log.topics[0]?.toLowerCase() === event.topics[0].toLowerCase());
  check(candidates.length === 1, 'BOOTSTRAP_EVENT', 'Exactly one matching token Transfer event is required');
  const log = candidates[0];
  check(log.removed === false && hash(log.transactionHash, 'log.tx') === txHash && hash(log.blockHash, 'log.block') === included.blockHash
    && quantity(log.blockNumber, 'log.number').toString() === included.blockNumber
    && quantity(log.transactionIndex, 'log.index') === quantity(receipt.transactionIndex, 'receipt.index')
    && typeof log.data === 'string' && log.data.toLowerCase() === event.data.toLowerCase()
    && log.topics.every(v => typeof v === 'string' && HASH.test(v)) && same(log.topics.map(v => v.toLowerCase()), event.topics.map(v => v.toLowerCase())),
  'BOOTSTRAP_EVENT', 'Token event is not canonically encoded and bound to this receipt');
  const indices = receipt.logs.map(entry => quantity(entry.logIndex, 'receipt.logIndex').toString());
  check(new Set(indices).size === indices.length, 'BOOTSTRAP_EVENT', 'Duplicate numerical event index');
  return quantity(log.logIndex, 'log.logIndex').toString();
}

async function verify(options, fixture) {
  try {
    check(plain(options) && Object.keys(options).every(k => ['plan', 'index', 'transactionHash', 'reader', 'finalizedAnchor'].includes(k)), 'BOOTSTRAP_INPUT', 'Unknown verifier option');
    // Snapshot before the first await; caller mutation cannot change the intent.
    const plan = validateBootstrapPlan(structuredClone(options.plan));
    const index = options.index, txHash = hash(options.transactionHash, 'transactionHash');
    let historicalAnchor = null;
    if (options.finalizedAnchor !== undefined) {
      const anchor = options.finalizedAnchor;
      check(plain(anchor) && Object.keys(anchor).length === 2 && Object.hasOwn(anchor, 'blockNumber') && Object.hasOwn(anchor, 'blockHash')
        && typeof anchor.blockNumber === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(anchor.blockNumber) && BigInt(anchor.blockNumber) <= MAX,
      'BOOTSTRAP_INPUT', 'Stored finalized anchor requires exactly a canonical decimal block number and block hash');
      historicalAnchor = { blockNumber: anchor.blockNumber, blockHash: hash(anchor.blockHash, 'stored finalized hash') };
    }
    check(Number.isSafeInteger(index) && index >= 0 && index < 5, 'BOOTSTRAP_INPUT', 'Only the five planned operator steps can be verified');
    const reader = fixture?.reader ?? options.reader ?? createEthereumSepoliaReader();
    check(reader && typeof reader.send === 'function', 'BOOTSTRAP_INPUT', 'A read-only RPC reader is required');
    check(!fixture || options.reader === undefined || options.reader === reader, 'BOOTSTRAP_INPUT', 'Fixture reader cannot be replaced');
    const rpc = (method, params = []) => reader.send(method, params);
    const tx = plan.transactions[index].transaction;
    const expectedGenesis = fixture?.genesisHash ?? ETHEREUM_SEPOLIA.genesisHash;
    const checkChain = async () => {
      check(quantity(await rpc('eth_chainId'), 'chainId') === 11155111n, 'BOOTSTRAP_CHAIN', 'Only Ethereum Sepolia chain evidence is supported');
      const genesis = await rpc('eth_getBlockByNumber', ['0x0', false]);
      check(plain(genesis) && quantity(genesis.number, 'genesis.number') === 0n && hash(genesis.hash, 'genesis.hash') === expectedGenesis,
        'BOOTSTRAP_CHAIN', 'Pinned genesis is unavailable or differs; no pruned-history fallback');
    };
    const canonical = async anchor => {
      check(same(anchor, block(await rpc('eth_getBlockByNumber', [hex(anchor.blockNumber), false]), 'canonical', anchor.blockNumber)),
        'BOOTSTRAP_REORG', 'Canonical block changed during verification');
    };
    await checkChain();
    const receipt = await rpc('eth_getTransactionReceipt', [txHash]);
    check(receipt !== null, 'BOOTSTRAP_PENDING', 'Receipt is unavailable; keep the reservation and never resubmit');
    check(plain(receipt) && hash(receipt.transactionHash, 'receipt.tx') === txHash && quantity(receipt.type, 'receipt.type') === 2n,
      'BOOTSTRAP_EVIDENCE', 'Receipt does not describe this exact type-2 transaction');
    check(EXTRA_FEES.every(k => !Object.hasOwn(receipt, k)) && ['blobGasUsed', 'blobGasPrice'].every(k => receipt[k] === undefined || quantity(receipt[k], k) === 0n),
      'BOOTSTRAP_FEE', 'Unexpected separate/deposit/blob fees cannot be ignored');
    const status = quantity(receipt.status, 'receipt.status');
    check(status === 0n || status === 1n, 'BOOTSTRAP_EVIDENCE', 'Receipt status must be success or revert');
    check(Array.isArray(receipt.logs) && (status === 1n || receipt.logs.length === 0), 'BOOTSTRAP_EVIDENCE', 'Receipt logs are malformed or survive a claimed revert');
    bindTransaction(await rpc('eth_getTransactionByHash', [txHash]), receipt, tx, txHash);
    check(address(receipt.from, 'receipt.from') === tx.from && (tx.to === null ? receipt.to === null : address(receipt.to, 'receipt.to') === tx.to),
      'BOOTSTRAP_TRANSACTION', 'Receipt sender/destination differs from the plan');
    const created = tx.to === null ? getCreateAddress({ from: tx.from, nonce: BigInt(tx.nonce) }).toLowerCase() : null;
    check(created ? (status === 1n ? address(receipt.contractAddress, 'receipt.contractAddress') === created
      : receipt.contractAddress === null || address(receipt.contractAddress, 'receipt.contractAddress') === created) : receipt.contractAddress === null,
    'BOOTSTRAP_TRANSACTION', 'Creation address differs from the exact operator and nonce');
    const number = quantity(receipt.blockNumber, 'receipt.blockNumber');
    check(number > 0n, 'BOOTSTRAP_EVIDENCE', 'Bootstrap transactions cannot be in genesis');
    const finalized = block(await rpc('eth_getBlockByNumber', ['finalized', false]), 'finalized');
    check(BigInt(finalized.blockNumber) >= number, 'BOOTSTRAP_NOT_FINALIZED', 'Receipt is not finalized; retain the reservation');
    let historical;
    if (historicalAnchor) {
      check(BigInt(historicalAnchor.blockNumber) >= number && BigInt(historicalAnchor.blockNumber) <= BigInt(finalized.blockNumber),
        'BOOTSTRAP_REORG', 'Stored finalized anchor is outside this receipt and current finalized history');
      historical = block(await rpc('eth_getBlockByNumber', [hex(historicalAnchor.blockNumber), false]), 'stored finalized', historicalAnchor.blockNumber);
      check(historical.blockHash === historicalAnchor.blockHash && BigInt(historical.timestamp) <= BigInt(finalized.timestamp),
        'BOOTSTRAP_REORG', 'Previously verified finalized anchor changed; retain the original proof');
    }
    const rawBlock = await rpc('eth_getBlockByNumber', [hex(number), false]), included = block(rawBlock, 'receipt', number);
    check(included.blockHash === hash(receipt.blockHash, 'receipt.blockHash') && BigInt(included.timestamp) <= BigInt(finalized.timestamp)
      && (included.blockNumber !== finalized.blockNumber || same(included, finalized)), 'BOOTSTRAP_REORG', 'Receipt is not on the canonical finalized history');
    if (historical) check(BigInt(historical.timestamp) >= BigInt(included.timestamp)
      && (historical.blockNumber !== included.blockNumber || same(historical, included)), 'BOOTSTRAP_REORG', 'Stored finalized history contradicts its included transaction');
    const txIndex = quantity(receipt.transactionIndex, 'receipt.index', BigInt(Number.MAX_SAFE_INTEGER));
    check(Array.isArray(rawBlock.transactions) && hash(rawBlock.transactions[Number(txIndex)], 'block.tx') === txHash,
      'BOOTSTRAP_TRANSACTION', 'Block transaction list does not contain this exact hash at its receipt index');
    const parent = block(await rpc('eth_getBlockByNumber', [hex(number - 1n), false]), 'parent', number - 1n);
    check(parent.blockHash === included.parentHash && BigInt(parent.timestamp) < BigInt(included.timestamp), 'BOOTSTRAP_REORG', 'Included block parent or time is inconsistent');
    for (const anchor of [parent, included]) check(await rpc('eth_getCode', [tx.from, hex(anchor.blockNumber)]) === '0x',
      'BOOTSTRAP_SENDER', 'Operator has code or delegation outside the reviewed ECDSA profile');
    const gas = quantity(receipt.gasUsed, 'receipt.gasUsed'), effective = quantity(receipt.effectiveGasPrice, 'receipt.effectiveGasPrice');
    const requirements = gasRequirements(plan, index, included.timestamp);
    check(requirements.knownWorkFits, 'BOOTSTRAP_GAS', 'Signed preparation envelope is below the reviewed intrinsic/fresh-state work floor');
    const maxFee = BigInt(tx.maxFeePerGas), base = BigInt(included.baseFeePerGas), tip = BigInt(tx.maxPriorityFeePerGas);
    check(gas > 0n && gas <= BigInt(tx.gasLimit) && base <= maxFee && effective === (base + tip < maxFee ? base + tip : maxFee),
      'BOOTSTRAP_FEE', 'Receipt gas or effective price disagrees with the signed envelope');
    const fee = gas * effective, cap = BigInt(tx.gasLimit) * maxFee;
    check(fee <= cap && cap <= BigInt(plan.policy.operatorFeeCapWei), 'BOOTSTRAP_FEE', 'Fee exceeds the reviewed signed ceiling');
    const runtimeHashes = {}; let eventLogIndex = null;
    const verifyContract = async key => {
      const artifact = plan.contracts[key], tag = hex(included.blockNumber), abi = new Interface(artifact.abi);
      runtimeHashes[key] = matchingRuntime(await rpc('eth_getCode', [artifact.address, tag]), artifact);
      const call = async (name, expected) => {
        const data = await rpc('eth_call', [{ to: artifact.address, data: abi.encodeFunctionData(name, []) }, tag]);
        check(typeof data === 'string' && DATA.test(data), 'BOOTSTRAP_CONFIGURATION', 'Contract result is malformed');
        let decoded; try { decoded = abi.decodeFunctionResult(name, data); } catch { check(false, 'BOOTSTRAP_CONFIGURATION', 'Contract result cannot be decoded'); }
        check(abi.encodeFunctionResult(name, decoded).toLowerCase() === data.toLowerCase(), 'BOOTSTRAP_CONFIGURATION', 'Contract result is not canonical ABI');
        const normalized = Array.from(decoded, v => typeof v === 'bigint' ? v.toString() : typeof v === 'string' && ADDRESS.test(v) ? v.toLowerCase() : Array.isArray(v) ? Array.from(v) : v);
        check(same(normalized, expected), 'BOOTSTRAP_CONFIGURATION', `${key}.${name} differs from the exact source configuration`);
      };
      if (key === 'token') {
        await call('name', ['Mote']); await call('symbol', ['MOTE']); await call('decimals', ['6']); await call('totalSupply', ['1000000000000']);
      } else if (key === 'router') {
        await call('token', [plan.contracts.token.address]); await call('merchant', [plan.roles.merchant]); await call('quoteSigner', [plan.roles.quoteSigner]);
        await call('eip712Domain', ['0x0f', 'MotePayments', '1', '11155111', artifact.address, ZeroHash, []]);
      } else {
        await call('token', [plan.contracts.token.address]); await call('claimAmount', ['10000000']); await call('distributionCap', ['10000000000']);
        await call('MAX_CLAIM_AMOUNT', ['10000000']); await call('MAX_DISTRIBUTION_CAP', ['10000000000']);
      }
    };
    if (status === 1n) {
      if (index < 3) {
        const key = ['token', 'router', 'dispenser'][index];
        check(created === plan.contracts[key].address, 'BOOTSTRAP_TRANSACTION', 'Created contract differs from plan');
        await verifyContract(key);
        if (index === 0) eventLogIndex = verifyTransfer(receipt, included, txHash, created, ZeroAddress, plan.roles.operator, '1000000000000');
      } else if (index === 3) {
        await verifyContract('token'); await verifyContract('dispenser');
        eventLogIndex = verifyTransfer(receipt, included, txHash, plan.contracts.token.address, plan.roles.operator, plan.contracts.dispenser.address, '10000000000');
      } else {
        // Amsterdam's EIP-7708 adds a protocol ETH Transfer log, even for plain
        // EOAs. Fee payments are excluded; do not mistake it for contract code.
        // https://eips.ethereum.org/EIPS/eip-7708#eth-transfer-logs
        if (BigInt(included.timestamp) >= BigInt(ETHEREUM_FEE_POLICY.amsterdamTimestamp)) {
          check(receipt.logs.length === 1, 'BOOTSTRAP_EVENT', 'Amsterdam native allocation requires exactly one protocol ETH Transfer event');
          eventLogIndex = verifyTransfer(receipt, included, txHash, '0xfffffffffffffffffffffffffffffffffffffffe', tx.from, tx.to, tx.value);
        } else check(receipt.logs.length === 0, 'BOOTSTRAP_EVIDENCE', 'Pre-Amsterdam ordinary native allocation unexpectedly emitted events');
        for (const anchor of [parent, included]) check(await rpc('eth_getCode', [plan.roles.payer, hex(anchor.blockNumber)]) === '0x',
          'BOOTSTRAP_RECIPIENT', 'Payer allocation target has code or delegation');
      }
    }
    await canonical(parent); await canonical(included); await canonical(finalized);
    if (historical) await canonical(historical);
    const ending = block(await rpc('eth_getBlockByNumber', ['finalized', false]), 'ending finalized');
    check(BigInt(ending.blockNumber) >= BigInt(finalized.blockNumber) && BigInt(ending.timestamp) >= BigInt(finalized.timestamp)
      && (ending.blockNumber !== finalized.blockNumber || same(ending, finalized)), 'BOOTSTRAP_REORG', 'Finalized history regressed or changed during verification');
    await canonical(ending); await checkChain();
    const native = status === 1n ? BigInt(tx.value) : 0n;
    return freeze({ schema: 'mote-bootstrap-step-proof-v1', planHash: plan.planHash, index, purpose: plan.transactions[index].purpose,
      transactionHash: txHash, transaction: structuredClone(tx), blockNumber: included.blockNumber, blockHash: included.blockHash,
      transactionIndex: txIndex.toString(), feeWei: fee.toString(), totalFeeWei: fee.toString(), success: status === 1n,
      gasUsed: gas.toString(), effectiveGasPrice: effective.toString(), feeCapWei: cap.toString(), nativeValueWei: native.toString(),
      totalDebitWei: (fee + native).toString(), maximumDebitWei: (cap + BigInt(tx.value)).toString(),
      finalized: { blockNumber: finalized.blockNumber, blockHash: finalized.blockHash }, receipt: structuredClone(receipt), runtimeHashes, eventLogIndex,
      gasRequirements: requirements, localOnly: Boolean(fixture), authorization: false, doNotResubmit: true,
      evidenceTrust: 'Single RPC reports canonical finalized history; signed bytes are reconstructed and exact source/configuration checked. No independent consensus proof.' });
  } catch (error) {
    if (error instanceof BootstrapVerificationError) throw error;
    throw new BootstrapVerificationError(error?.code?.startsWith('BOOTSTRAP_') ? error.code : 'BOOTSTRAP_EVIDENCE', 'Complete bootstrap evidence is unavailable; keep authority reserved and never resubmit', error);
  }
}

export function verifyBootstrapStep(options) { return verify(options, null); }

/** Test-only loopback integration. This does not produce public chain evidence. */
export function createLoopbackBootstrapVerifier({ reader, genesisHash } = {}) {
  let url; try { url = new URL(reader?.endpoint); } catch { check(false, 'BOOTSTRAP_FIXTURE', 'An explicit loopback reader endpoint is required'); }
  check(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) && !url.username && !url.password
    && typeof reader.send === 'function', 'BOOTSTRAP_FIXTURE', 'Fixture injection requires an explicit HTTP loopback reader');
  const fixture = { reader, genesisHash: hash(genesisHash, 'fixture.genesisHash') };
  return options => verify(options, fixture);
}
