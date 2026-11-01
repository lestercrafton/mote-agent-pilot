import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve, parse } from 'node:path';
import { Wallet, Transaction, getAddress, getBytes, hexlify } from '../node_modules/ethers/lib.esm/index.js';
import { validateFileHandoffChallenge, sealQuoteKey, QUOTE_HANDOFF_ACTIVATION, QUOTE_HANDOFF_FIXTURE_ACK } from '../src/quote-key-envelope.mjs';

export const KEYCHAIN_ACTIVATION = 'MOTE_NATIVE_KEYCHAIN_V1_EXPLICITLY_AUTHORIZED';
export const KEYCHAIN_CHAIN_ID = 11155111;
export const KEYCHAIN_SERVICES = Object.freeze({
  'quote-backup': 'org.mote.ethereum-sepolia.quote.v1',
  bootstrap: 'org.mote.ethereum-sepolia.bootstrap.v2',
});
export const KEYCHAIN_ACCOUNTS = Object.freeze({
  'quote-backup': 'ethereum-sepolia:quote-backup:v1',
  bootstrap: 'ethereum-sepolia:bootstrap:v2',
});
const FIXTURE_ACK = 'PUBLIC_FIXTURE_BYTES_ONLY_NO_KEYCHAIN';
const PUBLIC_FIXTURE = '0x' + '00'.repeat(31) + '01'; // Deliberately public, worthless scalar. Never provision it.
const FEE_MAX = 2_000_000_000n, PRIORITY_MAX = 1_000_000_000n;
const NATIVE_MAX = 50_000_000_000_000_000n, ALLOCATION_MAX = 7_000_000_000_000_000n;
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const check = (ok, code = 'CUSTODY_INVALID_REQUEST') => { if (!ok) fail(code); };
const own = (object, allowed) => {
  check(object && Object.getPrototypeOf(object) === Object.prototype);
  check(Object.keys(object).every(key => allowed.includes(key)));
};
function roleInfo(role, chainId) {
  check(Object.hasOwn(KEYCHAIN_SERVICES, role) && chainId === KEYCHAIN_CHAIN_ID, 'CUSTODY_WRONG_ROLE_OR_CHAIN');
  return { role, chainId, service: KEYCHAIN_SERVICES[role], account: KEYCHAIN_ACCOUNTS[role] };
}
function uint(value, max = (1n << 256n) - 1n) {
  check(typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value)) || (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)));
  const n = BigInt(value); check(n >= 0n && n <= max); return n;
}
function normalizedIntent(input) {
  own(input, ['chainId','type','nonce','to','data','value','gasLimit','maxFeePerGas','maxPriorityFeePerGas','accessList']);
  check(Object.keys(input).length === 10 && input.type === 2 && uint(input.chainId) === 11155111n);
  check(Array.isArray(input.accessList) && input.accessList.length === 0);
  check(input.to === null || (typeof input.to === 'string' && /^0x[0-9a-fA-F]{40}$/.test(input.to)));
  check(typeof input.data === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(input.data) && input.data.length <= 131074);
  const gasLimit = uint(input.gasLimit, 10_000_000n), maxFeePerGas = uint(input.maxFeePerGas, FEE_MAX);
  const maxPriorityFeePerGas = uint(input.maxPriorityFeePerGas, PRIORITY_MAX), value = uint(input.value, ALLOCATION_MAX);
  check(gasLimit >= 21000n && maxFeePerGas > 0n && maxPriorityFeePerGas <= maxFeePerGas);
  check(input.to !== null || (value === 0n && input.data !== '0x'));
  check(value === 0n || (input.to !== null && input.data === '0x'));
  return { type: 2, chainId: 11155111n, nonce: Number(uint(input.nonce, BigInt(Number.MAX_SAFE_INTEGER))), to: input.to === null ? null : getAddress(input.to), data: input.data.toLowerCase(), value, gasLimit, maxFeePerGas, maxPriorityFeePerGas, accessList: [] };
}
function policyFor(role, allowedTransactions) {
  if (role !== 'bootstrap') { check(allowedTransactions === undefined, 'CUSTODY_ROLE_CANNOT_SIGN_TRANSACTIONS'); return null; }
  check(Array.isArray(allowedTransactions) && allowedTransactions.length === 5, 'CUSTODY_EXACT_INTENTS_REQUIRED');
  const transactions = allowedTransactions.map(normalizedIntent);
  const gasCeilings = [5_000_000n, 7_000_000n, 5_000_000n, 250_000n, 250_000n];
  transactions.forEach((tx, index) => {
    check(tx.nonce === transactions[0].nonce + index && tx.gasLimit <= gasCeilings[index], 'CUSTODY_PLAN_SHAPE_INVALID');
    if (index < 3) check(tx.to === null && tx.value === 0n, 'CUSTODY_PLAN_SHAPE_INVALID');
    else if (index === 3) check(tx.to !== null && tx.value === 0n && tx.data !== '0x', 'CUSTODY_PLAN_SHAPE_INVALID');
    else check(tx.to !== null && tx.value > 0n && tx.data === '0x', 'CUSTODY_PLAN_SHAPE_INVALID');
  });
  check(transactions.reduce((total, tx) => total + tx.value + tx.gasLimit * tx.maxFeePerGas, 0n) <= NATIVE_MAX, 'CUSTODY_NATIVE_BUDGET_EXCEEDED');
  return new Set(transactions.map(tx => Transaction.from(tx).unsignedSerialized));
}
function validKey(bytes) {
  check(bytes instanceof Uint8Array && bytes.length === 32, 'CUSTODY_INVALID_KEY_MATERIAL');
  try { return new Wallet(hexlify(bytes)); } catch { fail('CUSTODY_INVALID_KEY_MATERIAL'); }
}
function nativeBinding(options) {
  const bound = Object.freeze({ role: options.role, chainId: options.chainId, activation: options.activation, helperPath: options.helperPath, expectedHelperSha256: options.expectedHelperSha256 });
  roleInfo(bound.role, bound.chainId);
  return bound;
}
function handoffTarget(destination, approvedDestinationHash) {
  own(destination, ['provider','serviceId','origin','configHash','quoteSigner','environmentKey']);
  check(Object.keys(destination).length === 6 && destination.provider === 'render' && /^srv-[a-z0-9]{8,64}$/.test(destination.serviceId), 'CUSTODY_HANDOFF_DESTINATION_INVALID');
  check(destination.environmentKey === 'MOTE_ETHEREUM_SEPOLIA_QUOTE_PRIVATE_KEY' && /^0x[0-9a-f]{64}$/.test(destination.configHash), 'CUSTODY_HANDOFF_DESTINATION_INVALID');
  let url; try { url = new URL(destination.origin); } catch { fail('CUSTODY_HANDOFF_DESTINATION_INVALID'); }
  check(url.protocol === 'https:' && /^[a-z0-9][a-z0-9-]*\.onrender\.com$/.test(url.hostname) && url.origin === destination.origin && !url.username && !url.password && !url.port && url.pathname === '/' && !url.search && !url.hash, 'CUSTODY_HANDOFF_DESTINATION_INVALID');
  let quoteSigner; try { quoteSigner = getAddress(destination.quoteSigner); } catch { fail('CUSTODY_HANDOFF_DESTINATION_INVALID'); }
  const normalized = { protocol: 'mote-quote-key-handoff-v1', chainId: KEYCHAIN_CHAIN_ID, service: KEYCHAIN_SERVICES['quote-backup'], provider: 'render', serviceId: destination.serviceId, origin: url.origin, configHash: destination.configHash, quoteSigner, environmentKey: destination.environmentKey };
  const hash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  check(typeof approvedDestinationHash === 'string' && hash === approvedDestinationHash, 'CUSTODY_HANDOFF_PIN_MISMATCH');
  return Object.freeze({ ...normalized, destinationHash: hash });
}
export function describeQuoteHandoff(destination) {
  // Public planning only: validate a caller-supplied destination and compute its review hash.
  const quoteSigner = getAddress(destination.quoteSigner);
  const candidate = { protocol: 'mote-quote-key-handoff-v1', chainId: KEYCHAIN_CHAIN_ID, service: KEYCHAIN_SERVICES['quote-backup'], provider: 'render', serviceId: destination.serviceId, origin: destination.origin, configHash: destination.configHash, quoteSigner, environmentKey: destination.environmentKey };
  const hash = createHash('sha256').update(JSON.stringify(candidate)).digest('hex');
  return handoffTarget(destination, hash);
}
async function deliverQuote(readSecret, destination, approvedDestinationHash, sink) {
  const target = handoffTarget(destination, approvedDestinationHash);
  check(sink && sink.destinationHash === target.destinationHash && typeof sink.writeSecret === 'function', 'CUSTODY_HANDOFF_SINK_MISMATCH');
  const writeSecret = sink.writeSecret.bind(sink);
  const bytes = await readSecret();
  try {
    check(validKey(bytes).address === target.quoteSigner, 'CUSTODY_HANDOFF_SIGNER_MISMATCH');
    let result; try { result = await writeSecret(bytes, target); } catch { fail('CUSTODY_HANDOFF_OUTCOME_UNKNOWN'); }
    check(result && Object.keys(result).sort().join() === 'accepted,destinationHash' && result.accepted === true && result.destinationHash === target.destinationHash, 'CUSTODY_HANDOFF_OUTCOME_UNKNOWN');
    return Object.freeze({ handedOff: true, destinationHash: target.destinationHash, address: target.quoteSigner });
  } finally { bytes.fill(0); }
}
export async function handoffQuoteToRender(options, sink) {
  own(options, ['role','chainId','activation','helperPath','expectedHelperSha256','destination','approvedDestinationHash']);
  const bound = nativeBinding(options);
  check(bound.role === 'quote-backup', 'CUSTODY_WRONG_ROLE_OR_CHAIN');
  const destination = Object.freeze({ ...options.destination }), approvedDestinationHash = options.approvedDestinationHash;
  handoffTarget(destination, approvedDestinationHash);
  const boundSink = sink && Object.freeze({ destinationHash: sink.destinationHash, writeSecret: typeof sink.writeSecret === 'function' ? sink.writeSecret.bind(sink) : undefined });
  await trustedHelper(bound);
  return deliverQuote(() => nativeOperation(bound, 'read'), destination, approvedDestinationHash, boundSink);
}

