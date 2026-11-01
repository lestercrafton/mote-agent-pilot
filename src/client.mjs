import { ExactEvmScheme } from '@x402/evm/exact/client';
import { BINDING, PROFILE, assert, address, bindDomain, BIND_TYPES, bindingMessage, validateOffer, validatePayment, uint } from './protocol.mjs';
import { hashJson } from './core/json.mjs';

// The signer exposes typed signatures only. No private key, transaction, approve, swap, or gas-funding API.
export async function authorize({ config: c, input, offerResponse, paymentId, signer, journal, policy, now = Math.floor(Date.now() / 1000) }) {
  input = structuredClone(input); offerResponse = structuredClone(offerResponse);
  assert(policy.enabled === true && uint(policy.maxPerPayment) && uint(policy.maxTotal) && BigInt(policy.maxPerPayment) > 0n && BigInt(policy.maxPerPayment) <= BigInt(policy.maxTotal) && policy.maxTotal === journal.limits.clientBudget, 'CLIENT_POLICY');
  assert(journal.identity === hashJson({ config: c.identity, policy }), 'CLIENT_JOURNAL_IDENTITY');
  assert(policy.network === c.network && address(policy.asset) === c.asset && address(policy.payTo) === c.payTo && policy.origin === c.origin && policy.offerSigner === c.offerSigner && policy.configHash === c.identity, 'CLIENT_POLICY');
  assert(address(policy.payer) === address(signer.address) && BigInt(c.amount) <= BigInt(policy.maxPerPayment), 'CLIENT_POLICY');
  assert(/^[A-Za-z0-9_-]{16,128}$/.test(paymentId), 'PAYMENT_ID');
  const offer = offerResponse.extensions?.[BINDING]?.info?.offer;
  validateOffer(c, input, offer, now);
  assert(now + c.maxTimeoutSeconds <= offer.body.expiresAt, 'OFFER_REFRESH_REQUIRED');
  const fingerprint = hashJson({ input, offer, paymentId, policy });
  const old = journal.clientReserve(paymentId, fingerprint, c.amount);
  if (old) {
    // An interruption during signing may have released an authorization to the wallet. Never sign again.
    assert(old.state === 'signed' && old.payment, 'CLIENT_SIGNING_UNCERTAIN');
    return JSON.parse(old.payment);
  }
  const exact = new ExactEvmScheme(signer);
  const signed = await exact.createPaymentPayload(2, offer.body.requirements);
  const binding = bindingMessage(c, input, offer, paymentId, signed.payload.authorization);
  const signature = await signer.signTypedData({ domain: bindDomain(c), types: BIND_TYPES, primaryType: 'MoteRequest', message: binding });
  const payment = { ...signed, resource: offer.body.resource, accepted: offer.body.requirements, extensions: {
    'payment-identifier': { info: { required: true, id: paymentId } },
    [BINDING]: { info: { required: true, profile: PROFILE, offer, signature } },
  } };
  validatePayment(c, input, payment, now);
  journal.clientSave(paymentId, payment);
  return payment;
}

// Recovery retrieves the ORIGINAL signed payload. No signer parameter or budget release exists.
export function recoverAuthorization(journal, paymentId) {
  const row = journal.clientGet(paymentId);
  assert(row?.state === 'signed' && row.payment, 'CLIENT_SIGNING_UNCERTAIN');
  return JSON.parse(row.payment);
}
