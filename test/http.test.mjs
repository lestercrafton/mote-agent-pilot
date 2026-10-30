import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { id } from 'ethers';
import { createLocalChain } from '../src/chain.mjs';
import { createService } from '../src/service.mjs';
import { startHttp } from '../src/http.mjs';

let chain;
let service;
let server;
let payer;
let sequence = 0;
const idem = () => `http-test-${++sequence}`;
const defaultInput = { document: { ok: true } };

before(async () => {
  chain = await createLocalChain();
  payer = await chain.payer.getAddress();
  service = await createService({ chain });
  server = await startHttp({ service });
});
after(async () => { await server?.close(); service?.close(); await chain?.close(); });

async function post(path, body, headers = {}) {
  return fetch(`${server.baseUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': idem(), ...headers },
    body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
}
async function errorCode(response, expectedStatus, expectedCode) {
  assert.equal(response.status, expectedStatus);
  const body = await response.json();
  assert.equal(body.error.code, expectedCode);
  return body;
}

test('free root, manifest, OpenAPI and health provide truthful local discovery without spending', async () => {
  const balance = await chain.token.balanceOf(payer);
  const root = await fetch(server.baseUrl);
  assert.equal(root.status, 200);
  assert.match(root.headers.get('content-type'), /application\/json/);
  assert.equal(root.headers.get('cache-control'), 'no-store');
  const manifest = await root.json();
  assert.equal(manifest.name, 'Mote');
  assert.equal(manifest.protocols.x402.implemented, false);
  assert.equal(manifest.settlement.fixtureOnly, true);
  assert.equal(manifest.settlement.realMoney, false);
  assert.equal(manifest.tips.enabled, false);
  assert.deepEqual(await (await fetch(`${server.baseUrl}/.well-known/mote.json`)).json(), manifest);
  const spec = await (await fetch(manifest.protocols.openapi)).json();
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(spec.servers[0].url, server.baseUrl);
  for (const path of ['/v1/quotes', '/v1/orders', '/v1/orders/{quoteId}']) assert.ok(spec.paths[path]);
  const health = await (await fetch(`${server.baseUrl}/health`)).json();
  assert.equal(health.status, 'ok');
  assert.equal(health.localOnly, true);
  assert.equal(await chain.token.balanceOf(payer), balance);
});

test('HTTP quote retries preserve exact offer; conflicting key rejects changed input', async () => {
  const key = idem();
  const headers = { 'idempotency-key': key };
  const request = { payer, input: defaultInput };
  const first = await post('/v1/quotes', request, headers);
  assert.equal(first.status, 200);
  const offer = await first.json();
  assert.deepEqual(await (await post('/v1/quotes', request, headers)).json(), offer);
  await errorCode(await post('/v1/quotes', { payer, input: { document: false } }, headers), 409, 'IDEMPOTENCY_CONFLICT');
  const pending = await (await fetch(`${server.baseUrl}/v1/orders/${offer.quote.quoteId}`)).json();
  assert.equal(pending.status, 'awaiting_payment');
});

test('HTTP payment proof and result recovery complete once on the local chain', async () => {
  const offer = await (await post('/v1/quotes', { payer, input: defaultInput })).json();
  const balance = await chain.token.balanceOf(payer);
  await (await chain.token.connect(chain.payer).approve(await chain.payments.getAddress(), BigInt(offer.quote.amount))).wait();
  const tx = await chain.payments.connect(chain.payer).pay(offer.quote, offer.signature);
  await tx.wait();
  const proof = { quoteId: offer.quote.quoteId, transactionHash: tx.hash };
  const headers = { 'idempotency-key': idem() };
  const response = await post('/v1/orders', proof, headers);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.result.canonicalJson, '{"ok":true}');
  assert.equal(result.receipt.transactionHash, tx.hash);
  assert.deepEqual(await (await post('/v1/orders', proof, headers)).json(), result);
  assert.deepEqual(await (await fetch(`${server.baseUrl}/v1/orders/${offer.quote.quoteId}`)).json(), result);
  assert.equal(await chain.token.balanceOf(payer), balance - BigInt(offer.quote.amount));
});

test('malformed JSON, wrong envelope, unsupported fields and absent idempotency fail clearly', async () => {
  await errorCode(await post('/v1/quotes', '{'), 400, 'INVALID_JSON');
  for (const body of ['null', '[]', 'true', '1']) await errorCode(await post('/v1/quotes', body), 400, 'INVALID_INPUT');
  await errorCode(await post('/v1/quotes', { payer, input: defaultInput, surprise: true }), 400, 'INVALID_INPUT');
  await errorCode(await post('/v1/quotes', { payer, input: defaultInput }, { 'idempotency-key': '' }), 400, 'INVALID_IDEMPOTENCY_KEY');
  await errorCode(await post('/v1/quotes', { payer, input: defaultInput }, { 'content-type': 'text/plain' }), 415, 'CONTENT_TYPE');
  await errorCode(await post('/v1/orders', { quoteId: 'not-a-hash', transactionHash: 'oops' }), 400, 'INVALID_PROOF');
  await errorCode(await fetch(`${server.baseUrl}/not-present`), 404, 'NOT_FOUND');
});

test('unknown transaction produces a pending status, never a success result or second payment', async () => {
  const offer = await (await post('/v1/quotes', { payer, input: defaultInput })).json();
  const balance = await chain.token.balanceOf(payer);
  const response = await post('/v1/orders', { quoteId: offer.quote.quoteId, transactionHash: id('http-never-submitted') });
  const body = await errorCode(response, 202, 'SETTLEMENT_PENDING');
  assert.equal(Object.hasOwn(body, 'result'), false);
  assert.equal(await chain.token.balanceOf(payer), balance);
});

test('local HTTP rejects browser cross-origin and DNS-rebinding Host headers', async () => {
  await errorCode(await fetch(`${server.baseUrl}/health`, { headers: { Origin: 'https://untrusted.invalid' } }), 403, 'ORIGIN_REJECTED');
  const sameOrigin = await fetch(`${server.baseUrl}/health`, { headers: { Origin: server.baseUrl } });
  assert.equal(sameOrigin.status, 200);
  const hostResponse = await new Promise((resolve, reject) => {
    const req = http.request(`${server.baseUrl}/health`, { headers: { Host: 'untrusted.invalid' } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(hostResponse.status, 403);
  assert.equal(hostResponse.body.error.code, 'HOST_REJECTED');
});

test('body, nesting and node limits reject resource abuse before issuing offers', async () => {
  await errorCode(await post('/v1/quotes', { payer, input: { document: 'x'.repeat(70000) } }), 413, 'BODY_TOO_LARGE');
  let document = true;
  for (let i = 0; i < 20; i++) document = { nested: document };
  await errorCode(await post('/v1/quotes', { payer, input: { document } }), 400, 'RESOURCE_LIMIT');
  await errorCode(await post('/v1/quotes', { payer, input: { document: Array(4100).fill(0) } }), 400, 'RESOURCE_LIMIT');
});

test('duplicate decoded JSON keys and invalid UTF-8 are rejected instead of silently normalized', async () => {
  const envelope = (document) => `{"payer":"${payer}","input":{"document":${document}}}`;
  await errorCode(await post('/v1/quotes', envelope('{"x":1,"x":2}')), 400, 'DUPLICATE_KEY');
  await errorCode(await post('/v1/quotes', envelope('{"x":1,"\\u0078":2}')), 400, 'DUPLICATE_KEY');
  await errorCode(await post('/v1/quotes', envelope('{"list":[{"key":1,"key":2}]}')), 400, 'DUPLICATE_KEY');
  const invalidUtf8 = Buffer.concat([
    Buffer.from(`{"payer":"${payer}","input":{"document":"`),
    Buffer.from([0xff]), Buffer.from('"}}'),
  ]);
  await errorCode(await post('/v1/quotes', invalidUtf8), 400, 'INVALID_JSON');
  // Repeated keys in separate objects and quoted key-like text are ordinary data.
  const response = await post('/v1/quotes', { payer, input: { document: [{ x: 1 }, { x: 2 }, '"x":1,"x":2'] } });
  assert.equal(response.status, 200);
});

test('very deep JSON and unsafe integers produce bounded client errors', async () => {
  const deeplyNested = '['.repeat(1000) + '0' + ']'.repeat(1000);
  await errorCode(await post('/v1/quotes', `{"payer":"${payer}","input":{"document":${deeplyNested}}}`), 400, 'RESOURCE_LIMIT');
  await errorCode(await post('/v1/quotes', { payer, input: { document: 9007199254740992 } }), 400, 'UNSAFE_NUMBER');
});
