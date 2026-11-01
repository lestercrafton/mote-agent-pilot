import test from 'node:test';
import A from 'node:assert/strict';
import { fixture, input, H, PUBLIC_FIXTURE_PAYER } from './fixtures.mjs';
import { CdpTransport, CDP } from '../src/facilitator.mjs';
import { rpcReader } from '../src/chain-proof.mjs';

const proofTest = (name, mutate) => test(`proof rejects ${name}`, async () => {
  const f = fixture();
  try { const p = await f.payment(); const txHash = await f.chain.settle(p); mutate(f, f.chain.transfers.get(txHash)); await A.rejects(f.proof.settled(p, txHash)); }
  finally { f.close(); }
});
proofTest('wrong chain', f => { f.chain.override = m => m === 'eth_chainId' ? '0x1' : undefined; });
proofTest('missing finalized checkpoint', f => { f.chain.override = (m,p) => m === 'eth_getBlockByNumber' && p[0] === 'finalized' ? null : undefined; });
proofTest('reverted transaction', (_, t) => { t.receipt.status = '0x0'; });
proofTest('wrong inclusion hash', (_, t) => { t.receipt.blockHash = H(200); });
proofTest('missing transaction signature', (_, t) => { delete t.tx.r; });
proofTest('wrong transaction chain ID', (_, t) => { t.tx.chainId = '0x1'; });
proofTest('mutated calldata', (_, t) => { t.tx.input += '00'; });
proofTest('unsupported transaction type', (_, t) => { t.tx.type = '0x0'; });
proofTest('sender mismatch', (_, t) => { t.receipt.from = PUBLIC_FIXTURE_PAYER.address; });
proofTest('block membership mismatch', (f) => { f.chain.override = (m,p) => m === 'eth_getBlockByNumber' && p[0] === '0x50' ? { number: '0x50', hash: H(80), transactions: [] } : undefined; });
proofTest('removed event', (_, t) => { t.receipt.logs[0].removed = true; });
proofTest('event transaction mismatch', (_, t) => { t.receipt.logs[0].transactionHash = H(123); });
proofTest('event block mismatch', (_, t) => { t.receipt.logs[0].blockHash = H(123); });
proofTest('event index mismatch', (_, t) => { t.receipt.logs[0].transactionIndex = '0x9'; });
proofTest('duplicate log index', (_, t) => { t.receipt.logs[1].logIndex = t.receipt.logs[0].logIndex; });
proofTest('missing authorization event', (_, t) => { t.receipt.logs.shift(); });
proofTest('wrong transfer amount', (_, t) => { t.receipt.logs[1].data = H(999); });
proofTest('extra event encoding bytes', (_, t) => { t.receipt.logs[0].data += '00'; });
proofTest('changing finalized anchor', f => { let calls = 0; f.chain.override = (m,p) => m === 'eth_getBlockByNumber' && p[0] === '0x64' && ++calls ? { hash: H(999) } : undefined; });
test('mined but not finalized stays pending', async () => {
  const f = fixture(); try { const p = await f.payment(); const h = await f.chain.settle(p); f.chain.finalized = 79n; A.equal(await f.proof.settled(p,h), null); } finally { f.close(); }
});
test('expiry is insufficient if authorization has been used', async () => {
  const f = fixture(); try { const p = await f.payment(); await f.chain.settle(p); f.chain.now += 1000; A.equal(await f.proof.expiredUnused(p), false); } finally { f.close(); }
});
test('bounded log lookup limits malformed provider response', async () => {
  const f = fixture(); try { const p = await f.payment(); f.chain.override = m => m === 'eth_getLogs' ? Array(5).fill({}) : undefined; await A.rejects(f.proof.locate(p), /LOG_LOOKUP_LIMIT/); } finally { f.close(); }
});
test('CDP transport pins endpoint, rejects redirects, limits body and does not retry settle', async () => {
  let calls = 0;
  const transport = new CdpTransport({ auth: async op => { A.equal(op, 'settle'); return 'fixture-only'; }, fetchImpl: async (url, init) => {
    calls++; A.equal(url, `${CDP}/settle`); A.equal(init.redirect, 'error'); A.equal(init.method, 'POST'); A.ok(init.signal); throw Error('secret must not echo');
  } });
  await A.rejects(transport.settle({},{}), e => e.message === 'SETTLEMENT_UNKNOWN'); A.equal(calls,1);
});
test('CDP malformed/redirected/oversized responses fail closed with sanitized errors', async () => {
  for (const response of [new Response('private error', { status: 403 }), new Response('x'.repeat(65537)), new Response(JSON.stringify({success:'yes'})), { ok:true, redirected:true }]) {
    const t = new CdpTransport({ auth: async () => 'fixture', fetchImpl: async () => response });
    await A.rejects(t.settle({},{}), /SETTLEMENT_UNKNOWN/);
  }
});
test('CDP verify/supported successful fixtures preserve wire request and exact network requirement', async () => {
  const t = new CdpTransport({ auth: async () => 'fixture', fetchImpl: async (url, init) => {
    if (url.endsWith('/supported')) { A.equal(init.method,'GET'); return Response.json({ kinds: [{ x402Version:2, scheme:'exact',network:'eip155:84532' }] }); }
    A.deepEqual(JSON.parse(init.body), { x402Version:2,paymentPayload:{p:1},paymentRequirements:{r:2} });
    return Response.json({ isValid:true,payer:PUBLIC_FIXTURE_PAYER.address });
  } });
  A.equal((await t.verify({p:1},{r:2})).isValid,true);
  await t.supported({network:'eip155:84532'}); await A.rejects(t.supported({network:'eip155:1'}),/PROVIDER_UNSUPPORTED/);
});
test('RPC reader only allows read methods and rejects redirects/errors/wrong IDs', async () => {
  let calls = 0;
  const rpc = rpcReader('https://fixture.invalid/', { fetchImpl: async (_url, init) => { calls++; A.equal(init.redirect,'error'); return Response.json({jsonrpc:'2.0',id:2,result:'0x1'}); } });
  await A.rejects(rpc('eth_sendRawTransaction', []), /READ_ONLY_RPC/); A.equal(calls,0);
  await A.rejects(rpc('eth_chainId', []), /RPC_UNAVAILABLE/); A.equal(calls,1);
  A.throws(() => rpcReader('https://user:password@fixture.invalid/'), /RPC_URL/);
});
