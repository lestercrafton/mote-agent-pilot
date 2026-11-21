import { generateJwt } from '@coinbase/cdp-sdk/auth';
import { readLimitedText } from '@x402/core/http';
import { assert, fail, hash32, address } from './protocol.mjs';

export const CDP = 'https://api.cdp.coinbase.com/platform/v2/x402';
const VERIFY_REASONS = new Set([
  'invalid_request', 'invalid_payment_requirements', 'invalid_payload', 'invalid_scheme', 'invalid_network', 'invalid_x402_version',
  'insufficient_funds', 'kyt_risk_detected', 'invalid_exact_evm_payload_authorization_from_address_kyt', 'invalid_exact_evm_payload_authorization_to_address_kyt',
  'invalid_exact_evm_payload_authorization_valid_after', 'invalid_exact_evm_payload_authorization_valid_before',
  'invalid_exact_evm_payload_authorization_typed_data_message', 'invalid_exact_evm_payload_authorization_value', 'invalid_exact_evm_payload_authorization_value_too_low',
  'invalid_exact_evm_payload_authorization_value_mismatch', 'invalid_exact_evm_authorization_value',
  'invalid_exact_evm_payload_signature', 'invalid_exact_evm_payload_signature_address', 'invalid_exact_evm_signature', 'invalid_exact_evm_failed_to_verify_signature',
  'invalid_exact_evm_non_canonical_signature', 'invalid_exact_evm_failed_to_parse_signature',
  'invalid_exact_evm_scheme', 'invalid_exact_evm_network_mismatch', 'invalid_exact_evm_missing_eip712_domain',
  'invalid_exact_evm_token_name_mismatch', 'invalid_exact_evm_token_version_mismatch', 'invalid_exact_evm_eip3009_not_supported',
  'invalid_exact_evm_transaction_failed', 'invalid_exact_evm_transaction_simulation_failed', 'invalid_exact_evm_nonce_already_used', 'invalid_exact_evm_insufficient_balance', 'invalid_exact_evm_recipient_mismatch',
]);

function verificationReason(body, fallback) {
  const reason = body?.isValid === false ? body.invalidReason : body?.errorType;
  return VERIFY_REASONS.has(reason) ? reason : fallback;
}

// API key only. Explicit arguments: no environment lookup, CDP wallet secret, account creation, or billing API.
export function cdpAuth({ apiKeyId, apiKeySecret }) {
  assert(typeof apiKeyId === 'string' && typeof apiKeySecret === 'string', 'CDP_CREDENTIALS_REQUIRED');
  return async (operation) => `Bearer ${await generateJwt({ apiKeyId, apiKeySecret, requestMethod: operation === 'supported' ? 'GET' : 'POST', requestHost: 'api.cdp.coinbase.com', requestPath: `/platform/v2/x402/${operation}`, expiresIn: 60 })}`;
}
export class CdpTransport {
  constructor({ auth, fetchImpl = fetch, timeoutMs = 15000, onVerifyFailure }) {
    assert(typeof auth === 'function' && (onVerifyFailure === undefined || typeof onVerifyFailure === 'function') && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000, 'TRANSPORT_CONFIG');
    this.auth = auth; this.fetch = fetchImpl; this.timeoutMs = timeoutMs; this.onVerifyFailure = onVerifyFailure;
  }
  reportVerificationFailure(httpStatus, reason) {
    // Diagnostic output cannot affect the payment decision or expose provider messages.
    try { this.onVerifyFailure?.({ stage: 'provider_verify', httpStatus, reason }); } catch {}
  }
  async call(operation, paymentPayload, paymentRequirements) {
    assert(['verify', 'settle', 'supported'].includes(operation), 'OPERATION');
    let httpStatus = null;
    let verifyFailure = 'transport_error';
    try {
      const response = await this.fetch(`${CDP}/${operation}`, {
        method: operation === 'supported' ? 'GET' : 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: await this.auth(operation) },
        ...(operation === 'supported' ? {} : { body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (operation === 'verify') {
        if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) httpStatus = response.status;
        verifyFailure = 'provider_http_error';
        // CDP can report a business rejection as HTTP 400. Inspect only a bounded
        // diagnostic body and retain the original non-success response behavior.
        if (httpStatus === 400 && !response.redirected && this.onVerifyFailure) {
          try { verifyFailure = verificationReason(JSON.parse(await readLimitedText(response, 4096)), verifyFailure); } catch {}
        }
      }
      assert(response.ok && !response.redirected, 'PROVIDER_HTTP');
      verifyFailure = 'invalid_response';
      const data = JSON.parse(await readLimitedText(response, 65536));
      assert(data && typeof data === 'object' && !Array.isArray(data), 'PROVIDER_SHAPE');
      if (operation === 'verify') {
        assert(typeof data.isValid === 'boolean', 'PROVIDER_SHAPE');
        if (!data.isValid) this.reportVerificationFailure(httpStatus, verificationReason(data, 'provider_rejected'));
      }
      if (operation === 'settle') assert(typeof data.success === 'boolean', 'PROVIDER_SHAPE');
      return data;
    } catch {
      if (operation === 'verify') this.reportVerificationFailure(httpStatus, verifyFailure);
      fail(operation === 'settle' ? 'SETTLEMENT_UNKNOWN' : 'PROVIDER_UNAVAILABLE');
    }
  }
  verify(p, r) { return this.call('verify', p, r); }
  settle(p, r) { return this.call('settle', p, r); }
  async supported(c) {
    const data = await this.call('supported');
    assert(data.kinds?.some((k) => k.x402Version === 2 && k.scheme === 'exact' && k.network === c.network), 'PROVIDER_UNSUPPORTED');
    // /supported alone does not attest this asset, the eventual transaction shape or billing terms.
    return data;
  }
}
