import ganache from 'ganache';
import { BrowserProvider, ContractFactory, Wallet } from 'ethers';
import { compileContracts } from '../scripts/compile.mjs';

// PUBLIC, INSECURE DEVELOPMENT FIXTURE. Never use these accounts on a public chain.
// The mnemonic is a well-known test vector, not a generated or persistent credential.
const PUBLIC_FIXTURE_MNEMONIC = 'test test test test test test test test test test test junk';

export const QUOTE_TYPES = {
  Quote: [
    { name: 'quoteId', type: 'bytes32' },
    { name: 'requestHash', type: 'bytes32' },
    { name: 'payer', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

export function quoteDomain(chainId, verifyingContract) {
  return { name: 'MotePayments', version: '1', chainId, verifyingContract };
}

/**
 * Start a fresh in-memory EVM. No external RPC, sockets, credentials, or value.
 * Every balance, key, deployment, and transaction is a local development fixture.
 */
export async function createLocalChain() {
  const chainId = 31337;
  const eip1193 = ganache.provider({
    chain: { chainId, networkId: chainId, hardfork: 'shanghai' },
    wallet: { mnemonic: PUBLIC_FIXTURE_MNEMONIC, totalAccounts: 5, defaultBalance: 1000 },
    logging: { quiet: true },
    miner: { instamine: 'eager' },
  });
  const provider = new BrowserProvider(eip1193, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 20;
  try {
    const merchant = await provider.getSigner(0);
    const payer = await provider.getSigner(1);
    // Ephemeral, unfunded local fixture: deliberately unique for each chain boot.
    // Never persisted or logged. Old-boot quotes cannot authorize a reset chain.
    const quoteSigner = Wallet.createRandom();
    const artifacts = compileContracts({ writeArtifacts: false });
    const token = await new ContractFactory(artifacts.MoteToken.abi, artifacts.MoteToken.bytecode, merchant)
      .deploy(await merchant.getAddress());
    await token.waitForDeployment();
    const payments = await new ContractFactory(artifacts.MotePayments.abi, artifacts.MotePayments.bytecode, merchant)
      .deploy(await token.getAddress(), await merchant.getAddress(), quoteSigner.address);
    await payments.waitForDeployment();
    await (await token.transfer(await payer.getAddress(), 100n * 10n ** 6n)).wait();
    let closed = false;
    return {
      provider,
      eip1193,
      merchant,
      payer,
      quoteSigner,
      token,
      payments,
      chainId,
      async close() {
        if (closed) return;
        closed = true;
        provider.destroy();
        await eip1193.disconnect();
      },
    };
  } catch (error) {
    provider.destroy();
    await eip1193.disconnect();
    throw error;
  }
}
