import http from 'node:http';
import { MoteError, LIMITS, parseJson } from './json.mjs';
import { discovery, openapi } from './discovery.mjs';

export async function startHttp({ service, port = 0 }) {
  let baseUrl;
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(body));
    };
    try {
      const expectedHost = new URL(baseUrl).host;
      if (req.headers.host !== expectedHost) throw new MoteError('HOST_REJECTED', 'Unexpected Host header.', 403);
      if (req.headers.origin && req.headers.origin !== baseUrl) throw new MoteError('ORIGIN_REJECTED', 'Cross-origin local API requests are disabled.', 403);
      const path = new URL(req.url, baseUrl).pathname;
      const config = { ...service.config, baseUrl };
      if (req.method === 'GET') {
        if (path === '/' || path === '/.well-known/mote.json') return send(200, discovery(config));
        if (path === '/openapi.json') return send(200, openapi(config));
        if (path === '/health') return send(200, { status: 'ok', service: 'mote', version: '0.1.0', mode: 'local-evm-fixture', localOnly: true });
        const match = path.match(/^\/v1\/orders\/(0x[0-9a-fA-F]{64})$/);
        if (match) return send(200, await service.order(match[1]));
      }
      if (req.method === 'POST' && ['/v1/quotes', '/v1/orders'].includes(path)) {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new MoteError('CONTENT_TYPE', 'Use application/json.', 415);
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > LIMITS.bodyBytes) throw new MoteError('BODY_TOO_LARGE', 'Request body exceeds 64 KiB.', 413);
          chunks.push(chunk);
        }
        let body;
        try { body = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
        catch (error) { if (error instanceof MoteError) throw error; throw new MoteError('INVALID_JSON', 'Malformed UTF-8 JSON.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new MoteError('INVALID_INPUT', 'Expected a JSON object.');
        const allowed = path === '/v1/quotes' ? ['payer', 'input'] : ['quoteId', 'transactionHash'];
        if (Object.keys(body).some((key) => !allowed.includes(key))) throw new MoteError('INVALID_INPUT', 'Unexpected request property.');
        const operation = path === '/v1/quotes' ? service.quote : service.settle;
        return send(200, await operation(body, req.headers['idempotency-key']));
      }
      throw new MoteError('NOT_FOUND', 'Endpoint not found; inspect /.well-known/mote.json.', 404);
    } catch (error) {
      if (!res.headersSent) send(error instanceof MoteError ? error.status : 500, { error: { code: error instanceof MoteError ? error.code : 'INTERNAL_ERROR', message: error instanceof MoteError ? error.message : 'Internal error. Retry or recover using the same quote and payment proof; do not pay again.' } });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, async close() { server.closeAllConnections(); await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
}
