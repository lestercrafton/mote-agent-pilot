// Project-specific metadata. This is not an A2A Agent Card or x402 Bazaar registration.
import { LIMITS, SCHEMA_KEYWORDS } from './json.mjs';
const address = { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' };
const hash = { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' };
const integerString = { type: 'string', pattern: '^[0-9]+$' };
const idempotency = {
  name: 'Idempotency-Key', in: 'header', required: true,
  description: 'Stable identifier for this operation. Reuse it for identical retries; conflicting requests are rejected.',
  schema: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]{8,128}$' },
};

export function discovery(config) {
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  return {
    manifestVersion: '1', name: 'Mote', version: '0.1.0',
    description: 'Bounded JSON canonicalization, SHA-256 fingerprinting and optional schema validation. Demonstration utility; demand is unproven.',
    environment: 'local-development',
    discovery: { kind: 'project-specific', publiclyIndexed: false, url: `${baseUrl}/.well-known/mote.json` },
    protocols: {
      http: 'mote-local-v1',
      openapi: `${baseUrl}/openapi.json`,
      mcp: { transport: 'stdio', command: 'node scripts/mcp.mjs', sdk: '@modelcontextprotocol/server@2.4.0', supportedRevisions: ['2026-07-28', '2025-11-25'], spendsFunds: false },
      x402: { implemented: false, note: 'Custom local settlement protocol. No x402 payment headers, facilitator or Bazaar registration.' },
      a2a: { implemented: false },
    },
    free: ['health', 'discovery', 'openapi', 'quote'],
    capabilities: [{
      id: 'json.audit',
      input: { document: 'JSON value', schema: 'Optional restricted JSON Schema object or boolean; unsupported keywords are rejected.' },
      schema: { dialect: 'restricted draft-07 subset', keywords: SCHEMA_KEYWORDS, remoteReferences: false, regularExpressions: false },
      canonicalization: 'Mote v1 sorted UTF-16 object keys and ECMAScript JSON encoding; no RFC 8785 conformance claim.',
      output: ['canonical JSON', 'SHA-256 fingerprint', 'byte length', 'schema validation outcome'],
      quoteUrl: `${baseUrl}/v1/quotes`, orderUrl: `${baseUrl}/v1/orders`,
      recoveryUrlTemplate: `${baseUrl}/v1/orders/{quoteId}`,
      deterministic: true, externalFetches: false,
    }],
    limits: config.limits ?? LIMITS,
    pricing: {
      asset: 'MOTE', decimals: 6, arithmetic: 'integer base units only',
      formula: '1000 + 10 * canonicalInputByteLength', quoteTtlSeconds: 120,
      includesGas: false, gasPaidBy: 'payer', networkFeesAreSeparate: true,
      ...(config.pricing ?? {}),
    },
    settlement: {
      protocol: 'mote-local-v1', network: `eip155:${config.chainId}`, chainId: config.chainId,
      token: config.token, router: config.router, recipient: config.recipient, quoteSigner: config.quoteSigner,
      finality: 'Local EVM mined receipt, verified event and block hash; no public-chain finality claim.',
      quoteBinding: ['quoteId', 'requestHash', 'payer', 'amount', 'deadline', 'chainId', 'router'],
      contractBindings: ['immutable token', 'immutable merchant', 'immutable quoteSigner'],
      replayProtection: 'Router consumes each quoteId once. Identical HTTP retries recover the stored result and receipt.',
      failureRecovery: 'Result is prepared before the offer is issued. After payment, retry the same quote and transaction; never pay again to recover.',
      fixtureOnly: true, realMoney: false,
    },
    permissions: {
      discoveryConfersSpendPermission: false,
      requiresExplicitPayerAuthorization: true,
      clientChecks: ['service origin', 'payer', 'chain', 'token', 'router', 'recipient', 'quote signer', 'expiry', 'per-call budget', 'total budget', 'gas budget'],
      tokenApprovals: 'Exact amount only',
      autoTopup: false, swaps: false, bridging: false,
    },
    economics: { fixedSupply: true, peg: null, redemption: false, valueClaim: false, creatorRoyalty: false },
    tips: { enabled: false, recipient: null },
    privacy: { useOnlySyntheticInputs: true, note: 'Local prototype persists prepared results and receipts. Do not supply private data.' },
  };
}

export function openapi(config) {
  const jsonResponse = (description, schema = { type: 'object', additionalProperties: true }) => ({ description, content: { 'application/json': { schema } } });
  const errors = {
    '400': jsonResponse('Invalid request or unsupported input.'),
    '404': jsonResponse('Unknown quote or order.'),
    '409': jsonResponse('Conflicting idempotency key, payment proof or in-flight request.'),
    '413': jsonResponse('Request exceeds resource limits.'),
    '422': jsonResponse('Payment proof or schema is invalid.'),
    '503': jsonResponse('Settlement status cannot be determined. Retry reconciliation without paying again.'),
  };
  return {
    openapi: '3.1.0',
    info: { title: 'Mote local development API', version: '0.1.0', description: 'Custom local-only payment protocol. Discovery and quotes are free. MOTE fixture balances have no monetary value. This API does not sign or send payments.' },
    servers: [{ url: config.baseUrl.replace(/\/$/, '') }],
    paths: {
      '/health': { get: { operationId: 'health', summary: 'Free health status', responses: { '200': jsonResponse('Local service status') } } },
      '/.well-known/mote.json': { get: { operationId: 'discover', summary: 'Free project-specific manifest', responses: { '200': jsonResponse('Capabilities, prices and payment boundaries') } } },
      '/openapi.json': { get: { operationId: 'openapi', summary: 'Free API description', responses: { '200': jsonResponse('This OpenAPI document') } } },
      '/v1/quotes': { post: {
        operationId: 'quote', summary: 'Prepare a bounded deterministic result and quote its exact cost without charging',
        parameters: [idempotency],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/QuoteRequest' } } } },
        responses: { '200': jsonResponse('Exact signed offer. No payment has occurred.', { $ref: '#/components/schemas/Offer' }), ...errors },
      } },
      '/v1/orders': { post: {
        operationId: 'submitPaymentProof', summary: 'Verify an already mined local payment and recover its result',
        description: 'Does not submit a transaction. Reuse the same quoteId, transactionHash and Idempotency-Key after dropped responses.',
        parameters: [idempotency],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['quoteId', 'transactionHash'], additionalProperties: false, properties: { quoteId: hash, transactionHash: hash } } } } },
        responses: { '200': jsonResponse('Prepared result and receipt; identical retries return the same stored response.'), '202': jsonResponse('Payment has not been confirmed. Reconcile the same transaction; do not pay again.'), ...errors },
      } },
      '/v1/orders/{quoteId}': { get: {
        operationId: 'recoverOrder', summary: 'Recover a stored order without another payment',
        parameters: [{ name: 'quoteId', in: 'path', required: true, schema: hash }],
        responses: { '200': jsonResponse('Order status, or its completed result and receipt.'), ...errors },
      } },
    },
    components: { schemas: {
      QuoteRequest: { type: 'object', required: ['payer', 'input'], additionalProperties: false, properties: {
        payer: address, input: { type: 'object', required: ['document'], additionalProperties: false, properties: { document: {}, schema: { anyOf: [{ type: 'object', additionalProperties: true }, { type: 'boolean' }], description: 'Restricted draft-07 subset. Unsupported keywords are rejected; consult the manifest and project documentation.' } } },
      } },
      Offer: { type: 'object', required: ['protocol', 'quote', 'domain', 'signature', 'offerSignature', 'chainId', 'token', 'router', 'recipient', 'resultHash'], properties: {
        protocol: { const: 'mote-local-v1' }, chainId: { const: config.chainId },
        token: address, router: address, recipient: address,
        decimals: { const: 6 }, asset: { const: 'MOTE' }, service: { const: 'json.audit' },
        resultHash: hash, expiresAt: { description: 'Quote expiration; deadline in the signed quote is authoritative.' },
        signature: { type: 'string', pattern: '^0x[0-9a-fA-F]+$' },
        offerSignature: { type: 'string', description: 'EIP-191 signature by quoteSigner over canonical JSON of the complete offer excluding this field; authenticates the promised result hash.', pattern: '^0x[0-9a-fA-F]+$' },
        domain: { type: 'object', required: ['name', 'version', 'chainId', 'verifyingContract'], properties: { name: { const: 'MotePayments' }, version: { const: '1' }, chainId: { const: config.chainId }, verifyingContract: address } },
        quote: { type: 'object', required: ['quoteId', 'requestHash', 'payer', 'amount', 'deadline'], properties: { quoteId: hash, requestHash: hash, payer: address, amount: integerString, deadline: { anyOf: [integerString, { type: 'integer', minimum: 0 }] } } },
      } },
    } },
  };
}
