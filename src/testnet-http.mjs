import http from 'node:http';
import { Readable } from 'node:stream';
import { isIP } from 'node:net';
import { LIMITS, SCHEMA_KEYWORDS, MoteError, parseJson } from './json.mjs';
import { publicFetch, publicOpenapi } from './public.mjs';
import { getTestnetNetwork } from './testnet-networks.mjs';
import { dispenserMetadata } from './dispenser-discovery.mjs';

export function testnetOrigin(value) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password || url.port || host === 'localhost' || host.endsWith('.localhost') || isIP(host)) throw new Error('An exact public HTTPS origin is required.');
  return url.origin;
}
const jsonSchema = { type: 'object', required: ['document'], additionalProperties: false, properties: { document: {}, schema: { anyOf: [{ type: 'object' }, { type: 'boolean' }] } } };
const address = { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' };
const hash = { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' };
export function testnetManifest(config, readiness, dispenser = null) {
  const network = getTestnetNetwork(config.chainId);
  const origin = testnetOrigin(config.origin);
  return {
    manifestVersion: 'mote-testnet-pilot-v1', name: 'Mote', workingName: true, version: '0.7.1-resource.1',
    launchStatus: 'unlaunched-candidate', environment: `${network.slug}-public-synthetic-test`, testOnly: true,
    baseUrl: origin, openapi: `${origin}/openapi.json`, health: `${origin}/health`, readiness: `${origin}/ready`,
    description: 'Experimental exact-price token settlement for public synthetic JSON preflight. New-token necessity and demand are unproven.',
    publicSyntheticOnly: true, confidentiality: 'none; inputs, prepared results, offers and receipts are public test data',
    limits: LIMITS, schema: { dialect: 'mote-draft-07-subset-v1', supportedKeywords: SCHEMA_KEYWORDS, remoteReferences: false, semanticRepair: false },
    canonicalization: { algorithm: 'mote-sorted-json-v1', digest: 'sha-256', keyOrder: 'UTF-16', rfc8785Conformant: false },
    operations: [
      { id: 'freeAudit', method: 'POST', url: `${origin}/v1/audit`, input: jsonSchema, paymentRequired: false },
      { id: 'quote', method: 'POST', url: `${origin}/v1/quotes`, paymentRequired: false, publicSyntheticRequired: true },
      { id: 'settle', method: 'POST', url: `${origin}/v1/orders`, submitsTransactions: false, alreadyFinalizedPaymentRequired: true },
      { id: 'recoverFromSignedOffer', method: 'POST', url: `${origin}/v1/recover`, submitsTransactions: false, originalSignedOfferAndInputRequired: true },
    ],
    protocol: network.protocol, settlement: {
      chainId: network.chainId, network: network.chainId === 11155111 ? 'Ethereum Sepolia' : 'Base Sepolia', token: config.token, router: config.router, recipient: config.recipient,
      quoteSigner: config.quoteSigner, configHash: config.configHash, finality: 'canonical RPC finalized checkpoint, receipt and exact Paid event',
      testAssetsOnly: true, realMoney: false, publiclyDeployedByThisArtifact: false,
    },
    pricing: { asset: 'MOTE', decimals: 6, amount: '1000 + 10 * canonicalInputByteLength', integerBaseUnits: true, gasIncluded: false },
    permissions: { discoveryAuthorizesSpending: false, callerPreauthorizationRequired: true, exactApprovalsOnly: true, swaps: false, bridging: false, topups: false },
    payer: { feeModel: network.feeModel, standardType2Submission: network.chainId === 11155111 ? 'permitted under explicit caller policy; gasLimit * maxFeePerGas reserved before submission' : 'disabled because a full enforceable native-fee cap is unavailable', enforceableNativeFeeCeiling: network.chainId === 11155111, recoveryNeverSubmits: true, originalOfferAndInputMustBeRetained: true },
    recovery: { ordinaryRestart: 'same proof and idempotency key', restoredDatabase: 'quarantined recovery-only; cannot issue new offers', missingRows: 'reconstruct from original signed offer, matching public input and finalized proof' },
    serviceReadiness: readiness,
    tokenAcquisition: dispenser ? { method:'onchain-claim', metadata:`${origin}/v1/dispenser`, ...dispenserMetadata(config,dispenser.identity) } : { configured:false, method:null },
    x402: { implemented: false }, remoteMcp: { implemented: false }, tips: { enabled: false },
    economics: { valueClaim: false, peg: null, redemption: false, returnPromise: false }, adoption: { externalUsageClaim: false },
  };
}
export function testnetOpenapi(config, dispenser = null) {
  const network = getTestnetNetwork(config.chainId);
  const origin = testnetOrigin(config.origin);
  const specification = publicOpenapi(origin);
  delete specification.paths['/mcp'];
  specification.info = { title: `Mote public-synthetic ${network.slug} pilot`, version: '0.7.1-resource.1', description: 'Unlaunched test-only candidate. No real-value claim. Input and results are public synthetic data. Discovery never grants spending authority.' };
  const key = { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9._:-]{8,128}$' } };
  const result = description => ({ description, content: { 'application/json': { schema: { type: 'object' } } } });
  const operation = (id, properties, description) => ({ post: { operationId: id, description, parameters: [key], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: Object.keys(properties), properties } } } }, responses: { 200: result('Signed offer or verified result; no transaction submitted by this API'), 202: result('Payment pending finality; retry same proof, never pay again'), 400: result('Input rejected'), 409: result('Conflicting or quarantined state'), 413: result('Input too large'), 503: result('Evidence or durable state unavailable') } } });
  specification.paths['/v1/quotes'] = operation('quotePublicSynthetic', { payer: address, input: jsonSchema, publicSynthetic: { const: true } }, 'Prepare public synthetic result and exact signed test-token offer. Free; no payment occurs.');
  specification.paths['/v1/orders'] = operation('settleExistingPayment', { quoteId: hash, transactionHash: hash, publicSynthetic: { const: true } }, 'Verify finalized payment already submitted by the payer. Reuse identical proof after lost responses.');
  specification.paths['/v1/recover'] = operation('recoverSignedOffer', { offer: { type: 'object' }, input: jsonSchema, transactionHash: hash, publicSynthetic: { const: true } }, 'Recover from signed offer and original public input when a stored row was lost. Does not issue a new quote or submit payment.');
  specification.paths['/v1/orders/{quoteId}'] = { get: { operationId: 'recoverStoredOrder', parameters: [{ name: 'quoteId', in: 'path', required: true, schema: hash }], responses: { 200: result('Public order status or verified stored result'), 202: result('Pending finality'), 404: result('Row missing; use signed-offer recovery'), 503: result('Evidence unavailable') } } };
  specification.paths['/ready'] = { get: { operationId: 'pilotReadiness', responses: { 200: result('Service ready, possibly recovery-only'), 503: result('Durable state unavailable') } } };
  if(dispenser) {
    dispenserMetadata(config,dispenser.identity);
    specification.paths['/v1/dispenser']={get:{operationId:'inspectTestDispenser',description:'Reverify configured onchain dispenser deployment and retrieve exact claim metadata. Read-only: no claim, wallet authorization, nonce allocation or gas payment is performed by this endpoint.',responses:{200:result('Verified test-only dispenser identity and claim calldata'),503:result('Canonical deployment evidence unavailable; do not sign')}}};
  }
  specification['x-mote-test-only'] = true;
  specification['x-mote-chain-id'] = network.chainId;
  specification['x-mote-protocol'] = network.protocol;
  specification['x-mote-fee-model'] = network.feeModel;
  specification['x-mote-public-synthetic-only'] = true;
  return specification;
}

