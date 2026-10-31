import { createHash, createPublicKey, generateKeyPairSync, randomBytes, diffieHellman, hkdfSync, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { computeAddress, getAddress, hexlify } from 'ethers';

// A constrained protocol using standard primitives, NOT an HPKE implementation.
// Authenticating the receiver challenge requires the independently trusted,
// exact Render Dashboard Shell route and reviewed receiver source. The strings
// below do not attest a host or protect compromised endpoints.
export const QUOTE_HANDOFF_ACTIVATION = 'MOTE_QUOTE_FILE_HANDOFF_V1_EXPLICITLY_AUTHORIZED';
export const QUOTE_HANDOFF_FIXTURE_ACK = 'PUBLIC_FIXTURE_TRANSPORT_ONLY_NO_AUTHORITY';
export const QUOTE_KEY_FILE = '/var/data/mote-sepolia-quote/quote.key';
const SERVICE = 'srv-dbijuvou01pc73d59c30';
const ORIGIN = 'https://mote-testnet-pilot.onrender.com';
const DESTINATION_PROTOCOL = 'mote-quote-file-destination-v1';
const CHALLENGE_PROTOCOL = 'mote-quote-file-challenge-v1';
const CAPSULE_PROTOCOL = 'mote-quote-file-capsule-v1';
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const FIXTURE_KEY = Buffer.from('00'.repeat(31) + '01', 'hex');
const FIXTURE_ADDRESS = computeAddress(hexlify(FIXTURE_KEY)).toLowerCase();
const MAX_TTL_MS = 120_000;
const DESTINATION_FIELDS = ['protocol','chainId','provider','serviceId','origin','quotePath','configHash','quoteSigner','sourceCommit','destinationHash'];
const CHALLENGE_FIELDS = ['protocol','destination','sessionId','issuedAt','expiresAt','receiverPublicKey'];
const CAPSULE_FIELDS = ['protocol','challengeHash','senderPublicKey','nonce','ciphertext','tag'];

export class QuoteHandoffError extends Error {
  constructor(code) { super(code); this.name = 'QuoteHandoffError'; this.code = code; }
}
const fail = code => { throw new QuoteHandoffError(code); };
const check = (ok, code = 'HANDOFF_INVALID') => { if (!ok) fail(code); };
const redact = fn => {
  try { return fn(); } catch (error) { if (error instanceof QuoteHandoffError) throw error; fail('HANDOFF_INVALID'); }
};
function fields(value, expected) {
  check(value && Object.getPrototypeOf(value) === Object.prototype, 'HANDOFF_FIELDS');
  const keys = Reflect.ownKeys(value);
  check(keys.length === expected.length && expected.every(key => Object.hasOwn(value, key)), 'HANDOFF_FIELDS');
  for (const key of keys) check(typeof key === 'string' && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'), 'HANDOFF_FIELDS');
}
function optionsFields(value, allowed) {
  check(value && Object.getPrototypeOf(value) === Object.prototype, 'HANDOFF_FIELDS');
  for (const key of Reflect.ownKeys(value)) check(typeof key === 'string' && allowed.includes(key)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'), 'HANDOFF_FIELDS');
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
function clock(now) { const value = (now ?? Date.now)(); check(Number.isSafeInteger(value) && value >= 0, 'HANDOFF_CLOCK'); return value; }
function base64(value, bytes) {
  check(typeof value === 'string' && value.length === Math.ceil(bytes / 3) * 4 && /^[A-Za-z0-9+/]*={0,2}$/.test(value), 'HANDOFF_ENCODING');
  const decoded = Buffer.from(value, 'base64');
  check(decoded.length === bytes && decoded.toString('base64') === value, 'HANDOFF_ENCODING');
  return decoded;
}
function publicKey(value) {
  const der = base64(value, 44);
  check(der.subarray(0, 12).equals(SPKI_PREFIX), 'HANDOFF_KEY_TYPE');
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  check(key.type === 'public' && key.asymmetricKeyType === 'x25519', 'HANDOFF_KEY_TYPE');
  return key;
}
function pair(factory) {
  const value = factory();
  fields(value, ['privateKey','publicKey']);
  check(value.privateKey?.type === 'private' && value.privateKey.asymmetricKeyType === 'x25519'
    && value.publicKey?.type === 'public' && value.publicKey.asymmetricKeyType === 'x25519', 'HANDOFF_KEY_TYPE');
  const derived = createPublicKey(value.privateKey).export({ format:'der', type:'spki' });
  const supplied = value.publicKey.export({ format:'der', type:'spki' });
  check(derived.length === 44 && supplied.length === 44 && timingSafeEqual(derived, supplied), 'HANDOFF_KEY_PAIR');
  const encoded = supplied.toString('base64'); publicKey(encoded);
  return { privateKey: value.privateKey, publicKey: encoded };
}
function generators(options, destination) {
  const injected = options.keyPairFactory !== undefined || options.randomBytesFactory !== undefined || options.fixtureAcknowledgement !== undefined;
  if (injected) {
    check(options.activation === undefined && options.fixtureAcknowledgement === QUOTE_HANDOFF_FIXTURE_ACK
      && typeof options.keyPairFactory === 'function' && typeof options.randomBytesFactory === 'function', 'HANDOFF_FIXTURE_REQUIRED');
    check(destination.quoteSigner === FIXTURE_ADDRESS, 'HANDOFF_FIXTURE_SIGNER_REQUIRED');
    return { fixture: true, keyPair: options.keyPairFactory, random: options.randomBytesFactory };
  }
  check(options.activation === QUOTE_HANDOFF_ACTIVATION, 'HANDOFF_ACTIVATION_REQUIRED');
  check(!process.env.NODE_TEST_CONTEXT && !process.env.MOTE_CUSTODY_TEST, 'HANDOFF_NATIVE_FORBIDDEN_IN_TEST');
  check(destination.quoteSigner !== FIXTURE_ADDRESS, 'HANDOFF_PUBLIC_FIXTURE_FORBIDDEN');
  return { fixture: false, keyPair: () => generateKeyPairSync('x25519'), random: randomBytes };
}
function entropy(generator, length) {
  const value = generator(length);
  check(value instanceof Uint8Array && value.length === length, 'HANDOFF_RANDOM_LENGTH');
  return Buffer.from(value);
}
function signer(bytes, destination, fixture) {
  check(bytes instanceof Uint8Array && bytes.length === 32, 'HANDOFF_KEY_LENGTH');
  const isFixture = timingSafeEqual(bytes, FIXTURE_KEY);
  check(fixture ? isFixture : !isFixture, fixture ? 'HANDOFF_FIXTURE_KEY_REQUIRED' : 'HANDOFF_PUBLIC_FIXTURE_FORBIDDEN');
  check(computeAddress(hexlify(bytes)).toLowerCase() === destination.quoteSigner, 'HANDOFF_SIGNER_MISMATCH');
}

export function describeFileHandoffDestination(input) { return redact(() => {
  fields(input, ['serviceId','origin','configHash','quoteSigner','sourceCommit']);
  check(input.serviceId === SERVICE && input.origin === ORIGIN, 'HANDOFF_DESTINATION');
  check(typeof input.configHash === 'string' && /^0x[a-f0-9]{64}$/.test(input.configHash)
    && typeof input.sourceCommit === 'string' && /^[a-f0-9]{40}$/.test(input.sourceCommit), 'HANDOFF_PINS');
  const quoteSigner = getAddress(input.quoteSigner).toLowerCase();
  check(quoteSigner !== '0x' + '00'.repeat(20), 'HANDOFF_SIGNER_MISMATCH');
  const descriptor = { protocol: DESTINATION_PROTOCOL, chainId:11155111, provider:'render', serviceId:SERVICE,
    origin:ORIGIN, quotePath:QUOTE_KEY_FILE, configHash:input.configHash, quoteSigner, sourceCommit:input.sourceCommit };
  return freeze({ ...descriptor, destinationHash:hash(descriptor) });
}); }
export function validateFileHandoffDestination(value) { return redact(() => {
  fields(value, DESTINATION_FIELDS);
  const expected = describeFileHandoffDestination(Object.fromEntries(['serviceId','origin','configHash','quoteSigner','sourceCommit'].map(key => [key,value[key]])));
  check(canonical(value) === canonical(expected), 'HANDOFF_DESTINATION');
  return expected;
}); }
function challengeShape(value) {
  fields(value, CHALLENGE_FIELDS);
  check(value.protocol === CHALLENGE_PROTOCOL, 'HANDOFF_PROTOCOL');
  const destination = validateFileHandoffDestination(value.destination);
  check(typeof value.sessionId === 'string' && /^[a-f0-9]{64}$/.test(value.sessionId), 'HANDOFF_SESSION');
  check(Number.isSafeInteger(value.issuedAt) && value.issuedAt >= 0 && Number.isSafeInteger(value.expiresAt)
    && value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt <= MAX_TTL_MS, 'HANDOFF_EXPIRY');
  publicKey(value.receiverPublicKey);
  return freeze({ protocol:CHALLENGE_PROTOCOL, destination, sessionId:value.sessionId,
    issuedAt:value.issuedAt, expiresAt:value.expiresAt, receiverPublicKey:value.receiverPublicKey });
}
export function hashFileHandoffChallenge(value) { return redact(() => hash(challengeShape(value))); }
export function validateFileHandoffChallenge(value, { expectedDestinationHash, expectedChallengeHash, now } = {}) { return redact(() => {
  const bound = challengeShape(value);
  check(typeof expectedDestinationHash === 'string' && /^[a-f0-9]{64}$/.test(expectedDestinationHash)
    && bound.destination.destinationHash === expectedDestinationHash, 'HANDOFF_PIN_MISMATCH');
  check(typeof expectedChallengeHash === 'string' && /^[a-f0-9]{64}$/.test(expectedChallengeHash)
    && hash(bound) === expectedChallengeHash, 'HANDOFF_CHALLENGE_PIN_MISMATCH');
  const current = clock(now);
  check(current >= bound.issuedAt && current < bound.expiresAt, 'HANDOFF_EXPIRED');
  return bound;
}); }
function symmetricKey(privateKey, peer, challengeHash, senderPublicKey) {
  let shared;
  try {
    shared = diffieHellman({ privateKey, publicKey:peer });
    check(shared.length === 32 && !shared.every(value => value === 0), 'HANDOFF_DH_FAILED');
    return Buffer.from(hkdfSync('sha256', shared, Buffer.from(challengeHash,'hex'), Buffer.from(CAPSULE_PROTOCOL + '\0' + senderPublicKey), 32));
  } catch { fail('HANDOFF_DH_FAILED'); }
  finally { shared?.fill(0); }
}
const aad = capsule => Buffer.from(canonical({ protocol:capsule.protocol, challengeHash:capsule.challengeHash,
  senderPublicKey:capsule.senderPublicKey, nonce:capsule.nonce }));

export function createReceiverSession(options) { return redact(() => {
  const allowed = ['destination','now','activation','keyPairFactory','randomBytesFactory','fixtureAcknowledgement','ttlSeconds'];
  optionsFields(options,allowed);
  const destination = validateFileHandoffDestination(options.destination), now = options.now ?? Date.now;
  const ttlSeconds = options.ttlSeconds ?? 120;
  check(Number.isInteger(ttlSeconds) && ttlSeconds > 0 && ttlSeconds <= 120, 'HANDOFF_EXPIRY');
  const generated = generators(options,destination), issuedAt = clock(now);
  check(Number.isSafeInteger(issuedAt + ttlSeconds * 1000), 'HANDOFF_EXPIRY');
  const ephemeral = pair(generated.keyPair);
  let privateKey = ephemeral.privateKey, consumed = false, timer;
  ephemeral.privateKey = null;
  const challenge = challengeShape({ protocol:CHALLENGE_PROTOCOL, destination,
    sessionId:entropy(generated.random,32).toString('hex'), issuedAt, expiresAt:issuedAt + ttlSeconds*1000,
    receiverPublicKey:ephemeral.publicKey });
  const challengeHash = hash(challenge);
  const close = () => { consumed = true; privateKey = null; clearTimeout(timer); };
  timer = setTimeout(close,ttlSeconds*1000); timer.unref?.();
  const open = capsule => redact(() => {
    check(!consumed && privateKey, 'HANDOFF_ALREADY_USED');
    // Consume before any parsing/authentication. Malformed or interrupted input
    // never grants a second attempt with this ephemeral receiver authority.
    const receiverPrivate = privateKey; close();
    let key, plaintext, tail;
    try {
      validateFileHandoffChallenge(challenge,{ expectedDestinationHash:destination.destinationHash,expectedChallengeHash:challengeHash,now });
      fields(capsule,CAPSULE_FIELDS);
      check(capsule.protocol === CAPSULE_PROTOCOL && capsule.challengeHash === challengeHash, 'HANDOFF_CONTEXT');
      const peer = publicKey(capsule.senderPublicKey), nonce = base64(capsule.nonce,12), ciphertext = base64(capsule.ciphertext,32), tag = base64(capsule.tag,16);
      key = symmetricKey(receiverPrivate,peer,challengeHash,capsule.senderPublicKey);
      const decipher = createDecipheriv('aes-256-gcm',key,nonce,{authTagLength:16});
      decipher.setAAD(aad(capsule)); decipher.setAuthTag(tag);
      plaintext = decipher.update(ciphertext); tail = decipher.final();
      check(plaintext.length === 32 && tail.length === 0, 'HANDOFF_KEY_LENGTH');
      signer(plaintext,destination,generated.fixture);
      const result = Buffer.from(plaintext);
      return result; // Ownership transfers to importer; it MUST zero this buffer.
    } catch (error) { if (error instanceof QuoteHandoffError) throw error; fail('HANDOFF_DECRYPT_FAILED'); }
    finally { key?.fill(0); plaintext?.fill(0); tail?.fill(0); }
  });
  return Object.freeze({ challenge,open,close });
}); }

export function sealQuoteKey(bytes, challenge, options) { return redact(() => {
  const allowed = ['expectedDestinationHash','expectedChallengeHash','now','activation','keyPairFactory','randomBytesFactory','fixtureAcknowledgement'];
  optionsFields(options,allowed);
  const bound = validateFileHandoffChallenge(challenge,options), generated = generators(options,bound.destination);
  signer(bytes,bound.destination,generated.fixture);
  const ephemeral = pair(generated.keyPair), challengeHash = hash(bound), nonce = entropy(generated.random,12);
  let key;
  try {
    key = symmetricKey(ephemeral.privateKey,publicKey(bound.receiverPublicKey),challengeHash,ephemeral.publicKey);
    const header = { protocol:CAPSULE_PROTOCOL,challengeHash,senderPublicKey:ephemeral.publicKey,nonce:nonce.toString('base64') };
    const cipher = createCipheriv('aes-256-gcm',key,nonce,{authTagLength:16}); cipher.setAAD(aad(header));
    const ciphertext = Buffer.concat([cipher.update(bytes),cipher.final()]);
    check(ciphertext.length === 32, 'HANDOFF_KEY_LENGTH');
    return Object.freeze({ ...header,ciphertext:ciphertext.toString('base64'),tag:cipher.getAuthTag().toString('base64') });
  } finally { key?.fill(0); }
}); }
