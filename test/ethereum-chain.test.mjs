import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import ganache from 'ganache';
import { BrowserProvider, Contract, HDNodeWallet, id } from 'ethers';
import { compileContracts } from '../scripts/compile.mjs';
import { createVerificationBundle } from '../src/verification-bundle.mjs';
import { createTestnetPlan, validateTestnetPlan, verifyTestnetDeployment, fingerprintTestnetPlan } from '../src/testnet-plan.mjs';
import { createTestnetChainConfig, createTestnetChain, validateTestnetChainConfig, QUOTE_TYPES } from '../src/testnet-chain.mjs';
import { ETHEREUM_SEPOLIA, BASE_SEPOLIA } from '../src/testnet-networks.mjs';
import { canonicalStringify, hashJson } from '../src/json.mjs';

// PUBLIC TEST VECTOR ACCOUNTS, LOCAL GANACHE ONLY. Chain ID 11155111 is
// simulated here. These tests never contact or submit transactions to Sepolia.
const PUBLIC_FIXTURE = 'test test test test test test test test test test test junk';
let evm, provider, payer, signer, token, router, plan, evidence, bundle, config, chain, inputConfig, offer, paymentHash;
const hashes = {}; let transform = null;
const allowed = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call', 'eth_getTransactionByHash', 'eth_getTransactionReceipt']);
const reader = { async send(method, params) {
  assert.ok(allowed.has(method), `Chain adapter attempted a write: ${method}`);
  const response = structuredClone(await provider.send(method, params));
  return transform ? transform(method, params, response) : response;
} };
const makeConfig = (extra = {}) => createTestnetChainConfig({ plan, evidence, verificationBundle: bundle, origin: 'https://ethereum-pilot.example.invalid', ...extra });
const rehashConfig = (raw) => { const { configHash, ...body } = raw; return { ...body, configHash: hashJson(body) }; };
async function resign(body) { const { offerSignature, ...unsigned } = body; return { ...unsigned, offerSignature: await signer.signMessage(canonicalStringify(unsigned)) }; }