async function body(incoming) {
  if (!/^application\/json(?:\s*;|$)/i.test(incoming.headers['content-type'] ?? '')) throw new MoteError('CONTENT_TYPE', 'Use application/json.', 415);
  if (Number(incoming.headers['content-length'] ?? 0) > LIMITS.bodyBytes) throw new MoteError('BODY_TOO_LARGE', 'Body exceeds 65536 bytes.', 413);
  const chunks = [];
  let length = 0;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; incoming.destroy(); }, 5000);
  try {
    for await (const chunk of incoming) {
      length += chunk.length;
      if (length > LIMITS.bodyBytes) throw new MoteError('BODY_TOO_LARGE', 'Body exceeds 65536 bytes.', 413);
      chunks.push(chunk);
    }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
    catch { throw new MoteError('INVALID_JSON', 'Invalid UTF-8 JSON.'); }
    return parseJson(text);
  } catch (error) { if (timedOut) throw new MoteError('REQUEST_TIMEOUT', 'Body deadline exceeded.', 408); throw error; }
  finally { clearTimeout(timer); }
}
export async function startTestnetHttp({ service, origin = service.config.origin, port = 10000, host = '0.0.0.0', dispenser = null }) {
  origin = testnetOrigin(origin);
  if (service.config.origin !== origin) throw new Error('Service and HTTP origin differ.');
  if(dispenser) {
    if(typeof dispenser.verifyIdentity!=='function') throw new Error('Verified dispenser adapter required.');
    const fresh=await dispenser.verifyIdentity();
    if(JSON.stringify(fresh)!==JSON.stringify(dispenser.identity)) throw new Error('Dispenser identity changed before HTTP startup.');
    dispenserMetadata(service.config,dispenser.identity);
  }
  let closing = false;
  let active = 0;
  const server = http.createServer({ maxHeaderSize: 16384 }, async (incoming, outgoing) => {
    const send = (status, value) => { outgoing.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); outgoing.end(JSON.stringify(value)); };
    if (closing || active >= 32) { outgoing.writeHead(503, { connection: 'close' }); outgoing.end(); incoming.resume(); return; }
    active++;
    try {
      if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//') || incoming.url.length > 2048) throw new MoteError('BAD_TARGET', 'Unsupported request target.');
      const url = new URL(incoming.url, origin);
      if (url.origin !== origin) throw new MoteError('BAD_TARGET', 'Unexpected target origin.');
      const readiness = await service.readiness();
      if (incoming.method === 'GET' && url.pathname === '/health') return send(200, { service: 'mote-testnet-pilot', launchStatus: 'unlaunched-candidate', testOnly: true, serviceReady: readiness.ready === true });
      if (incoming.method === 'GET' && url.pathname === '/ready') return send(readiness.ready === true ? 200 : 503, { ...readiness, testOnly: true });
      if (incoming.method === 'GET' && ['/', '/.well-known/mote.json'].includes(url.pathname)) return send(200, testnetManifest(service.config, readiness, dispenser));
      if (incoming.method === 'GET' && url.pathname === '/openapi.json') return send(200, testnetOpenapi(service.config,dispenser));
      if (incoming.method === 'GET' && url.pathname === '/v1/dispenser' && dispenser) {
        const fresh=await dispenser.verifyIdentity();
        if(JSON.stringify(fresh)!==JSON.stringify(dispenser.identity)) throw new Error('Dispenser identity changed.');
        return send(200,dispenserMetadata(service.config,fresh));
      }
      if (incoming.method === 'POST' && url.pathname === '/v1/audit') {
        const request = new Request(url, { method: 'POST', headers: incoming.headers, body: Readable.toWeb(incoming), duplex: 'half' });
        const response = await publicFetch(request);
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer())); return;
      }
      if (readiness.ready !== true) throw new MoteError('SERVICE_UNAVAILABLE', 'Durable state is unavailable; reconcile, do not pay again.', 503);
      const match = url.pathname.match(/^\/v1\/orders\/(0x[0-9a-fA-F]{64})$/);
      if (incoming.method === 'GET' && match) return send(200, await service.order(match[1]));
      const route = { '/v1/quotes': ['quote', ['payer', 'input', 'publicSynthetic']], '/v1/orders': ['settle', ['quoteId', 'transactionHash', 'publicSynthetic']], '/v1/recover': ['recover', ['offer', 'input', 'transactionHash', 'publicSynthetic']] }[url.pathname];
      if (incoming.method === 'POST' && route) {
        const input = await body(incoming);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== route[1].length || Object.keys(input).some(k => !route[1].includes(k)) || input.publicSynthetic !== true) throw new MoteError('PUBLIC_SYNTHETIC_REQUIRED', 'Supply exactly the documented fields and publicSynthetic:true. No confidential input is accepted.');
        return send(200, await service[route[0]](input, incoming.headers['idempotency-key']));
      }
      throw new MoteError('NOT_FOUND', 'See /.well-known/mote.json.', 404);
    } catch (error) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : error.status === 202 ? 202 : 503;
      if (!outgoing.headersSent && !outgoing.destroyed) send(status, { error: { code: /^[A-Z][A-Z0-9_]{2,80}$/.test(error.code ?? '') ? error.code : 'SERVICE_UNAVAILABLE', message: error instanceof MoteError ? error.message : 'Operation unavailable. Retain the original offer, input and proof; do not pay again.' } });
      else outgoing.destroy();
    } finally { active--; if (!incoming.complete) incoming.resume(); }
  });
  server.requestTimeout = 7000; server.headersTimeout = 5000; server.keepAliveTimeout = 5000; server.maxRequestsPerSocket = 100;
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, host, ok); });
  return { server, address: server.address(), async close() { if (closing) return; closing = true; const timer = setTimeout(() => server.closeAllConnections(), 8000); try { await new Promise((ok, fail) => server.close(e => e ? fail(e) : ok())); } finally { clearTimeout(timer); } } };
}
