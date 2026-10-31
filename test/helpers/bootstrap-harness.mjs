import ganache from 'ganache';
import { HDNodeWallet, JsonRpcProvider } from 'ethers';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBootstrapPlan } from '../../src/bootstrap-plan.mjs';
import { initializeLocalBootstrapJournal, createLoopbackBootstrapRunner } from '../../src/bootstrap-runner.mjs';

// Already-public BIP39 vector, never a real credential. Loopback-only Ganache,
// Shanghai rules at a pre-Prague timestamp. This cannot qualify Amsterdam gas.
const PUBLIC_FIXTURE = 'test test test test test test test test test test test junk';
export async function createBootstrapHarness({ hooks, initialize = true } = {}) {
  const wallets = Array.from({ length: 4 }, (_, index) => HDNodeWallet.fromPhrase(PUBLIC_FIXTURE, undefined, `m/44'/60'/0'/0/${index}`));
  const server = ganache.server({ chain: { chainId: 11155111, networkId: 11155111, hardfork: 'shanghai', time: new Date('2025-01-01T00:00:00Z') },
    wallet: { accounts: wallets.map((wallet, index) => ({ secretKey: wallet.privateKey, balance: index === 0 ? '0xde0b6b3a7640000' : '0x0' })) },
    miner: { timestampIncrement: 1 }, logging: { quiet: true } });
  await server.listen(0, '127.0.0.1');
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const provider = new JsonRpcProvider(endpoint, 11155111, { cacheTimeout: -1 }); provider.pollingInterval = 20;
  const reader = { endpoint, readOnly: true, send: (method, params = []) => provider.send(method, params) };
  const [operator, , quoteSigner, payerWallet] = wallets;
  const merchant = operator; // A single approved bootstrap/merchant role; payer/Q remain separate.
  const payer = payerWallet.connect(provider);
  const plan = createBootstrapPlan({ chainId: 11155111, operator: operator.address, merchant: merchant.address,
    quoteSigner: quoteSigner.address, payer: payer.address, operatorNonce: '0', payerNativeWei: '7000000000000000' });
  const genesisHash = (await reader.send('eth_getBlockByNumber', ['0x0', false])).hash;
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'mote-bootstrap-fixture-'))), path = join(directory, 'operator.sqlite');
  const authorization = { schema: 'mote-bootstrap-authorization-v1', enabled: true, planHash: plan.planHash, policyHash: plan.policyHash,
    chainId: 11155111, operator: plan.roles.operator, maximumTotalNativeWei: plan.policy.maxTotalNativeWei, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  let signCalls = 0; const signer = { getAddress: async () => operator.address,
    signTransaction: async (tx) => { signCalls++; return operator.signTransaction(tx); } };
  const options = { ack: 'LOCAL_EVM_ONLY', plan, authorization, path, signer, reader, genesisHash, hooks };
  if (initialize) initializeLocalBootstrapJournal({ ack: options.ack, path, plan, genesisHash });
  let runner = initialize ? await createLoopbackBootstrapRunner(options) : null;
  let closed = false;
  return { server, provider, reader, operator, merchant, quoteSigner, payer, plan, authorization, path, directory, genesisHash,
    signer, options, get signCalls() { return signCalls; }, get runner() { return runner; },
    async reopen(overrides = {}) { runner?.close(); runner = await createLoopbackBootstrapRunner({ ...options, ...overrides }); return runner; },
    async bootstrap() { let result; for (let index = 0; index < 5; index++) result = await runner.advance(); return result; },
    async close() { if (closed) return; closed = true; runner?.close(); provider.destroy(); await server.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
