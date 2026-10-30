import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { localApiOrigin } from '../scripts/mcp.mjs';
import { discovery, openapi } from '../src/discovery.mjs';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const quoteId = `0x${'11'.repeat(32)}`;
const transactionHash = `0x${'22'.repeat(32)}`;
const payer = `0x${'33'.repeat(20)}`;
const modernMeta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'mote-test', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

function startBridge(t, baseUrl) {
  const child = spawn(process.execPath, ['scripts/mcp.mjs'], { cwd, env: { ...process.env, MOTE_URL: baseUrl }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const pending = new Map();
  const reader = createInterface({ input: child.stdout });
  reader.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { assert.fail(`Non-JSON MCP stdout: ${line}`); }
    pending.get(message.id)?.resolve(message);
    pending.delete(message.id);
  });
  child.once('exit', (code) => {
    for (const request of pending.values()) request.reject(new Error(`MCP exited ${code}: ${stderr}`));
    pending.clear();
  });
  t.after(() => { child.kill(); reader.close(); });
  let id = 0;
  return async (method, params = {}) => {
    const requestId = ++id;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`MCP timed out: ${stderr}`)); }, 5000);
      pending.set(requestId, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
    return response;
  };
}

test('MCP refuses remote, credentialed, path and redirect-prone API origins', () => {
  assert.equal(localApiOrigin('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(localApiOrigin('http://[::1]:8787'), 'http://[::1]:8787');
  for (const url of ['https://127.0.0.1:8787', 'http://localhost:8787', 'http://example.com', 'http://127.0.0.1:8787/path', 'http://user:pass@127.0.0.1:8787', 'http://127.0.0.1:8787?redirect=remote']) {
    assert.throws(() => localApiOrigin(url), /loopback/);
  }
});

test('discovery is free metadata with explicit custom protocol and payment boundaries', () => {
  const config = { baseUrl: 'http://127.0.0.1:8787', chainId: 31337, token: payer, router: payer, recipient: payer, quoteSigner: payer };
  const manifest = discovery(config);
  assert.equal(manifest.protocols.x402.implemented, false);
  assert.equal(manifest.discovery.publiclyIndexed, false);
  assert.equal(manifest.permissions.discoveryConfersSpendPermission, false);
  assert.deepEqual(manifest.tips, { enabled: false, recipient: null });
  assert.equal(manifest.settlement.network, 'eip155:31337');
  assert.equal(openapi(config).paths['/v1/quotes'].post.parameters[0].name, 'Idempotency-Key');
});

test('MCP modern 2026-07-28 lists only non-spending tools and forwards discovery, quote and proof', async t => {
  const requests = [];
  const http = createServer(async (req, res) => {
    let body = '';
    for await (const data of req) body += data;
    requests.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : undefined, key: req.headers['idempotency-key'] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ fixture: true, path: req.url }));
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  t.after(() => new Promise(resolve => { http.closeAllConnections(); http.close(resolve); }));
  const rpc = startBridge(t, `http://127.0.0.1:${http.address().port}`);
  const list = await rpc('tools/list', { _meta: modernMeta });
  assert.equal(list.error, undefined, JSON.stringify(list));
  assert.deepEqual(list.result.tools.map(tool => tool.name).sort(), ['mote_discover', 'mote_order', 'mote_quote', 'mote_recover']);
  const discover = await rpc('tools/call', { _meta: modernMeta, name: 'mote_discover', arguments: {} });
  assert.equal(discover.error, undefined, JSON.stringify(discover));
  assert.equal(discover.result.isError, undefined);
  const quoted = await rpc('tools/call', { _meta: modernMeta, name: 'mote_quote', arguments: { payer, input: { document: { sample: true } }, idempotencyKey: 'quote-test-1' } });
  assert.equal(quoted.error, undefined, JSON.stringify(quoted));
  assert.equal(quoted.result.isError, undefined, JSON.stringify(quoted));
  const order = await rpc('tools/call', { _meta: modernMeta, name: 'mote_order', arguments: { quoteId, transactionHash, idempotencyKey: 'order-test-1' } });
  assert.equal(order.error, undefined, JSON.stringify(order));
  const recovered = await rpc('tools/call', { _meta: modernMeta, name: 'mote_recover', arguments: { quoteId } });
  assert.equal(recovered.error, undefined, JSON.stringify(recovered));
  assert.deepEqual(requests, [
    { method: 'GET', path: '/.well-known/mote.json', body: undefined, key: undefined },
    { method: 'POST', path: '/v1/quotes', body: { payer, input: { document: { sample: true } } }, key: 'quote-test-1' },
    { method: 'POST', path: '/v1/orders', body: { quoteId, transactionHash }, key: 'order-test-1' },
    { method: 'GET', path: `/v1/orders/${quoteId}`, body: undefined, key: undefined },
  ]);
});

test('MCP supports the negotiated 2025-11-25 legacy initialization', async t => {
  const rpc = startBridge(t, 'http://127.0.0.1:8787');
  const initialized = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'mote-test', version: '1.0.0' } });
  assert.equal(initialized.error, undefined, JSON.stringify(initialized));
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  const list = await rpc('tools/list');
  assert.equal(list.error, undefined, JSON.stringify(list));
  assert.equal(list.result.tools.length, 4);
});
