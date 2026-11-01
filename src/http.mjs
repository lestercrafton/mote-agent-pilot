import { createServer } from 'node:http';
import { encodePaymentRequiredHeader, decodePaymentSignatureHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { parseJson, LIMITS } from './core/json.mjs';
import { assert, PROFILE, BINDING } from './protocol.mjs';

// Dependencies are explicit; this module never reads credentials or starts a listener.
export function httpServer(service, { manifestPath = '/.well-known/mote.json', healthPath = '/health', maxPaymentHeaderBytes=22000 } = {}) {
  assert(Number.isSafeInteger(maxPaymentHeaderBytes)&&maxPaymentHeaderBytes>=4096&&maxPaymentHeaderBytes<=22000,'HTTP_LIMIT');
  const server = createServer({ maxHeaderSize: 24576, requestTimeout: 10000, headersTimeout: 10000 }, async (req, res) => {
    const send = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(body)); };
    try {
      if (req.method === 'GET' && req.url === healthPath) {const readiness=service.j.readiness();return send(readiness.recoveryAvailable?200:503, { ok:readiness.recoveryAvailable,profile:PROFILE,productionReady:false,...readiness });}
      if (req.method === 'GET' && req.url === manifestPath) return send(200, {
        name: 'Mote USDC candidate', profile: PROFILE, productionReady: false, service: 'JSON tool-call preflight',
        endpoint: service.c.origin + service.c.path, method: 'POST', network: service.c.network, asset: service.c.asset, amount: service.c.amount,
        payTo: service.c.payTo, offerSigner: service.c.offerSigner, configHash: service.c.identity, requiredExtension: BINDING,
        wallets: 'EOA EIP-3009 only; use the Mote binding helper', limits: {...LIMITS,paymentHeaderBytes:maxPaymentHeaderBytes},
        recovery: 'Repeat original body and PAYMENT-SIGNATURE. Optional X-Mote-Transaction is a proof-checked hint. Never sign a replacement on timeout.',
        privacy: 'Synthetic nonsecret input only. Local journal stores result and signed authorization. No request logging. TLS/operator/storage review required before hosting.',
        ...(service.disclosure?{beta:service.disclosure}:{}),
      });
      assert(req.method === 'POST' && req.url === service.c.path, 'ROUTE');
      assert(req.headers['content-type']?.split(';')[0] === 'application/json' && !req.headers['content-encoding'], 'CONTENT_TYPE');
      const declared = Number(req.headers['content-length']);
      assert(!Number.isFinite(declared) || declared <= LIMITS.bodyBytes, 'BODY_SIZE');
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; assert(bytes <= LIMITS.bodyBytes, 'BODY_SIZE'); chunks.push(chunk); }
      const input = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      const header = req.headers['payment-signature'];
      if (!header) { const offer = await service.offer(input); return send(402, offer, { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(offer) }); }
      assert(typeof header === 'string' && header.length <= maxPaymentHeaderBytes, 'PAYMENT_SIZE');
      const payment = decodePaymentSignatureHeader(header);
      const result = await service.execute(input, payment, { transaction: req.headers['x-mote-transaction'] });
      const headers = result.status === 'complete' ? { 'PAYMENT-RESPONSE': encodePaymentResponseHeader({ success: true, transaction: result.receipt.transaction, network: result.receipt.network, payer: result.receipt.payer }) } : {};
      return send(result.status === 'complete' ? 200 : 202, result, headers);
    } catch (error) {
      // Never echo provider messages, signed payloads, JWTs, request bodies or stack traces.
      const code = /^[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'REQUEST_REJECTED';
      return send(code === 'ADMISSION_LIMIT' ? 429 : code === 'PROVIDER_UNAVAILABLE' ? 503 : 400, { error: code });
    }
  });
  server.maxConnections = 32;
  return server;
}
