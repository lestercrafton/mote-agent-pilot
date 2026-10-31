// Local EVM only. Actual claim/approval/payment through production fee checks.
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDispenserHarness } from './dispenser-chain-harness.mjs';
import { TestnetBudgetJournal } from '../../src/testnet-journal.mjs';
import { TestnetMoteClient, testnetIdentity, LOCAL_FIXTURE_ACKNOWLEDGMENT } from '../../src/testnet-client.mjs';
import { ClaimBudgetJournal } from '../../src/claim-journal.mjs';
import { ClaimThenPayClient } from '../../src/claim-client.mjs';

export async function createClaimHarness(options = {}) {
  return attachClaimClients(await createDispenserHarness(options));
}

// Root's eight-transaction rehearsal supplies its already bootstrapped local
// EVM and real HTTP service here; policies/clients stay exactly the same.
export async function attachClaimClients(h) {
  const journals = [];
  let sequence = 0;
  const payer = (await h.claimant.getAddress()).toLowerCase();
  const paymentPolicy = { ...h.policy, payer, maxGasPerTransactionWei: '1000000000000000', maxGasTotalWei: '2000000000000000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000' };
  const policy = { enabled: true, chainId: 11155111, payer, serviceOrigin: h.baseUrl, baseConfigHash: h.config.configHash, dispenserConfigHash: h.dispenserConfig.configHash, dispenser: h.dispenserChain.identity.dispenser, claimGasLimit: '500000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000', maxClaimGasWei: '1000000000000000', maxPaymentGasWei: '2000000000000000', maxTotalGasWei: '3000000000000000' };
  function openClient({ options, paymentOptions, initialize = false, signer = h.claimant, reader = h.reader, dispenserChain = h.dispenserChain, fetchImpl, finalityWaitMs = 0 } = {}) {
    const paymentJournal = initialize ? TestnetBudgetJournal.initialize(paymentOptions) : new TestnetBudgetJournal(paymentOptions);
    journals.push(paymentJournal);
    const journalOptions = { ...options, paymentJournal, dispenserIdentity: dispenserChain.identity };
    const journal = initialize ? ClaimBudgetJournal.initialize(journalOptions) : new ClaimBudgetJournal(journalOptions); journals.push(journal);
    const paymentClient = TestnetMoteClient.forLocalFixture({ acknowledgment: LOCAL_FIXTURE_ACKNOWLEDGMENT, localServiceOrigin: h.localServiceOrigin, baseUrl: h.baseUrl, reader, chain: h.chain, policy: paymentOptions.policy, journal: paymentJournal, signer, finalityWaitMs, finalityPollMs: 100, fetchImpl });
    const client = ClaimThenPayClient.forLocalFixture({ acknowledgment: LOCAL_FIXTURE_ACKNOWLEDGMENT, journal, paymentClient, dispenserChain, signer, finalityWaitMs, finalityPollMs: 100 });
    return { client, journal, paymentJournal, paymentClient, options, paymentOptions };
  }
  return { ...h, policy, paymentPolicy,
    makeClaimClient(overrides = {}) {
      const id = ++sequence;
      const paymentOptions = { path: join(h.directory, `claim-payment-${id}.sqlite`), policyId: `claim-payment-${id}`, policy: { ...paymentPolicy, ...overrides.paymentPolicy }, chainIdentity: testnetIdentity(h.chain) };
      const options = { path: join(h.directory, `claim-wallet-${id}.sqlite`), policyId: `claim-wallet-${id}`, policy: { ...policy, ...overrides.policy } };
      return openClient({ ...overrides, options, paymentOptions, initialize: true });
    },
    openClaimClient: openClient,
    async close() { for (const j of journals.reverse()) try { j.close(); } catch {} await h.close(); },
  };
}
export function startClaimWorker(job) {
  const child = fork(fileURLToPath(new URL('../fixtures/claim-worker.mjs', import.meta.url)), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdout = '', stderr = ''; child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => { try { resolve({ code, stderr, ...JSON.parse(stdout) }); } catch { reject(new Error(`Invalid worker output: ${stdout} ${stderr}`)); } }); });
  child.send(job); return { child, done };
}
