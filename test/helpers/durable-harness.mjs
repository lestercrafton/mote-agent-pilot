import { createServer, request as httpRequest } from 'node:http';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLocalChain } from '../../src/chain.mjs';
import { createService } from '../../src/service.mjs';
import { startHttp } from '../../src/http.mjs';

const workerPath = fileURLToPath(new URL('../fixtures/durable-worker.mjs', import.meta.url));
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function closeServer(server) {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

/** Real local EVM shared only by fixture child processes; never connects to public RPC. */
export async function createDurableHarness() {
  const chain = await createLocalChain();
  let service, api, rpcServer, proxyServer;
  const sends = [];
  const requests = [];
  let dropOrders = 0;
  try {
    service = await createService({ chain, ttlSeconds: 600 });
    api = await startHttp({ service });
    rpcServer = createServer(async (req, res) => {
      try {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 1_048_576) throw new Error('Fixture RPC request limit exceeded');
        }
        const raw = JSON.parse(body);
        const execute = async (call) => {
          let entry;
          if (['eth_sendTransaction', 'eth_sendRawTransaction'].includes(call.method)) {
            entry = { method: call.method, transaction: structuredClone(call.params?.[0]), hash: null, rejected: false };
            sends.push(entry);
          }
          try {
            const result = await chain.eip1193.request({ method: call.method, params: call.params ?? [] });
            if (entry) entry.hash = result;
            return { jsonrpc: '2.0', id: call.id, result };
          } catch (error) {
            if (entry) entry.rejected = true;
            return { jsonrpc: '2.0', id: call.id, error: { code: typeof error.code === 'number' ? error.code : -32000, message: error.message, data: error.data } };
          }
        };
        const result = Array.isArray(raw) ? await Promise.all(raw.map(execute)) : await execute(raw);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });
    const rpcUrl = await listen(rpcServer);
    // Fault injection happens after the actual service has committed a response.
    proxyServer = createServer((req, res) => {
      requests.push({ method: req.method, path: req.url });
      const upstream = httpRequest(new URL(req.url, api.baseUrl), { method: req.method, headers: { ...req.headers, host: new URL(api.baseUrl).host } }, (reply) => {
        const chunks = [];
        reply.on('data', (chunk) => chunks.push(chunk));
        reply.on('end', () => {
          if (req.method === 'POST' && req.url === '/v1/orders' && reply.statusCode === 200 && dropOrders > 0) {
            dropOrders--;
            req.socket.destroy();
            return;
          }
          res.writeHead(reply.statusCode, reply.headers);
          res.end(Buffer.concat(chunks));
        });
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream);
    });
    const baseUrl = await listen(proxyServer);
    const payer = await chain.payer.getAddress();
    const policy = {
      enabled: true, ...service.config, payer, serviceOrigin: baseUrl,
      maxSingleSpend: '100000', maxTotalSpend: '1000000',
      maxGasPerTransactionWei: '10000000000000000', maxGasTotalWei: '100000000000000000',
    };
    return {
      chain, service, baseUrl, rpcUrl, policy, payer, sends, requests,
      dropNextOrderResponse() { dropOrders++; },
      quote(input, key) { return service.quote({ payer, input }, key); },
      sendCounts() {
        return {
          total: sends.length,
          approve: sends.filter((entry) => entry.transaction?.to?.toLowerCase() === service.config.token.toLowerCase() && entry.transaction?.data?.startsWith('0x095ea7b3')).length,
          pay: sends.filter((entry) => entry.transaction?.to?.toLowerCase() === service.config.router.toLowerCase()).length,
        };
      },
      async close() { await closeServer(proxyServer); await closeServer(rpcServer); await api.close(); service.close(); await chain.close(); },
    };
  } catch (error) {
    await closeServer(proxyServer); await closeServer(rpcServer); await api?.close(); service?.close(); await chain.close();
    throw error;
  }
}

export function startWorker(job) {
  const child = fork(workerPath, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced' });
  let stdout = '', stderr = '';
  const messages = [];
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-8000); });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
  child.on('message', (message) => { messages.push(message); if (message.type === 'ready') readyResolve(message); });
  const done = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Fixture child timed out: ${stderr}`)); }, 30000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (exitCode, signal) => {
      clearTimeout(timeout);
      const result = messages.findLast((message) => message.type === 'result');
      readyResolve({ type: 'exited', exitCode, signal, result });
      resolve({ exitCode, signal, result, messages, stdout, stderr });
    });
  });
  child.send({ type: 'job', job });
  return { ready, done, start() { child.send({ type: 'start' }); }, kill() { child.kill('SIGKILL'); } };
}

export async function runWorker(job) {
  return startWorker(job).done;
}
