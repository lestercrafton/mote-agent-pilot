import { assert, uint } from './protocol.mjs';

// This is a durable authorization reservation, not a measurement or a promise
// about a provider invoice. No free tier, tax rate, refund or quota reset is assumed.
export function validateProviderBudget(value) {
  assert(value && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join(',') === 'authorizedMicrousd,reservePerAttemptMicrousd', 'PROVIDER_BUDGET');
  for (const amount of Object.values(value)) assert(uint(amount) && BigInt(amount) > 0n && BigInt(amount) <= 10n ** 15n, 'PROVIDER_BUDGET');
  assert(BigInt(value.reservePerAttemptMicrousd) <= BigInt(value.authorizedMicrousd), 'PROVIDER_BUDGET');
  return value;
}
export function providerReservation(limits, attempts) {
  assert(Number.isSafeInteger(attempts) && attempts >= 0, 'USAGE_CORRUPT');
  if (!limits.providerBudget) return null;
  const b = validateProviderBudget(limits.providerBudget);
  const reserved = BigInt(attempts) * BigInt(b.reservePerAttemptMicrousd);
  assert(reserved <= BigInt(b.authorizedMicrousd), 'USAGE_CORRUPT');
  return {
    authorizedMicrousd: b.authorizedMicrousd,
    reservedMicrousd: reserved.toString(),
    remainingMicrousd: (BigInt(b.authorizedMicrousd) - reserved).toString(),
    reservePerAttemptMicrousd: b.reservePerAttemptMicrousd,
    canReserve: reserved + BigInt(b.reservePerAttemptMicrousd) <= BigInt(b.authorizedMicrousd),
    invoiceCapGuaranteed: false,
  };
}
export const belowCountLimit = (count, limit) => limit === null || count < limit;
