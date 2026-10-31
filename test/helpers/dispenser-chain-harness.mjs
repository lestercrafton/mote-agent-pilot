// Known public fixtures on one loopback local EVM. No public-chain calls or
// generated/persistent keys. The original token/router verifier remains active.
import { Contract } from 'ethers';
import dispenserArtifact from '../../artifacts/MoteTestDispenser.json' with { type: 'json' };
import { createEthereumClientHarness } from './ethereum-client-harness.mjs';
import { createDispenserPlan } from '../../src/dispenser-plan.mjs';
import { verifyDispenserDeployment, createDispenserConfig, createDispenserChain } from '../../src/dispenser-chain.mjs';

export async function createDispenserHarness({ claimAmount = '10000000', distributionCap = '10000000000' } = {}) {
  const h = await createEthereumClientHarness();
  try {
    const operator = h.payer, claimant = await h.provider.getSigner(4);
    const nonce = BigInt(await h.provider.send('eth_getTransactionCount', [await operator.getAddress(), 'pending']));
    const plan = createDispenserPlan({ chainId: 11155111, token: h.config.deployments.token.address, tokenRuntimeHash: h.config.deployments.token.runtimeCodeHash, deployer: await operator.getAddress(), nonce: nonce.toString(), claimAmount, distributionCap });
    const hashes = {};
    for (const [index, name] of ['deployment', 'funding'].entries()) {
      const tx = plan.transactions[index];
      const sent = await operator.sendTransaction({ type: 2, chainId: 11155111, nonce: Number(tx.nonce), to: tx.to, data: tx.data, value: 0n, gasLimit: index ? 200000n : 1500000n, maxFeePerGas: 5000000000n, maxPriorityFeePerGas: 1000000000n });
      await sent.wait(); hashes[name] = sent.hash;
    }
    const evidence = await verifyDispenserDeployment({ baseConfig: h.config, expectedBaseConfigHash: h.config.configHash, plan, transactionHashes: hashes, fixtureReader: h.reader });
    const config = createDispenserConfig({ baseConfig: h.config, plan, evidence });
    const chain = await createDispenserChain({ config, expectedConfigHash: config.configHash, baseConfig: h.config, expectedBaseConfigHash: h.config.configHash, fixtureReader: h.reader });
    const dispenser = new Contract(plan.contract.predictedAddress, dispenserArtifact.abi, claimant);
    return { ...h, operator, claimant, dispenser, dispenserPlan: plan, dispenserEvidence: evidence, dispenserConfig: config, dispenserChain: chain, dispenserHashes: hashes,
      dispenserOptions(reader = h.reader) { return { config, expectedConfigHash: config.configHash, baseConfig: h.config, expectedBaseConfigHash: h.config.configHash, fixtureReader: reader }; },
    };
  } catch (error) { await h.close(); throw error; }
}
