import { getAddress, verifyTypedData, TypedDataEncoder, verifyMessage, getBytes } from 'ethers';
import { declarePaymentIdentifierExtension } from '@x402/extensions/payment-identifier';
import { hashJson, prepareAudit, canonicalStringify, boundedJson } from './core/json.mjs';

export const PROFILE = 'mote-bound-eip3009-v1';
export const BINDING = 'mote-request-binding';
export const NETWORKS = Object.freeze({
  'eip155:84532': { chainId: 84532, asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', name: 'USDC', version: '2' },
  'eip155:8453': { chainId: 8453, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', name: 'USD Coin', version: '2' },
});
export const AUTH_TYPES = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
] };
export const BIND_TYPES = { MoteRequest: [
  { name: 'origin', type: 'string' }, { name: 'method', type: 'string' }, { name: 'path', type: 'string' },
  { name: 'requestHash', type: 'bytes32' }, { name: 'offerHash', type: 'bytes32' },
  { name: 'paymentId', type: 'string' }, { name: 'authorizationHash', type: 'bytes32' },
] };
export const fail = (code) => { throw Object.assign(new Error(code), { code }); };
export const assert = (condition, code) => { if (!condition) fail(code); };
export const equal = (a, b) => canonicalStringify(a) === canonicalStringify(b);
export const address = (a) => getAddress(a).toLowerCase();
export const uint = (s) => typeof s === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(s) && BigInt(s) < 2n ** 256n;
export const hash32 = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s);