before(async () => {
  evm = ganache.provider({ chain: { chainId: 11155111, networkId: 11155111, hardfork: 'shanghai' }, wallet: { mnemonic: PUBLIC_FIXTURE, totalAccounts: 4 }, logging: { quiet: true } });
  provider = new BrowserProvider(evm, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 20;
  const deployer = await provider.getSigner(0); payer = await provider.getSigner(1); const merchant = await provider.getSigner(2);
  signer = HDNodeWallet.fromPhrase(PUBLIC_FIXTURE, undefined, "m/44'/60'/0'/0/3");
  inputConfig = { chainId: 11155111, deployer: await deployer.getAddress(), initialHolder: await payer.getAddress(), merchant: await merchant.getAddress(), quoteSigner: signer.address, nonce: '0' };
  plan = createTestnetPlan(inputConfig); bundle = createVerificationBundle();
  for (const [index, name] of ['token', 'payments'].entries()) {
    const tx = await deployer.sendTransaction({ chainId: 11155111, nonce: index, data: plan.transactions[index].data, value: 0n });
    const receipt = await tx.wait(); hashes[name] = tx.hash; assert.equal(receipt.contractAddress, plan.contracts[name].predictedAddress);
  }
  evidence = await verifyTestnetDeployment({ plan, provider: reader, transactionHashes: hashes });
  const genesisHash = (await reader.send('eth_getBlockByNumber', ['0x0', false])).hash;
  config = makeConfig({ genesisHash, mode: 'local-fixture' });
  chain = await createTestnetChain({ config, expectedConfigHash: config.configHash, fixtureReader: reader });
  const artifacts = compileContracts({ writeArtifacts: false });
  token = new Contract(chain.identity.token, artifacts.MoteToken.abi, payer); router = new Contract(chain.identity.router, artifacts.MotePayments.abi, payer);
  const block = await provider.send('eth_getBlockByNumber', ['latest', false]);
  const quote = { quoteId: id('ethereum-sepolia-local-fixture'), requestHash: id('synthetic-request'), payer: (await payer.getAddress()).toLowerCase(), amount: '1500', deadline: (BigInt(block.timestamp) + 300n).toString() };
  offer = await resign({ protocol: ETHEREUM_SEPOLIA.protocol, quote, domain: chain.quoteDomain,
    signature: await signer.signTypedData(chain.quoteDomain, QUOTE_TYPES, quote), chainId: 11155111, token: chain.identity.token,
    router: chain.identity.router, recipient: chain.identity.recipient, quoteSigner: chain.identity.quoteSigner, decimals: 6,
    asset: 'MOTE', service: 'json.audit', resultHash: id('synthetic-result'), expiresAt: new Date(Number(quote.deadline) * 1000).toISOString(),
    inputBytes: 50, origin: config.origin, configHash: config.configHash, finality: 'finalized', testOnly: true, publicSynthetic: true, localOnly: false });
});
after(async () => { provider?.destroy(); await evm?.disconnect(); });

test('Ethereum unsigned plan uses separate network/schema and domain while preserving bytecode and zero value', () => {
  assert.equal(plan.schema, ETHEREUM_SEPOLIA.planSchema); assert.equal(plan.network, ETHEREUM_SEPOLIA.slug);
  assert.deepEqual(validateTestnetPlan(plan), plan); assert.deepEqual(plan.transactions.map((tx) => [tx.chainId, tx.value]), [[11155111, '0'], [11155111, '0']]);
  assert.equal(plan.authorization, false); assert.equal(plan.publicDeployment, false); assert.equal(plan.broadcastReady, false);
  const base = createTestnetPlan({ ...inputConfig, chainId: 84532 });
  assert.equal(base.schema, BASE_SEPOLIA.planSchema); assert.equal(base.network, BASE_SEPOLIA.slug);
  assert.equal(base.transactions[0].data, plan.transactions[0].data); assert.equal(base.transactions[1].data, plan.transactions[1].data);
  assert.notEqual(base.planHash, plan.planHash);
  const altered = structuredClone(plan); altered.transactions[1].chainId = 84532; altered.planHash = fingerprintTestnetPlan(altered);
  assert.throws(() => validateTestnetPlan(altered), { code: 'PLAN_MISMATCH' });
  for (const chainId of [1, 8453, 31337, '11155111']) assert.throws(() => createTestnetPlan({ ...inputConfig, chainId }), { code: 'WRONG_CHAIN' });
});

test('local Ethereum deployment verifies source/runtime/immutables without claiming public deployment', async () => {
  assert.equal(evidence.chainId, 11155111); assert.equal(evidence.publicNetworkAuthenticityVerified, false);
  assert.equal(evidence.feeBudgetVerified, false); assert.equal(evidence.serviceReadinessVerified, false);
  assert.equal(chain.quoteDomain.chainId, 11155111); assert.equal((await router.eip712Domain())[3], 11155111n);
  assert.deepEqual(await chain.verifyIdentity(), chain.identity);
  const wrong = { send: async (method, params) => method === 'eth_chainId' ? '0x14a34' : reader.send(method, params) };
  await assert.rejects(verifyTestnetDeployment({ plan, provider: wrong, transactionHashes: hashes }), { code: 'WRONG_CHAIN' });
  await assert.rejects(createTestnetChain({ config, expectedConfigHash: config.configHash, fixtureReader: wrong }), { code: 'CHAIN_IDENTITY_MISMATCH' });
});

test('public Ethereum configuration requires canonical genesis and forbids cross-network modes or unmarked fixtures', async () => {
  const publicConfig = makeConfig();
  assert.equal(publicConfig.mode, 'ethereum-sepolia'); assert.equal(publicConfig.genesisHash, ETHEREUM_SEPOLIA.genesisHash);
  assert.equal(publicConfig.schema, ETHEREUM_SEPOLIA.configSchema);
  for (const extra of [{ genesisHash: null }, { genesisHash: config.genesisHash }, { mode: 'base-sepolia' }, { mode: 'local-fixture' }]) {
    assert.throws(() => makeConfig(extra), { code: 'INVALID_CONFIG' });
  }
  await assert.rejects(createTestnetChain({ config: publicConfig, expectedConfigHash: publicConfig.configHash, fixtureReader: reader }), { code: 'INVALID_PROVIDER' });
  const changed = structuredClone(config); changed.schema = BASE_SEPOLIA.configSchema;
  const rehashed = rehashConfig(changed);
  assert.throws(() => validateTestnetChainConfig(rehashed, rehashed.configHash), { code: 'INVALID_CONFIG' });
  const otherEvidence = { ...evidence, chainId: 84532 };
  assert.throws(() => makeConfig({ evidence: otherEvidence }), { code: 'INVALID_CONFIG' });
});

test('public Ethereum runtime routes only to fixed RPC and actually checks the canonical genesis', async (t) => {
  // Mock the public reader transport with this local fixture. No network call.
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, ETHEREUM_SEPOLIA.rpcUrl); const request = JSON.parse(options.body); seen.push(request);
    return Response.json({ jsonrpc: '2.0', id: request.id, result: await reader.send(request.method, request.params) });
  });
  const publicConfig = makeConfig();
  await assert.rejects(createTestnetChain({ config: publicConfig, expectedConfigHash: publicConfig.configHash }), { code: 'CHAIN_IDENTITY_MISMATCH' });
  assert.ok(seen.some((entry) => entry.method === 'eth_getBlockByNumber' && entry.params[0] === '0x0'));
});