// This separate proposed route returns an encrypted capsule only. It neither
// writes a Render environment variable nor performs any network/browser action.
// The challenge pin must come from the independently authenticated Dashboard
// Shell and reviewed receiver source, never merely from the supplied challenge.
async function sealQuoteImport(readSecret, challenge, options) {
  const captured = Object.freeze({ ...options });
  const bound = validateFileHandoffChallenge(challenge, captured);
  const bytes = await readSecret();
  try { return sealQuoteKey(bytes, bound, captured); }
  finally { bytes.fill(0); }
}
export async function sealKeychainQuoteForImport(options) {
  own(options, ['role','chainId','activation','helperPath','expectedHelperSha256','challenge','expectedDestinationHash','expectedChallengeHash']);
  const bound = nativeBinding(options);
  check(bound.role === 'quote-backup', 'CUSTODY_WRONG_ROLE_OR_CHAIN');
  const transport = Object.freeze({ expectedDestinationHash: options.expectedDestinationHash, expectedChallengeHash: options.expectedChallengeHash, activation: QUOTE_HANDOFF_ACTIVATION });
  const challenge = validateFileHandoffChallenge(options.challenge, transport);
  await trustedHelper(bound);
  return sealQuoteImport(() => nativeOperation(bound, 'read'), challenge, transport);
}
async function trustedHelper(options) {
  check(options.activation === KEYCHAIN_ACTIVATION, 'CUSTODY_NATIVE_ACTIVATION_REQUIRED');
  check(process.platform === 'darwin', 'CUSTODY_MACOS_REQUIRED');
  check(!process.env.NODE_TEST_CONTEXT && !process.env.MOTE_CUSTODY_TEST, 'CUSTODY_NATIVE_FORBIDDEN_IN_TEST');
  check(typeof options.helperPath === 'string' && /^([a-f0-9]{64})$/.test(options.expectedHelperSha256 ?? ''), 'CUSTODY_HELPER_PIN_REQUIRED');
  const path = resolve(options.helperPath);
  check(await realpath(path) === path, 'CUSTODY_HELPER_SYMLINK_FORBIDDEN');
  const st = await lstat(path), uid = process.getuid();
  check(st.isFile() && st.uid === uid && (st.mode & 0o022) === 0 && (st.mode & 0o100) !== 0, 'CUSTODY_HELPER_PERMISSIONS');
  for (let directory = dirname(path); directory !== parse(directory).root; directory = dirname(directory)) {
    const parent = await lstat(directory);
    check(parent.isDirectory() && !parent.isSymbolicLink() && (parent.uid === uid || parent.uid === 0) && (parent.mode & 0o022) === 0, 'CUSTODY_HELPER_PERMISSIONS');
  }
  const contents = await readFile(path);
  check(createHash('sha256').update(contents).digest('hex') === options.expectedHelperSha256, 'CUSTODY_HELPER_PIN_MISMATCH');
  return path;
}
// Private descriptors are never inherited by another program, logged, or exposed as CLI options.
async function nativeOperation(options, operation, secret) {
  const path = await trustedHelper(options);
  const request = { protocol: 'mote-keychain-v1', operation, ...roleInfo(options.role, options.chainId), access: 'helper-only-no-ui' };
  return new Promise((accept, reject) => {
    let child, stdout = Buffer.alloc(0), secretOutput = Buffer.alloc(0), completed = false, fault = false;
    const finish = (code, bytes) => {
      if (completed) return; completed = true; clearTimeout(timer);
      stdout.fill(0); secretOutput.fill(0);
      if (code) { const error = new Error(code); error.code = code; reject(error); } else accept(bytes);
    };
    const abort = () => { fault = true; child?.kill('SIGKILL'); };
    const timer = setTimeout(() => { abort(); finish('CUSTODY_NATIVE_TIMEOUT'); }, 5000);
    try {
      child = spawn(path, ['--activate-native-keychain-v1'], { stdio: ['pipe','pipe','pipe','pipe','pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C' }, windowsHide: true });
      child.on('error', () => finish('CUSTODY_NATIVE_UNAVAILABLE'));
      for (const pipe of child.stdio) pipe?.on('error', abort);
      child.stdout.on('data', chunk => { if (stdout.length + chunk.length > 1024) { chunk.fill(0); abort(); return; } stdout = Buffer.concat([stdout, chunk]); });
      child.stderr.on('data', chunk => { chunk.fill(0); abort(); }); // No diagnostic passthrough, even on failure.
      child.stdio[4].on('data', chunk => { if (secretOutput.length + chunk.length > 32) { chunk.fill(0); abort(); return; } secretOutput = Buffer.concat([secretOutput, chunk]); });
      child.on('close', code => {
        if (completed) return;
        if (fault || code !== 0 || stdout.toString('utf8') !== '{"ok":true}\n' || secretOutput.length !== (operation === 'read' ? 32 : 0)) { finish('CUSTODY_NATIVE_REJECTED'); return; }
        finish(null, Buffer.from(secretOutput));
      });
      child.stdin.end(JSON.stringify(request));
      child.stdio[3].end(secret ? Buffer.from(secret) : undefined);
    } catch { abort(); finish('CUSTODY_NATIVE_UNAVAILABLE'); }
  });
}
function opaqueSigner(info, policy, readSecret) {
  const getAddress = async () => {
    const bytes = await readSecret();
    try { return validKey(bytes).address; } finally { bytes.fill(0); }
  };
  if (info.role !== 'bootstrap') return Object.freeze({ role: info.role, chainId: info.chainId, service: info.service, getAddress });
  const signTransaction = async transaction => {
    let tx;
    try { tx = normalizedIntent(transaction); check(policy.has(Transaction.from(tx).unsignedSerialized), 'CUSTODY_TRANSACTION_NOT_AUTHORIZED'); } catch { fail('CUSTODY_TRANSACTION_NOT_AUTHORIZED'); }
    const bytes = await readSecret();
    try {
      const wallet = validKey(bytes), serialized = await wallet.signTransaction(tx), signed = Transaction.from(serialized);
      check(signed.unsignedSerialized === Transaction.from(tx).unsignedSerialized && signed.from === wallet.address, 'CUSTODY_SIGNATURE_MISMATCH');
      return serialized;
    } finally { bytes.fill(0); }
  };
  return Object.freeze({ role: info.role, chainId: info.chainId, service: info.service, getAddress, signTransaction });
}
export async function openKeychainSigner(options) {
  own(options, ['role','chainId','allowedTransactions','activation','helperPath','expectedHelperSha256']);
  const bound = nativeBinding(options), info = roleInfo(bound.role, bound.chainId), policy = policyFor(info.role, options.allowedTransactions);
  await trustedHelper(bound); // Explicit validation even though actual item read is deferred.
  return opaqueSigner(info, policy, () => nativeOperation(bound, 'read'));
}
// The callback receives only a frozen public descriptor. A durable caller must
// fsync its public identity record before acknowledging it. No native write
// starts before acknowledgment; all write/read uncertainty remains terminal.
async function completeProvision(info, privateKeyBytes, create, read, onIdentityPrepared) {
  check(typeof onIdentityPrepared === 'function', 'CUSTODY_IDENTITY_CALLBACK_REQUIRED');
  const wallet = validKey(privateKeyBytes);
  const identity = Object.freeze({ ...info, address: wallet.address });
  const copy = Buffer.from(privateKeyBytes);
  try {
    try {
      const receipt = await onIdentityPrepared(identity);
      check(receipt && Object.getPrototypeOf(receipt) === Object.prototype
        && Object.keys(receipt).sort().join() === 'address,recorded'
        && receipt.recorded === true && receipt.address === identity.address);
    } catch { fail('CUSTODY_IDENTITY_RECORDING_FAILED'); }
    try { await create(copy); } catch { fail('CUSTODY_CREATE_OUTCOME_UNKNOWN'); }
    let readback;
    try {
      readback = await read();
      check(readback instanceof Uint8Array && readback.length === 32 && timingSafeEqual(copy, readback));
      check(validKey(readback).address === identity.address);
    } catch { fail('CUSTODY_READBACK_UNVERIFIED'); }
    finally { if (readback instanceof Uint8Array) readback.fill(0); }
    return Object.freeze({ ...identity, created: true, readbackVerified: true, identityRecorded: true });
  } finally { copy.fill(0); }
}
async function provisionKeychainRole(options, privateKeyBytes, onIdentityPrepared) {
  own(options, ['role','chainId','activation','helperPath','expectedHelperSha256']);
  const info = roleInfo(options.role, options.chainId);
  check(hexlify(privateKeyBytes) !== PUBLIC_FIXTURE, 'CUSTODY_PUBLIC_FIXTURE_FORBIDDEN');
  return completeProvision(info, privateKeyBytes,
    bytes => nativeOperation(options, 'create', bytes),
    () => nativeOperation(options, 'read'), onIdentityPrepared);
}
export async function provisionFreshKeychainRole(options) {
  own(options, ['role','chainId','activation','helperPath','expectedHelperSha256','onIdentityPrepared']);
  const onIdentityPrepared = options.onIdentityPrepared;
  check(typeof onIdentityPrepared === 'function', 'CUSTODY_IDENTITY_CALLBACK_REQUIRED');
  const bound = nativeBinding(options);
  await trustedHelper(bound); // MUST precede even CSPRNG access; tests cannot enter this branch.
  for (let attempt = 0; attempt < 4; attempt++) {
    const bytes = randomBytes(32);
    let valid = true;
    try { validKey(bytes); } catch { valid = false; }
    if (!valid || hexlify(bytes) === PUBLIC_FIXTURE) { bytes.fill(0); continue; }
    try { return await provisionKeychainRole(bound, bytes, onIdentityPrepared); }
    finally { bytes.fill(0); }
  }
  fail('CUSTODY_KEY_GENERATION_FAILED');
}
// Fixed public scalar and memory only. This invokes the SAME completion flow,
// with complete fake create/read capabilities and no native/entropy fallback.
export function createFixtureProvisioning({ acknowledgement, role = 'bootstrap', outcome = 'success' } = {}) {
  check(process.env.NODE_TEST_CONTEXT && acknowledgement === FIXTURE_ACK, 'CUSTODY_FIXTURE_ACK_REQUIRED');
  check(['success','create-failure','readback-failure','wrong-readback','short-readback'].includes(outcome), 'CUSTODY_FIXTURE_OUTCOME_INVALID');
  const info = roleInfo(role, KEYCHAIN_CHAIN_ID), events = [], observedBuffers = [];
  let attempted = false, creates = 0, reads = 0;
  return Object.freeze({
    async provision({ onIdentityPrepared } = {}) {
      check(!attempted, 'CUSTODY_ALREADY_ATTEMPTED');
      check(typeof onIdentityPrepared === 'function', 'CUSTODY_IDENTITY_CALLBACK_REQUIRED');
      attempted = true;
      const bytes = getBytes(PUBLIC_FIXTURE); observedBuffers.push(bytes);
      try {
        return await completeProvision(info, bytes, async copy => {
          events.push('create'); creates++; observedBuffers.push(copy);
          if (outcome === 'create-failure') fail('CUSTODY_FIXTURE_CREATE_FAILED');
        }, async () => {
          events.push('readback'); reads++;
          if (outcome === 'readback-failure') fail('CUSTODY_FIXTURE_READ_FAILED');
          const result = outcome === 'short-readback' ? new Uint8Array(31)
            : getBytes(outcome === 'wrong-readback' ? '0x' + '00'.repeat(31) + '02' : PUBLIC_FIXTURE);
          observedBuffers.push(result); return result;
        }, onIdentityPrepared);
      } finally { bytes.fill(0); }
    },
    get status() { return Object.freeze({ attempted, creates, reads, events: [...events], buffersCleared: observedBuffers.every(bytes => bytes.every(byte => byte === 0)) }); },
  });
}
// Explicitly test-only fake store: fixed public scalar, no generation, disk, process or native fallback.
export function createFixtureCustody({ acknowledgement, role = 'bootstrap', chainId = KEYCHAIN_CHAIN_ID, allowedTransactions, access = 'helper-only-no-ui' } = {}) {
  check(acknowledgement === FIXTURE_ACK, 'CUSTODY_FIXTURE_ACK_REQUIRED');
  check(access === 'helper-only-no-ui', 'CUSTODY_OVERBROAD_ACCESS');
  const info = roleInfo(role, chainId), policy = policyFor(role, allowedTransactions);
  const values = new Map(); let reads = 0;
  return Object.freeze({
    fixtureOnly: true,
    provision() { check(!values.has(info.service), 'CUSTODY_ALREADY_EXISTS'); values.set(info.service, getBytes(PUBLIC_FIXTURE)); return { ...info, address: validKey(getBytes(PUBLIC_FIXTURE)).address, created: true }; },
    openSigner() { return opaqueSigner(info, policy, async () => { check(values.has(info.service), 'CUSTODY_ITEM_MISSING'); reads++; return Uint8Array.from(values.get(info.service)); }); },
    handoffQuoteToRender({ destination, approvedDestinationHash }, sink) {
      check(role === 'quote-backup', 'CUSTODY_WRONG_ROLE_OR_CHAIN');
      return deliverQuote(async () => { check(values.has(info.service), 'CUSTODY_ITEM_MISSING'); reads++; return Uint8Array.from(values.get(info.service)); }, destination, approvedDestinationHash, sink);
    },
    sealQuoteForImport({ challenge, expectedDestinationHash, expectedChallengeHash, now, keyPairFactory, randomBytesFactory }) {
      check(role === 'quote-backup', 'CUSTODY_WRONG_ROLE_OR_CHAIN');
      return sealQuoteImport(async () => { check(values.has(info.service), 'CUSTODY_ITEM_MISSING'); reads++; return Uint8Array.from(values.get(info.service)); }, challenge,
        { expectedDestinationHash, expectedChallengeHash, now, keyPairFactory, randomBytesFactory, fixtureAcknowledgement: QUOTE_HANDOFF_FIXTURE_ACK });
    },
    get readCount() { return reads; },
    destroy() { for (const bytes of values.values()) bytes.fill(0); values.clear(); },
  });
}
