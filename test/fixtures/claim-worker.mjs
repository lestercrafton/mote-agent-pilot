// Independent local-EVM worker; no public endpoints or persisted keys.
import { JsonRpcProvider } from 'ethers';
import { createTestnetChain } from '../../src/testnet-chain.mjs';
import { createDispenserChain } from '../../src/dispenser-chain.mjs';
import { TestnetBudgetJournal } from '../../src/testnet-journal.mjs';
import { TestnetMoteClient, LOCAL_FIXTURE_ACKNOWLEDGMENT } from '../../src/testnet-client.mjs';
import { ClaimBudgetJournal } from '../../src/claim-journal.mjs';
import { ClaimThenPayClient } from '../../src/claim-client.mjs';
const READ = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getBalance', 'eth_getTransactionCount']);
process.once('message', async job => {
  let provider, journal, paymentJournal;
  try {
    if (new URL(job.rpcUrl).hostname !== '127.0.0.1') throw new Error('Loopback only');
    provider = new JsonRpcProvider(job.rpcUrl, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
    const reader = { endpoint: job.rpcUrl, readOnly: true, send(method, params) { if (!READ.has(method)) throw new Error('Read only'); return provider.send(method, params); } };
    const chain = await createTestnetChain({ config: job.config, expectedConfigHash: job.config.configHash, fixtureReader: reader });
    const dispenserChain = await createDispenserChain({ config: job.dispenserConfig, expectedConfigHash: job.dispenserConfig.configHash, baseConfig: job.config, expectedBaseConfigHash: job.config.configHash, fixtureReader: reader });
    paymentJournal = new TestnetBudgetJournal(job.paymentOptions);
    journal = new ClaimBudgetJournal({ ...job.options, dispenserIdentity: dispenserChain.identity, paymentJournal });
    const actualSigner = await provider.getSigner(job.payerAddress);
    const signer = job.recover ? undefined : { provider, getAddress: () => actualSigner.getAddress(), async sendTransaction(tx) {
      if (job.pauseClaim && tx.to.toLowerCase() === dispenserChain.identity.dispenser) { process.send({ event: 'claim-intent' }); await new Promise(resolve => process.once('message', resolve)); }
      return actualSigner.sendTransaction(tx);
    } };
    const paymentClient = TestnetMoteClient.forLocalFixture({ acknowledgment: LOCAL_FIXTURE_ACKNOWLEDGMENT, localServiceOrigin: job.localServiceOrigin, baseUrl: job.baseUrl, reader, chain, policy: job.paymentOptions.policy, journal: paymentJournal, signer, finalityWaitMs: 0 });
    const client = ClaimThenPayClient.forLocalFixture({ acknowledgment: LOCAL_FIXTURE_ACKNOWLEDGMENT, journal, paymentClient, dispenserChain, signer, finalityWaitMs: 0 });
    const result = job.recover ? await client.recover(job.operationKey) : await client.claimThenExecute(job.input, { operationKey: job.operationKey, publicSynthetic: true });
    process.stdout.write(JSON.stringify({ ok: true, result, budget: client.budget }));
  } catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: { code: error.code, message: error.message } })); }
  finally { journal?.close(); paymentJournal?.close(); provider?.destroy(); process.disconnect(); }
});