test('Ethereum router rejects Base-domain signatures and accepts one exact local Ethereum payment', async () => {
  const wrongQuote = { ...offer.quote, quoteId: id('wrong-network-synthetic-quote') };
  const wrongSignature = await signer.signTypedData({ ...chain.quoteDomain, chainId: 84532 }, QUOTE_TYPES, wrongQuote);
  await (await token.approve(chain.identity.router, BigInt(offer.quote.amount))).wait();
  await assert.rejects(router.pay(wrongQuote, wrongSignature));
  const before = await token.balanceOf(chain.identity.recipient);
  const tx = await router.pay(offer.quote, offer.signature); await tx.wait(); paymentHash = tx.hash;
  const proof = await chain.verifyPayment({ offer, transactionHash: paymentHash });
  assert.equal(proof.transactionHash, paymentHash); assert.equal(proof.configHash, config.configHash);
  assert.equal(await token.balanceOf(chain.identity.recipient), before + BigInt(offer.quote.amount));
  assert.equal(await token.allowance(offer.quote.payer, chain.identity.router), 0n);
  await assert.rejects(router.pay(offer.quote, offer.signature));
  for (const patch of [{ protocol: BASE_SEPOLIA.protocol }, { chainId: 84532 }, { domain: { ...offer.domain, chainId: 84532 } }]) {
    await assert.rejects(chain.verifyPayment({ offer: await resign({ ...offer, ...patch }), transactionHash: paymentHash }), { code: 'INVALID_OFFER' });
  }
});

test('Ethereum recovery preserves expiry, finalized-anchor, altered-proof and identity-drift guards', async () => {
  const first = await chain.verifyPayment({ offer, transactionHash: paymentHash });
  await provider.send('evm_increaseTime', [600]); await provider.send('evm_mine', []);
  const recovered = await chain.verifyPayment({ offer, transactionHash: paymentHash, finalizedAnchor: first.finalized });
  assert.equal(recovered.blockHash, first.blockHash);
  await assert.rejects(chain.verifyPayment({ offer, transactionHash: paymentHash, finalizedAnchor: { ...first.finalized, blockHash: id('old-anchor-changed') } }), { code: 'SETTLEMENT_REORG' });
  for (const [alter, code] of [
    [(method, params, result) => method === 'eth_getBlockByNumber' && params[0] === 'finalized' ? null : result, 'FINALITY_UNAVAILABLE'],
    [(method, params, result) => { if (method === 'eth_getBlockByNumber' && params[0] === '0x0') result.hash = id('changed-fixture-genesis'); return result; }, 'CHAIN_IDENTITY_MISMATCH'],
    [(method, params, result) => { if (method === 'eth_getTransactionByHash' && params[0] === paymentHash) result.chainId = '0x14a34'; return result; }, 'PAYMENT_MISMATCH'],
    [(method, params, result) => { if (method === 'eth_getTransactionReceipt' && params[0] === paymentHash) result.logs.at(-1).removed = true; return result; }, 'PAYMENT_MISMATCH'],
  ]) {
    transform = alter;
    try { await assert.rejects(chain.verifyPayment({ offer, transactionHash: paymentHash }), { code }); } finally { transform = null; }
  }
});
