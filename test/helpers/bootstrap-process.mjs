import { HDNodeWallet, JsonRpcProvider } from 'ethers';
import { createLoopbackBootstrapRunner } from '../../src/bootstrap-runner.mjs';

// Child-process fixture only. This well-known test vector never leaves loopback
// and is not written to disk. The parent supplies public intent/chain metadata.
const PUBLIC_FIXTURE = 'test test test test test test test test test test test junk';
process.once('message', async ({ endpoint, plan, authorization, path, genesisHash, phase }) => {
  const provider = new JsonRpcProvider(endpoint, 11155111, { cacheTimeout: -1 });
  const wallet = HDNodeWallet.fromPhrase(PUBLIC_FIXTURE, undefined, "m/44'/60'/0'/0/0");
  let calls = 0;
  const pause = async (index, transactionHash = null) => {
    // An unresolved Promise alone does not keep a Node process alive. Hold the
    // fixture at this exact checkpoint until the parent terminates it.
    setInterval(() => {}, 1000);
    process.send({ phase, index, transactionHash, signCalls: calls });
    await new Promise(() => {});
  };
  let runner;
  try {
    runner = await createLoopbackBootstrapRunner({ ack: 'LOCAL_EVM_ONLY', plan, authorization, path, genesisHash,
      reader: { endpoint, readOnly: true, send: (method, params) => provider.send(method, params) },
      signer: { getAddress: async () => wallet.address, signTransaction: async (tx) => { calls++; return wallet.signTransaction(tx); } },
      hooks: phase === 'afterCommit' ? {} : { [phase]: pause } });
    const result = await runner.advance();
    if (phase === 'afterCommit') await pause(0, result.steps[0].transactionHash);
  } catch (error) {
    process.send({ error: { code: error.code ?? null, message: error.message } });
    runner?.close(); provider.destroy(); process.disconnect();
  }
});
