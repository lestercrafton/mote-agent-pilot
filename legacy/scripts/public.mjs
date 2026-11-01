import http from 'node:http';
import { Readable } from 'node:stream';
import { publicFetch } from '../src/public.mjs';

const port = Number(process.env.PORT ?? 8788);
const server = http.createServer(async (incoming, outgoing) => {
  try {
    const request = new Request(`http://127.0.0.1:${port}${incoming.url}`, { method: incoming.method, headers: incoming.headers, ...(incoming.method === 'GET' || incoming.method === 'HEAD' ? {} : { body: Readable.toWeb(incoming), duplex: 'half' }) });
    const response = await publicFetch(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch { outgoing.writeHead(400, { 'content-type': 'application/json' }); outgoing.end('{"error":{"code":"BAD_REQUEST"}}'); }
});
server.requestTimeout = 5000;
server.headersTimeout = 5000;
server.listen(port, '127.0.0.1', () => process.stdout.write(`Mote free utility: http://127.0.0.1:${port}/.well-known/mote.json\nNo payments, no chain, no durable storage.\n`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