export function config({ origin, network = 'eip155:84532', payTo, offerSigner, amount = '1000', policyEpoch = 'fixture-v1', path = '/v1/audit' }) {
  const url = new URL(origin);
  assert(url.origin === origin && !url.username && !url.password && (url.protocol === 'https:' || ['127.0.0.1', 'localhost'].includes(url.hostname)), 'ORIGIN');
  assert(NETWORKS[network] && uint(amount) && BigInt(amount) > 0n && BigInt(amount) <= 1_000_000n, 'CONFIG');
  assert(typeof policyEpoch === 'string' && policyEpoch.length > 0 && policyEpoch.length < 100, 'EPOCH');
  const n = NETWORKS[network];
  assert(['/v1/audit','/v1/usdc/audit'].includes(path), 'PATH');
  const c = { profile: PROFILE, origin, path, method: 'POST', network, asset: address(n.asset), payTo: address(payTo), offerSigner: address(offerSigner), amount, policyEpoch, maxTimeoutSeconds: 120, offerLifetime: 180 };
  assert(c.payTo !== '0x0000000000000000000000000000000000000000', 'PAYEE');
  return Object.freeze({ ...c, identity: hashJson(c) });
}
export function requirements(c) {
  const n = NETWORKS[c.network];
  return { scheme: 'exact', network: c.network, amount: c.amount, asset: c.asset, payTo: c.payTo, maxTimeoutSeconds: c.maxTimeoutSeconds, extra: { name: n.name, version: n.version, assetTransferMethod: 'eip3009' } };
}
export const authDomain = (c) => ({ name: NETWORKS[c.network].name, version: '2', chainId: NETWORKS[c.network].chainId, verifyingContract: c.asset });
export const bindDomain = (c) => ({ name: 'Mote request binding', version: '1', chainId: NETWORKS[c.network].chainId, verifyingContract: c.asset });
export const authHash = (c, a) => TypedDataEncoder.hash(authDomain(c), AUTH_TYPES, a);
export function bindingMessage(c, input, offer, id, auth) {
  return { origin: c.origin, method: c.method, path: c.path, requestHash: prepareAudit(input).requestHash, offerHash: hashJson(offer.body), paymentId: id, authorizationHash: authHash(c, auth) };
}
export async function makeOffer(c, input, signer, now) {
  const prepared = prepareAudit(input);
  const body = { profile: PROFILE, configHash: c.identity, requestHash: prepared.requestHash, resultHash: prepared.resultHash, issuedAt: now, expiresAt: now + c.offerLifetime, requirements: requirements(c), resource: { url: c.origin + c.path, description: 'Bounded JSON tool-call preflight', mimeType: 'application/json' } };
  const offer = { body, signature: await signer.signMessage(getBytes(hashJson(body))) };
  return { x402Version: 2, resource: body.resource, accepts: [body.requirements], extensions: { 'payment-identifier': declarePaymentIdentifierExtension(true), [BINDING]: { info: { required: true, profile: PROFILE, offer } } } };
}
export function validateOffer(c, input, offer, now, { recovery = false } = {}) {
  const p = prepareAudit(input);
  const b = offer?.body;
  assert(b && b.profile === PROFILE && b.configHash === c.identity && b.requestHash === p.requestHash && b.resultHash === p.resultHash, 'OFFER_BINDING');
  assert(equal(b.requirements, requirements(c)) && equal(b.resource, { url: c.origin + c.path, description: 'Bounded JSON tool-call preflight', mimeType: 'application/json' }), 'OFFER_REQUIREMENTS');
  assert(Number.isSafeInteger(b.issuedAt) && Number.isSafeInteger(b.expiresAt) && b.expiresAt - b.issuedAt === c.offerLifetime && b.issuedAt <= now, 'OFFER_TIME');
  assert(recovery || now < b.expiresAt, 'OFFER_EXPIRED');
  assert(address(verifyMessage(getBytes(hashJson(b)), offer.signature)) === c.offerSigner, 'OFFER_SIGNATURE');
  return p;
}
export function validatePayment(c, input, payment, now, { recovery = false } = {}) {
  boundedJson(payment, { maxNodes: 512, maxDepth: 12 });
  assert(Buffer.byteLength(canonicalStringify(payment)) <= 16384, 'PAYMENT_SIZE');
  assert(payment?.x402Version === 2 && equal(payment.accepted, requirements(c)), 'PAYMENT_REQUIREMENTS');
  const ext = payment.extensions?.[BINDING];
  const id = payment.extensions?.['payment-identifier']?.info?.id;
  assert(typeof id === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(id), 'PAYMENT_ID');
  assert(ext?.info?.profile === PROFILE, 'BINDING_REQUIRED');
  const offer = ext.info.offer;
  const p = validateOffer(c, input, offer, now, { recovery });
  assert(equal(payment.resource, offer.body.resource), 'RESOURCE');
  const a = payment.payload?.authorization;
  assert(a && Object.keys(a).sort().join(',') === 'from,nonce,to,validAfter,validBefore,value', 'AUTH_FIELDS');
  assert(uint(a.value) && uint(a.validAfter) && uint(a.validBefore) && hash32(a.nonce), 'AUTH_FORMAT');
  const payer = address(a.from);
  assert(address(a.to) === c.payTo && a.value === c.amount && a.validAfter === '0', 'AUTH_TUPLE');
  assert(BigInt(a.validBefore) <= BigInt(offer.body.expiresAt) && BigInt(a.validBefore) > BigInt(offer.body.issuedAt), 'AUTH_EXPIRY');
  assert(recovery || BigInt(a.validBefore) > BigInt(now), 'AUTH_EXPIRED');
  assert(/^0x[0-9a-fA-F]{130}$/.test(payment.payload.signature), 'EOA_ONLY');
  assert(address(verifyTypedData(authDomain(c), AUTH_TYPES, a, payment.payload.signature)) === payer, 'PAYMENT_SIGNATURE');
  const message = bindingMessage(c, input, offer, id, a);
  assert(address(verifyTypedData(bindDomain(c), BIND_TYPES, message, ext.info.signature)) === payer, 'REQUEST_SIGNATURE');
  return { ...p, id, payer, nonce: a.nonce.toLowerCase(), authKey: `${c.network}:${c.asset}:${payer}:${a.nonce.toLowerCase()}`, fingerprint: hashJson({ message, accepted: payment.accepted }), expiresAt: Number(a.validBefore) };
}
