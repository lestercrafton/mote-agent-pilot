import { JsonRpcProvider } from 'ethers';
import { DurableMoteClient, readChainIdentity } from '../../src/durable-client.mjs';
import { SQLiteBudgetJournal } from '../../src/journal.mjs';

// Child process fixture only. The RPC endpoint exposes Ganache's public, unlocked
// development account; this worker never receives or persists a private key.
const send = (message) => new Promise((resolve, reject) => process.send(message, (error) => error ? reject(error) : resolve()));
let releaseStart;
const startGate = new Promise((resolve) => { releaseStart = resolve; });
const job = await new Promise((resolve) => {
  process.on('message', (message) => {
    if (message.type === 'start') releaseStart();
    if (message.type === 'job') resolve(message.job);
  });
});

let provider, journal, client, offer;
try {
  provider = new JsonRpcProvider(job.rpcUrl, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
  provider.pollingInterval = 20;
  const fixtureSigner = await provider.getSigner(1);
  const signer = new Proxy(fixtureSigner, {
    get(target, property) {
      if (property === 'sendTransaction') return async (transaction) => {
        const stage = transaction.to?.toLowerCase() === job.policy.token.toLowerCase() ? 'approve'
          : transaction.to?.toLowerCase() === job.policy.router.toLowerCase() ? 'pay' : 'other';
        const crashHere = job.crash?.stage === stage;
        if (crashHere && job.crash.when === 'before') {
          await send({ type: 'crash-point', stage, when: 'before', quoteId: offer?.quote.quoteId });
          process.kill(process.pid, 'SIGKILL');
          await new Promise(() => {});
        }
        const sent = await target.sendTransaction(transaction);
        if (crashHere && job.crash.when === 'after') {
          await send({ type: 'crash-point', stage, when: 'after', transactionHash: sent.hash, quoteId: offer?.quote.quoteId });
          process.kill(process.pid, 'SIGKILL');
          await new Promise(() => {});
        }
        return sent;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const chainIdentity = await readChainIdentity(provider, job.policy);
  journal = new SQLiteBudgetJournal({ path: job.path, policyId: job.policyId, policy: job.policy, chainIdentity });
  if (job.crashJournal) {
    // These methods are synchronous: kill after their real SQLite transaction
    // commits but before returning to the client. No production crash hooks.
    const { method, step } = job.crashJournal;
    if (!['reserve', 'markSubmitted', 'recordPayment'].includes(method)) throw new Error('Unsupported journal crash fixture');
    const original = journal[method].bind(journal);
    journal[method] = (...args) => {
      const result = original(...args);
      if (step === undefined || args[1] === step) {
        process.send({ type: 'journal-crash-point', method, step, quoteId: offer?.quote.quoteId });
        process.kill(process.pid, 'SIGKILL');
      }
      return result;
    };
  }
  client = new DurableMoteClient({ baseUrl: job.baseUrl, signer, provider, policy: job.policy, journal });
  let response;
  if (job.action === 'budget') {
    response = { budget: client.budget };
  } else if (job.action === 'recover') {
    offer = job.offer;
    await send({ type: 'ready', offer });
    if (job.barrier) await startGate;
    response = await client.recover(offer, job.transactionHash ?? null, job.orderKey);
  } else {
    offer = await client.quote(job.input, job.quoteKey);
    await send({ type: 'ready', offer });
    if (job.barrier) await startGate;
    response = await client.execute(offer, job.orderKey);
  }
  await send({ type: 'result', ok: true, offer, response, budget: client.budget });
} catch (error) {
  let budget;
  try { budget = client?.budget; } catch { /* A broken journal must not become an empty budget. */ }
  await send({ type: 'result', ok: false, offer, budget, error: {
    name: error.name, code: error.code, message: error.message, doNotRepay: error.doNotRepay,
    quoteId: error.quoteId, transactionHash: error.transactionHash, settlementState: error.settlementState,
  } });
} finally {
  try { journal?.close(); } catch { /* Retain original failure evidence. */ }
  provider?.destroy();
  process.disconnect();
}
