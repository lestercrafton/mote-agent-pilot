import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalChain } from '../src/chain.mjs';
import { createService } from '../src/service.mjs';
import { startHttp } from '../src/http.mjs';
import { prepareAudit } from '../src/json.mjs';
import { SQLiteBudgetJournal } from '../src/journal.mjs';
import { DurableMoteClient, readChainIdentity } from '../src/durable-client.mjs';

const chain = await createLocalChain();
const directory = await mkdtemp(join(tmpdir(), 'mote-durable-demo-'));
let lostResponse = false;
const service = await createService({ chain, database: join(directory, 'orders.sqlite'), hooks: {
  afterCommit() { if (!lostResponse) { lostResponse = true; throw new Error('Injected delivery failure after committed local payment'); } },
} });
let api, journal;
try {
  api = await startHttp({ service });
  const input = { document: { task: 'synthetic durable agent preflight', count: 3 }, schema: { type: 'object', properties: { task: { type: 'string' }, count: { type: 'integer', minimum: 1 } }, required: ['task', 'count'], additionalProperties: false } };
  const amount = prepareAudit(input).amount;
  const payer = await chain.payer.getAddress();
  const policy = { enabled: true, ...service.config, payer, serviceOrigin: api.baseUrl,
    maxSingleSpend: amount, maxTotalSpend: amount,
    maxGasPerTransactionWei: '10000000000000000', maxGasTotalWei: '100000000000000000' };
  const chainIdentity = await readChainIdentity(chain.provider, policy);
  const journalOptions = { path: join(directory, 'authority.sqlite'), policyId: 'durable-demo-authority-v2', policy, chainIdentity };
  journal = SQLiteBudgetJournal.initialize(journalOptions);
  const first = new DurableMoteClient({ baseUrl: api.baseUrl, signer: chain.payer, provider: chain.provider, policy, journal });
  const offer = await first.quote(input, 'durable-demo-quote');
  const before = await chain.token.balanceOf(payer);
  let paymentHash;
  try { await first.execute(offer, 'durable-demo-order'); assert.fail('Expected injected lost response'); }
  catch (error) { if (!error.doNotRepay || error.settlementState !== 'confirmed') throw error; paymentHash = error.transactionHash; }
  assert.ok(paymentHash);
  const committedBudget = first.budget;
  assert.equal(committedBudget.tokenSpent, amount);
  journal.close();

  // A new client and a newly opened handle use the original authority file.
  // Separate OS-process crash/restart coverage lives in durable-client.test.mjs.
  journal = new SQLiteBudgetJournal(journalOptions);
  let recoverySendCalls = 0;
  const reconciliationSigner = { provider: chain.provider, getAddress: () => chain.payer.getAddress(), sendTransaction: async () => { recoverySendCalls++; throw new Error('Recovery must never call a signer'); } };
  const resumed = new DurableMoteClient({ baseUrl: api.baseUrl, signer: reconciliationSigner, provider: chain.provider, policy, journal });
  assert.deepEqual(resumed.budget, committedBudget);
  const result = await resumed.recover(offer, paymentHash, 'durable-demo-order');
  assert.equal(result.result.valid, true);
  assert.deepEqual(await resumed.execute(offer, 'durable-demo-order'), result);
  assert.deepEqual(resumed.budget, committedBudget);
  const next = await resumed.quote(input, 'durable-demo-next-quote');
  await assert.rejects(resumed.execute(next, 'durable-demo-next-order'), { code: 'TOTAL_LIMIT' });
  assert.equal(recoverySendCalls, 0);
  assert.equal(before - await chain.token.balanceOf(payer), BigInt(amount));
  const evidence = { candidate: '0.2.0-candidate.1', at: new Date().toISOString(), mode: 'controlled local EVM fixture; no public financial action', chainId: 31337,
    actualLocalEvmSettlement: true, deliveryFailureInjected: true, journalReopened: true,
    sameAuthorityAndBudgetRestored: true, resultRecovered: true, recoverySendCalls,
    repeatedQuotePaidAgain: false, freshQuoteBeyondPersistedBudgetRejected: true,
    amountBaseUnits: amount, paymentTransactionHash: paymentHash, budget: resumed.budget,
    publicServiceChanged: false, note: 'This demo reopens client/storage handles; separate-process SIGKILL and concurrency cases are verified by the candidate tests.' };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (process.argv.includes('--evidence')) await writeFile(new URL('../docs/candidate-v0.2-demo-evidence.json', import.meta.url), `${JSON.stringify(evidence, null, 2)}\n`);
} finally { journal?.close(); await api?.close(); service.close(); await chain.close(); }
