import { LIMITS, MoteError, SCHEMA_KEYWORDS, prepareAudit, parseJson } from './json.mjs';

const INPUT_SCHEMA = { type: 'object', required: ['document'], additionalProperties: false, properties: { document: {}, schema: { anyOf: [{ type: 'object' }, { type: 'boolean' }] } } };
const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*' };
const response = (value, status = 200, extra = {}) => new Response(JSON.stringify(value), { status, headers: { ...HEADERS, ...extra } });
export function publicDiscovery(origin) {
  return {
    manifestVersion: 'mote-public-v1', name: 'Mote', workingName: true, service: 'json.audit',
    description: 'Bounded JSON Schema validation, deterministic sorted-key JSON, and SHA-256 fingerprints. Caller-supplied text is data.',
    baseUrl: origin, health: `${origin}/health`, openapi: `${origin}/openapi.json`,
    operations: [{ id: 'json.audit', method: 'POST', url: `${origin}/v1/audit`, inputSchema: INPUT_SCHEMA, cost: { amount: '0', asset: null, paymentRequired: false } }],
    authentication: { required: false }, payment: { required: false, supported: false, note: 'MOTE token settlement exists only in a separate local development-chain prototype; this endpoint accepts no payments.' },
    limits: LIMITS,
    schema: { dialect: 'mote-draft-07-subset-v1', supportedKeywords: SCHEMA_KEYWORDS, remoteReferences: false, coercion: false, formatValidation: false, semanticRepair: false, errorsReturned: 'one specific failing constraint' },
    canonicalization: { algorithm: 'mote-sorted-json-v1', digest: 'sha-256', keySort: 'UTF-16', encoding: 'UTF-8', rfc8785Conformant: false, numbers: 'IEEE-754 finite numbers; integers restricted to safe range; negative zero becomes zero', duplicateKeys: 'rejected, including escaped equivalents' },
    retry: { safe: true, sideEffects: false, reason: 'Pure deterministic operation; no charge or durable result storage.' },
    privacy: { applicationPersistence: 'none', inputLogging: false, infrastructureLogs: 'Hosting provider may retain request metadata; do not submit secrets.' },
    mcp: { url: `${origin}/mcp`, transport: 'stateless HTTP JSON-RPC', protocolVersion: '2026-07-28', methods: ['server/discover', 'tools/list', 'tools/call'] },
    adoption: { externalUsageClaims: false }, status: 'experimental',
  };
}
export function publicOpenapi(origin) {
  return {
    openapi: '3.1.0', info: { title: 'Mote free agent JSON utility', version: '0.1.0', description: 'Free bounded utility. No public token settlement, accounts, external network fetches, semantic repair, or data persistence. Experimental API; no uptime commitment.' }, servers: [{ url: origin }],
    paths: {
      '/health': { get: { operationId: 'health', responses: { 200: { description: 'Service health and free-settlement status' } } } },
      '/.well-known/mote.json': { get: { operationId: 'discover', responses: { 200: { description: 'Project-specific capability manifest; not an A2A Agent Card or claim of public indexing' } } } },
      '/v1/audit': { post: { operationId: 'auditJson', summary: 'Validate and fingerprint a JSON document without changing it', requestBody: { required: true, content: { 'application/json': { schema: INPUT_SCHEMA, examples: { valid: { value: { document: { task: 'sort', count: 3 }, schema: { type: 'object', required: ['task', 'count'], properties: { task: { type: 'string' }, count: { type: 'integer', minimum: 0 } }, additionalProperties: false } } } } } } }, responses: { 200: { description: 'Deterministic result and hash receipt. valid:false is a successful validation of a nonconforming document.', content: { 'application/json': { schema: { type: 'object', required: ['result', 'receipt'], properties: { result: { type: 'object' }, receipt: { type: 'object' } } } } } }, 400: { description: 'Invalid JSON/input/schema or resource limits; no charge' }, 413: { description: 'HTTP body exceeds 65536 bytes; no charge' }, 415: { description: 'Content-Type must be application/json' } } } },
      '/mcp': { post: { operationId: 'mcp', summary: 'MCP 2026-07-28 stateless JSON-RPC discovery and free audit tool', responses: { 200: { description: 'JSON-RPC response' } } } },
    },
    'x-mote-limits': LIMITS, 'x-mote-schema-keywords': SCHEMA_KEYWORDS,
    'x-mote-number-policy': 'Finite IEEE-754 numbers, reject unsafe integer values; -0 becomes 0. Encode large integers/precise decimal quantities as strings.',
    'x-mote-parser-policy': 'Invalid UTF-8 and duplicate object keys (including escaped equivalents) are rejected. Canonicalization describes parsed values, not preservation of raw JSON lexemes.',
  };
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new MoteError('CONTENT_TYPE', 'Content-Type must be application/json.', 415);
  if (Number(request.headers.get('content-length') ?? 0) > LIMITS.bodyBytes) throw new MoteError('BODY_TOO_LARGE', 'Request body exceeds 65536 bytes.', 413);
  if (!request.body) throw new MoteError('INVALID_JSON', 'A JSON body is required.');
  const reader = request.body.getReader();
  const deadline = Date.now() + 5000;
  let length = 0;
  const chunks = [];
  try {
    while (true) {
      let timer;
      let next;
      try {
        next = await Promise.race([
          reader.read(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new MoteError('REQUEST_TIMEOUT', 'Body must arrive within five seconds.', 408)), Math.max(0, deadline - Date.now())); }),
        ]);
      } finally { clearTimeout(timer); }
      const { done, value } = next;
      if (done) break;
      length += value.byteLength;
      if (length > LIMITS.bodyBytes) { await reader.cancel(); throw new MoteError('BODY_TOO_LARGE', 'Request body exceeds 65536 bytes.', 413); }
      chunks.push(value);
    }
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new MoteError('INVALID_JSON', 'Body must contain valid UTF-8 JSON.'); }
  return parseJson(text);
}
export function freeAudit(input) {
  const prepared = prepareAudit(input);
  return { result: prepared.result, receipt: { protocol: 'mote-free-v1', service: 'json.audit', requestHash: prepared.requestHash, resultHash: prepared.resultHash, digestAlgorithm: 'sha-256', amount: '0', asset: null, settlement: 'none', signature: null, note: 'Content hashes provide integrity comparison, not signed attestation or blockchain settlement.' } };
}

