import test from 'node:test';
import A from 'node:assert/strict';
import { encodePaymentSignatureHeader, decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import { PaymentRequiredV2Schema, PaymentPayloadV2Schema } from '@x402/core/schemas';
import { fixture, input, signer, PUBLIC_FIXTURE_PAYER } from './fixtures.mjs';
import { authorize } from '../src/client.mjs';
import { httpServer } from '../src/http.mjs';

test('loopback HTTP discovery -> x402 402 -> authorized payment -> receipt -> lost-response retry', async () => {
  const f = fixture(); const server = httpServer(f.service); await new Promise(resolve => server.listen(0, '127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const manifest = await (await fetch(base+'/.well-known/mote.json')).json(); A.equal(manifest.productionReady,false);
    const offered = await fetch(base+'/v1/audit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}); A.equal(offered.status,402);
    const offerResponse = decodePaymentRequiredHeader(offered.headers.get('payment-required')); PaymentRequiredV2Schema.parse(offerResponse);
    const p = await authorize({config:f.c,input,offerResponse,paymentId:'http-payment-00001',signer:signer(PUBLIC_FIXTURE_PAYER),journal:f.clientJournal,policy:f.policy,now:f.chain.now}); PaymentPayloadV2Schema.parse(p);
    const call = () => fetch(base+'/v1/audit',{method:'POST',headers:{'content-type':'application/json','payment-signature':encodePaymentSignatureHeader(p)},body:JSON.stringify(input)});
    const first = await call(); A.equal(first.status,200); const response = await first.json();
    A.equal(decodePaymentResponseHeader(first.headers.get('payment-response')).transaction,response.receipt.transaction);
    const repeated = await call(); A.equal(repeated.status,200); A.deepEqual(await repeated.json(),response); A.equal(f.facilitator.settleCalls,1);
    for (const body of ['{"document":1,"document":2}', '{"document":9007199254740992}', JSON.stringify({document:'x'.repeat(65536)}), '{"document":'+ '['.repeat(20)+'0'+']'.repeat(20)+'}']) {
      const r = await fetch(base+'/v1/audit',{method:'POST',headers:{'content-type':'application/json'},body}); A.equal(r.status,400);
    }
    const externalRef = await fetch(base+'/v1/audit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({document:1,schema:{$ref:'https://private.invalid/schema'}})}); A.equal(externalRef.status,400);
    const badUtf8 = await fetch(base+'/v1/audit',{method:'POST',headers:{'content-type':'application/json'},body:Buffer.from([0xff,0xfe])}); A.equal(badUtf8.status,400);
    A.equal(f.facilitator.settleCalls,1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.close(); }
});
