import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { publicDiscovery, publicFetch, publicOpenapi } from '../legacy/src/public.mjs';
import { testnetOrigin } from '../legacy/src/testnet-http.mjs';
import { assert } from './protocol.mjs';
import { readTransition } from './release-binding.mjs';

const legacySepolia = Object.freeze({ enabled: false, newAdmissionAllowed: false, recoveryAvailable: false, reason: 'SEPOLIA_PAUSED' });
const readiness = Object.freeze({ ready: true, freeAuditAvailable: true, legacySepolia });

// The explicitly paused service exposes the free utility without constructing
// a Sepolia RPC reader, quote signer, journal, or dispenser.
export async function startPausedLegacyHttp({ origin, port, host = '0.0.0.0' }) {
  origin = testnetOrigin(origin);
  const manifest = publicDiscovery(origin);
  delete manifest.mcp;
  manifest.payment.note = 'This free utility accepts no payments.';
  const openapi = publicOpenapi(origin);
  delete openapi.paths['/mcp'];
  let active = 0;
  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 7000, headersTimeout: 5000, keepAliveTimeout: 5000 }, async (req, res) => {
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(value));
    };
    if (active >= 32) { json(503, { error: { code: 'SERVICE_BUSY' } }); req.resume(); return; }
    active++;
    try {
      if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.length > 2048) return json(400, { error: { code: 'BAD_TARGET' } });
      const url = new URL(req.url, origin);
      if (url.origin !== origin) return json(400, { error: { code: 'BAD_TARGET' } });
      const { pathname } = url;
      if (['/v1/quotes', '/v1/orders', '/v1/recover', '/v1/dispenser'].some(path => pathname === path || pathname.startsWith(`${path}/`))) {
        return json(503, { error: { code: legacySepolia.reason, message: 'Ethereum Sepolia is paused. Retain the original offer, input and proof for recovery.' } });
      }
      if (req.method === 'GET' && (pathname === '/' || pathname === '/.well-known/mote.json')) {
        return json(200, { ...manifest, readiness: `${origin}/ready`, legacySepolia });
      }
      if (req.method === 'GET' && pathname === '/openapi.json') return json(200, openapi);
      if (req.method === 'GET' && pathname === '/health') return json(200, { service: 'mote-free-json', ...readiness });
      if (req.method === 'POST' && pathname === '/v1/audit') {
        const response = await publicFetch(new Request(url, { method: 'POST', headers: req.headers, body: Readable.toWeb(req), duplex: 'half' }));
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      return json(404, { error: { code: 'NOT_FOUND' } });
    } catch {
      if (!res.headersSent && !res.destroyed) json(503, { error: { code: 'SERVICE_UNAVAILABLE' } });
      else res.destroy();
    } finally { active--; if (!req.complete) req.resume(); }
  });
  server.maxConnections = 32;
  server.maxRequestsPerSocket = 100;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return {
    transport: { server },
    service: { readiness: async () => readiness },
    async close() {
      const closing = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closing;
    },
  };
}

export function startPausedLegacyFromEnvironment(env) {
  assert(env.MOTE_LEGACY_SEPOLIA_DISABLED === 'true', 'SEPOLIA_PAUSE_FLAG');
  readTransition(env);
  const port = Number(env.PORT ?? '10000');
  assert(Number.isSafeInteger(port) && port > 0 && port <= 65535, 'HTTP_PORT');
  return startPausedLegacyHttp({ origin: env.MOTE_PUBLIC_ORIGIN, port });
}
