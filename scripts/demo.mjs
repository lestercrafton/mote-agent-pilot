import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createLocalChain } from '../src/chain.mjs';
import { createService } from '../src/service.mjs';
import { startHttp } from '../src/http.mjs';
import { MoteClient } from '../src/client.mjs';

const chain = await createLocalChain();
const directory = await mkdtemp(join(tmpdir(), 'mote-demo-'));
let lostResponse = false;
const service = await createService({ chain, database: join(directory, 'orders.sqlite'), hooks: {
  afterCommit() { if (!lostResponse) { lostResponse = true; throw new Error('Injected response loss after durable receipt commit'); } },
} });
let api;
try {
  api = await startHttp({ service });
  const payer = await chain.payer.getAddress();
  const policy = { enabled: true, ...service.config, payer, serviceOrigin: api.baseUrl,
    maxSingleSpend: '1000000', maxTotalSpend: '5000000',
    maxGasPerTransactionWei: '10000000000000000', maxGasTotalWei: '100000000000000000' };
  const client = new MoteClient({ baseUrl: api.baseUrl, signer: chain.payer, provider: chain.provider, policy });
  const request = client.request.bind(client);
  let httpRequests = 0;
  client.request = (...args) => { httpRequests++; return request(...args); };
  const started = performance.now();
  const manifest = await client.discover();
  assert.equal(manifest.name, 'Mote');
  const discoveryMs = performance.now() - started;
  const input = { document: { limit: 3, query: 'synthetic agent tool call' }, schema: { type: 'object', properties: { query: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['query', 'limit'], additionalProperties: false } };
  const offer = await client.quote(input, 'demo-quote-0001');
  const before = await chain.token.balanceOf(payer);
  let lostPaymentHash;
  try { await client.execute(offer, 'demo-order-0001'); assert.fail('The injected response loss must be observable'); }
  catch (error) { if (!error.doNotRepay) throw error; lostPaymentHash = error.transactionHash; }
  assert.ok(lostPaymentHash);
  const recovered = await client.recover(offer, lostPaymentHash, 'demo-order-0001');
  assert.equal(recovered.result.valid, true);
  const after = await chain.token.balanceOf(payer);
  assert.equal(before - after, BigInt(offer.quote.amount));
  const repeated = await client.execute(offer, 'demo-order-0001');
  assert.deepEqual(repeated, recovered);
  assert.equal(await chain.token.balanceOf(payer), after);
  const restricted = new MoteClient({ baseUrl: api.baseUrl, signer: chain.payer, provider: chain.provider, policy: { ...policy, maxSingleSpend: '1' } });
  const deniedOffer = await restricted.quote(input, 'demo-quote-denied');
  await assert.rejects(restricted.execute(deniedOffer, 'demo-order-denied'), { code: 'SINGLE_LIMIT' });
  assert.equal(await chain.token.balanceOf(payer), after);
  const evidence = {
    mode: 'controlled local development fixture; not external adoption', at: new Date().toISOString(),
    successes: 1, attemptedUsefulTasks: 1, successRate: 1, discoveredWithoutPayment: true,
    discoveryMs: Math.round(discoveryMs), taskMs: Math.round(performance.now() - started), httpRequests,
    amountBaseUnits: offer.quote.amount, asset: 'MOTE', tokenBalanceDelta: (before - after).toString(),
    actualLocalEvmSettlement: true, chainId: 31337, paymentTransactionHash: lostPaymentHash,
    responseLossInjected: true, receiptRecovered: true, repeatedCallsChargedAgain: false,
    outOfPolicyCallRejected: true, result: recovered.result, receipt: recovered.receipt, budget: client.budget,
  };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (process.argv.includes('--evidence')) await writeFile(new URL('../docs/local-demo-evidence.json', import.meta.url), `${JSON.stringify(evidence, null, 2)}\n`);
} finally {
  await api?.close(); service.close(); await chain.close();
}