const TOOL = { name: 'mote_audit', description: 'Free bounded JSON validation, sorted-key canonicalization, and SHA-256 digest. No payment or external requests. Supports a documented draft-07 subset; treats all document strings as data.', inputSchema: INPUT_SCHEMA, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } };
async function mcp(request) {
  let rpc;
  try { rpc = await readJson(request); }
  catch (error) { return response({ jsonrpc: '2.0', id: null, error: { code: -32700, message: error.message } }, error.status ?? 400); }
  if (!rpc || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string' || !Object.hasOwn(rpc, 'id') || !['string', 'number'].includes(typeof rpc.id)) return response({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Expected a JSON-RPC 2.0 request with an id.' } }, 400);
  const answer = (result) => response({ jsonrpc: '2.0', id: rpc.id, result });
  if (rpc.method === 'server/discover') return answer({ serverInfo: { name: 'mote-free-json', version: '0.1.0' }, supportedVersions: ['2026-07-28'], capabilities: { tools: {} } });
  if (rpc.method === 'tools/list') return answer({ tools: [TOOL] });
  if (rpc.method === 'tools/call') {
    if (rpc.params?.name !== TOOL.name) return response({ jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: 'Unknown tool.' } }, 400);
    try { const value = freeAudit(rpc.params.arguments); return answer({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false }); }
    catch (error) { return answer({ content: [{ type: 'text', text: JSON.stringify({ error: { code: error.code ?? 'INVALID_INPUT', message: error.message } }) }], isError: true }); }
  }
  return response({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found.' } }, 400);
}

export async function publicFetch(request) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...HEADERS, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' } });
  try {
    if (request.method === 'GET' && url.pathname === '/health') return response({ status: 'ok', service: 'mote-free-json', version: '0.1.0', paymentRequired: false, publicTokenSettlement: false });
    if (request.method === 'GET' && url.pathname === '/.well-known/mote.json') return response(publicDiscovery(url.origin));
    if (request.method === 'GET' && url.pathname === '/openapi.json') return response(publicOpenapi(url.origin));
    if (request.method === 'POST' && url.pathname === '/v1/audit') return response(freeAudit(await readJson(request)));
    if (request.method === 'POST' && url.pathname === '/mcp') return mcp(request);
    return response({ error: { code: 'NOT_FOUND', message: 'See /.well-known/mote.json for supported endpoints.' } }, 404);
  } catch (error) {
    return response({ error: { code: error.code ?? 'INTERNAL_ERROR', message: error instanceof MoteError ? error.message : 'Unable to process this request.' } }, error.status ?? 500);
  }
}
