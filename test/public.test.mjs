import test from 'node:test';
import assert from 'node:assert/strict';
import { publicFetch } from '../src/public.mjs';
import { prepareAudit } from '../src/json.mjs';

const get = (path) => publicFetch(new Request(`https://mote.example${path}`));
const post = (path, body, headers = { 'content-type': 'application/json' }) => publicFetch(new Request(`https://mote.example${path}`, { method: 'POST', headers, body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) }));

test('free discovery exposes exact paths, zero cost, limits, and honest settlement state', async () => {
  const manifest = await (await get('/.well-known/mote.json')).json();
  assert.equal(manifest.operations[0].cost.amount, '0');
  assert.equal(manifest.payment.supported, false);
  assert.equal(manifest.operations[0].url, 'https://mote.example/v1/audit');
  assert.equal(manifest.canonicalization.duplicateKeys, 'rejected, including escaped equivalents');
  assert.equal((await (await get('/openapi.json')).json()).openapi, '3.1.0');
  assert.equal((await (await get('/health')).json()).publicTokenSettlement, false);
});

test('public and local modes produce identical core results with explicit free hash receipt', async () => {
  const input = { document: { b: 'second', a: 1 }, schema: { type: 'object', required: ['a'], properties: { a: { type: 'integer' } } } };
  const result = await post('/v1/audit', input);
  assert.equal(result.status, 200);
  const data = await result.json();
  assert.deepEqual(data.result, prepareAudit(input).result);
  assert.equal(data.receipt.resultHash, prepareAudit(input).resultHash);
  assert.equal(data.receipt.settlement, 'none');
  assert.equal(data.receipt.signature, null);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const retry = await (await post('/v1/audit', input)).json();
  assert.deepEqual(retry, data);
});

test('public parser rejects duplicate, malformed, over-limit, and invalid UTF-8 inputs', async () => {
  for (const raw of ['{"document":{"a":1,"a":2}}', '{"document":{"a":1,"\\u0061":2}}']) {
    const response = await post('/v1/audit', raw);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'DUPLICATE_KEY');
  }
  assert.equal((await post('/v1/audit', '{')).status, 400);
  assert.equal((await post('/v1/audit', new Uint8Array([0xff]))).status, 400);
  assert.equal((await post('/v1/audit', 'x'.repeat(65537))).status, 413);
  assert.equal((await post('/v1/audit', { document: Array(1025).fill(1) })).status, 400);
  assert.equal((await post('/v1/audit', '{}', { 'content-type': 'text/plain' })).status, 415);
  const stringData = { document: ['{"not":"structure"}', '\\', '"', [true]] };
  assert.equal((await post('/v1/audit', stringData)).status, 200);
});

test('schema failure is a useful successful response, unsupported schema is a caller error', async () => {
  const mismatch = await (await post('/v1/audit', { document: { count: 'wrong' }, schema: { properties: { count: { type: 'integer' } } } })).json();
  assert.equal(mismatch.result.valid, false);
  assert.equal(mismatch.result.errors[0].instancePath, '/count');
  const unsupported = await post('/v1/audit', { document: 'a', schema: { pattern: '.*' } });
  assert.equal(unsupported.status, 400);
  assert.equal((await unsupported.json()).error.code, 'UNSUPPORTED_SCHEMA');
});

test('stateless MCP discovers and calls only the free bounded audit tool', async () => {
  const call = async (method, params = {}) => (await post('/mcp', { jsonrpc: '2.0', id: 1, method, params })).json();
  assert.deepEqual((await call('server/discover')).result.supportedVersions, ['2026-07-28']);
  assert.equal((await call('tools/list')).result.tools[0].name, 'mote_audit');
  const result = await call('tools/call', { name: 'mote_audit', arguments: { document: [3, 1] } });
  assert.equal(result.result.structuredContent.result.canonicalJson, '[3,1]');
  assert.equal(result.result.structuredContent.receipt.amount, '0');
  assert.equal(result.result.isError, false);
  assert.equal((await call('tools/call', { name: 'mote_audit', arguments: {} })).result.isError, true);
  assert.equal((await call('pay_tokens')).error.code, -32601);
});

test('stalled streamed body times out and is canceled without execution', async () => {
  let canceled = false;
  const body = new ReadableStream({ start() {}, cancel() { canceled = true; } });
  const result = await publicFetch(new Request('https://mote.example/v1/audit', { method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half' }));
  assert.equal(result.status, 408);
  assert.equal((await result.json()).error.code, 'REQUEST_TIMEOUT');
  assert.equal(canceled, true);
});
