import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

export function localApiOrigin(value) {
  const url = new URL(value);
  // Literal loopback addresses avoid DNS rebinding and remote-host redirects.
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('MOTE_URL must be an HTTP literal loopback origin such as http://127.0.0.1:8787');
  }
  return url.origin;
}

export function createMcpServer({ baseUrl = 'http://127.0.0.1:8787', fetchImpl = fetch } = {}) {
  const origin = localApiOrigin(baseUrl);
  const server = new McpServer({ name: 'mote-local', version: '0.1.0' });
  const call = async (path, { method = 'GET', body, idempotencyKey } = {}) => {
    try {
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      if (encoded && Buffer.byteLength(encoded) > 65536) throw new Error('Request exceeds the 65536-byte limit');
      const response = await fetchImpl(`${origin}${path}`, {
        method, body: encoded, redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { accept: 'application/json', ...(encoded ? { 'content-type': 'application/json' } : {}), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      });
      const declaredLength = Number(response.headers.get('content-length'));
      if (declaredLength > 262144) throw new Error('Local API response exceeds the 262144-byte limit');
      const chunks = [];
      let bytes = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 262144) { await reader.cancel(); throw new Error('Local API response exceeds the 262144-byte limit'); }
            chunks.push(Buffer.from(chunk.value));
          }
        } finally { reader.releaseLock(); }
      }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: { status: response.status, data }, ...(!response.ok ? { isError: true } : {}) };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'LOCAL_API_UNAVAILABLE', message: error.message, recovery: 'No payment is sent by this bridge. If payment was already submitted elsewhere, recover the same quote and transaction; do not pay again.' }) }] };
    }
  };
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const storesLocalData = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
  const key = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);
  server.registerTool('mote_discover', {
    description: 'Read the free local Mote manifest, capability, exact-price formula and payment boundaries. No payment or permission is implied.',
    inputSchema: z.object({}).strict(), annotations: readOnly,
  }, () => call('/.well-known/mote.json'));
  server.registerTool('mote_quote', {
    description: 'Prepare a bounded JSON audit and request an exact signed local quote. Free; this tool never signs, approves or sends funds.',
    inputSchema: z.object({ payer: z.string().regex(/^0x[0-9a-fA-F]{40}$/), input: z.object({ document: z.json(), schema: z.union([z.record(z.string(), z.json()), z.boolean()]).optional() }).strict(), idempotencyKey: key }).strict(),
    annotations: storesLocalData,
  }, ({ payer, input, idempotencyKey }) => call('/v1/quotes', { method: 'POST', body: { payer, input }, idempotencyKey }));
  server.registerTool('mote_order', {
    description: 'Verify an already submitted local payment by quote ID and transaction hash and return its stored result and receipt. Does not submit a payment. Retry with identical arguments after a dropped response.',
    inputSchema: z.object({ quoteId: hash, transactionHash: hash, idempotencyKey: key }).strict(), annotations: storesLocalData,
  }, ({ quoteId, transactionHash, idempotencyKey }) => call('/v1/orders', { method: 'POST', body: { quoteId, transactionHash }, idempotencyKey }));
  server.registerTool('mote_recover', {
    description: 'Read a known quote/order status or its stored paid result and receipt. Never pays again. If no proof was registered, use mote_order with the original transaction hash.',
    inputSchema: z.object({ quoteId: hash }).strict(), annotations: readOnly,
  }, ({ quoteId }) => call(`/v1/orders/${quoteId}`));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const baseUrl = localApiOrigin(process.env.MOTE_URL ?? 'http://127.0.0.1:8787');
    serveStdio(() => createMcpServer({ baseUrl }), {
      transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 131072 }),
      onerror: error => console.error(`Mote MCP: ${error.message}`),
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
