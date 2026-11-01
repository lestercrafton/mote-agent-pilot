import { generateJwt } from '@coinbase/cdp-sdk/auth';
import { readLimitedText } from '@x402/core/http';
import { assert, fail, hash32, address } from './protocol.mjs';

export const CDP = 'https://api.cdp.coinbase.com/platform/v2/x402';
// API key only. Explicit arguments: no environment lookup, CDP wallet secret, account creation, or billing API.
export function cdpAuth({ apiKeyId, apiKeySecret }) {
  assert(typeof apiKeyId === 'string' && typeof apiKeySecret === 'string', 'CDP_CREDENTIALS_REQUIRED');
  return async (operation) => `Bearer ${await generateJwt({ apiKeyId, apiKeySecret, requestMethod: operation === 'supported' ? 'GET' : 'POST', requestHost: 'api.cdp.coinbase.com', requestPath: `/platform/v2/x402/${operation}`, expiresIn: 60 })}`;
}
export class CdpTransport {
  constructor({ auth, fetchImpl = fetch, timeoutMs = 15000 }) {
    assert(typeof auth === 'function' && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000, 'TRANSPORT_CONFIG');
    this.auth = auth; this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
  }
  async call(operation, paymentPayload, paymentRequirements) {
    assert(['verify', 'settle', 'supported'].includes(operation), 'OPERATION');
    try {
      const response = await this.fetch(`${CDP}/${operation}`, {
        method: operation === 'supported' ? 'GET' : 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: await this.auth(operation) },
        ...(operation === 'supported' ? {} : { body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      assert(response.ok && !response.redirected, 'PROVIDER_HTTP');
      const data = JSON.parse(await readLimitedText(response, 65536));
      assert(data && typeof data === 'object' && !Array.isArray(data), 'PROVIDER_SHAPE');
      if (operation === 'verify') assert(typeof data.isValid === 'boolean', 'PROVIDER_SHAPE');
      if (operation === 'settle') assert(typeof data.success === 'boolean', 'PROVIDER_SHAPE');
      return data;
    } catch { fail(operation === 'settle' ? 'SETTLEMENT_UNKNOWN' : 'PROVIDER_UNAVAILABLE'); }
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
