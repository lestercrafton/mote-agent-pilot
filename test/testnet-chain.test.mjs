import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import ganache from 'ganache';
import { BrowserProvider, Contract, HDNodeWallet, Interface, ZeroAddress, id } from 'ethers';
import { compileContracts } from '../scripts/compile.mjs';
import { createTestnetPlan, verifyTestnetDeployment } from '../src/testnet-plan.mjs';
import { createVerificationBundle } from '../src/verification-bundle.mjs';
import { canonicalStringify, hashJson } from '../src/json.mjs';
import { QUOTE_TYPES, quoteDomain, createTestnetChainConfig, validateTestnetChainConfig, createTestnetChain } from '../src/testnet-chain.mjs';

// PUBLIC LOCAL FIXTURES ONLY. Ganache simulates chain ID 84532; these tests never
// contact Base, create persistent credentials, or establish Base fees/finality.
const PUBLIC_FIXTURE = 'test test test test test test test test test test test junk';
const READ_METHODS = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call', 'eth_getTransactionReceipt', 'eth_getTransactionByHash']);
let evm, provider, payer, quoteSigner, token, payments, artifacts, plan, evidence, bundle, genesisHash, config, chain, offer, paidHash;
const deploymentHashes = {}; const calls = []; let transform = null;
const reader = { async send(method, params) {
  assert.ok(READ_METHODS.has(method), `Attempted non-read-only method ${method}`);
  calls.push([method, params]); const value = structuredClone(await provider.send(method, params));
  return transform ? transform(method, params, value) : value;
} };
const rehash = (copy) => { const { configHash, ...body } = copy; copy.configHash = hashJson(body); return copy; };
const buildConfig = (overrides = {}) => createTestnetChainConfig({ plan, evidence, verificationBundle: bundle, genesisHash,
  origin: 'https://pilot.example.invalid', mode: 'local-fixture', ...overrides });
const payProof = (theOffer = offer, hash = paidHash) => chain.verifyPayment({ offer: theOffer, transactionHash: hash });
async function rejectsWith(change, code, operation = payProof) {
  transform = change;
  try { await assert.rejects(operation(), { code }); } finally { transform = null; }
}
async function resign(copy) { const { offerSignature, ...body } = copy; return { ...body, offerSignature: await quoteSigner.signMessage(canonicalStringify(body)) }; }

before(async () => {
  evm = ganache.provider({ chain: { chainId: 84532, networkId: 84532, hardfork: 'shanghai' },
    wallet: { mnemonic: PUBLIC_FIXTURE, totalAccounts: 4 }, logging: { quiet: true } });
  provider = new BrowserProvider(evm, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 20;
  const deployer = await provider.getSigner(0); payer = await provider.getSigner(1); const merchant = await provider.getSigner(2);
  quoteSigner = HDNodeWallet.fromPhrase(PUBLIC_FIXTURE, undefined, "m/44'/60'/0'/0/3");
  plan = createTestnetPlan({ chainId: 84532, deployer: await deployer.getAddress(), initialHolder: await payer.getAddress(),
    merchant: await merchant.getAddress(), quoteSigner: quoteSigner.address, nonce: '0' });
  artifacts = compileContracts({ writeArtifacts: false }); bundle = createVerificationBundle();
  for (const [index, key] of ['token', 'payments'].entries()) {
    const creation = plan.transactions[index];
    const tx = await deployer.sendTransaction({ data: creation.data, nonce: Number(creation.nonce), value: 0n, chainId: 84532 });
    await tx.wait(); deploymentHashes[key] = tx.hash;
  }
  evidence = await verifyTestnetDeployment({ plan, provider: reader, transactionHashes: deploymentHashes });
  genesisHash = (await reader.send('eth_getBlockByNumber', ['0x0', false])).hash;
  config = buildConfig(); chain = await createTestnetChain({ config, expectedConfigHash: config.configHash, fixtureReader: reader });
  token = new Contract(chain.identity.token, artifacts.MoteToken.abi, payer);
  payments = new Contract(chain.identity.router, artifacts.MotePayments.abi, payer);
  const timestamp = BigInt((await provider.send('eth_getBlockByNumber', ['latest', false])).timestamp);
  const quote = { quoteId: id('pilot-fixture-first-payment'), requestHash: id('synthetic-input'), payer: (await payer.getAddress()).toLowerCase(), amount: '1234', deadline: (timestamp + 30n).toString() };
  const signature = await quoteSigner.signTypedData(chain.quoteDomain, QUOTE_TYPES, quote);
  offer = await resign({ protocol: 'mote-base-sepolia-test-v1', quote, domain: chain.quoteDomain, signature,
    chainId: 84532, token: chain.identity.token, router: chain.identity.router, recipient: chain.identity.recipient,
    quoteSigner: chain.identity.quoteSigner, decimals: 6, asset: 'MOTE', service: 'json.audit', resultHash: id('synthetic-result'),
    expiresAt: new Date(Number(quote.deadline) * 1000).toISOString(), inputBytes: 23, origin: chain.identity.origin,
    configHash: chain.identity.configHash, finality: 'finalized', testOnly: true, publicSynthetic: true, localOnly: false });
  await (await token.approve(chain.identity.router, BigInt(quote.amount))).wait();
  const payment = await payments.pay(quote, signature); await payment.wait(); paidHash = payment.hash;
});
after(async () => { provider?.destroy(); await evm?.disconnect(); });

test('runtime import does not load solc, Ganache, local accounts or signing/broadcast capabilities', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createRequire } from 'node:module';
    await import('./src/testnet-chain.mjs');
    const require = createRequire(import.meta.url);
    if (Object.keys(require.cache).some((path) => path.includes('/node_modules/solc/') || path.includes('/node_modules/ganache/'))) process.exit(1);
  `], { cwd: new URL('../', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const source = fs.readFileSync(new URL('../src/testnet-chain.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"].*(?:chain\.mjs|compile\.mjs|verification-bundle\.mjs|testnet-plan\.mjs|ganache|solc)['"]/);
  assert.deepEqual(Object.keys(chain).sort(), ['config', 'identity', 'quoteDomain', 'verifyIdentity', 'verifyPayment']);
  assert.ok(calls.every(([method]) => READ_METHODS.has(method)));
});

test('offline config binds full verified source/build, creation evidence and immutable roles; hash is separately pinned', async () => {
  assert.deepEqual(buildConfig(), config);
  assert.equal(config.deployments.token.creationBytecodeHash, bundle.contracts.MoteToken.creationBytecodeHash);
  assert.equal(config.deployments.payments.runtimeCodeHash, evidence.contracts.payments.runtimeCodeHash);
  assert.equal(config.verificationInputHash, bundle.inputHash);
  assert.equal(config.checkpoint.blockHash, evidence.finalized.blockHash);
  assert.deepEqual(await chain.verifyIdentity(), chain.identity);
  assert.ok(Object.isFrozen(chain.config.deployments.token));
  assert.throws(() => validateTestnetChainConfig(config, id('unapproved-configuration')), { code: 'CONFIG_HASH_MISMATCH' });
  assert.throws(() => validateTestnetChainConfig({ ...config, privateKey: 'no-key' }, config.configHash), { code: 'INVALID_CONFIG' });
  for (const modify of [(copy) => { copy.chainId = 31337; }, (copy) => { copy.roles.merchant = ZeroAddress; },
    (copy) => { copy.deployments.token.address = copy.roles.initialHolder; }, (copy) => { copy.compiler.optimizer.runs = 201; },
    (copy) => { copy.checkpoint.blockNumber = '0'; }, (copy) => { copy.genesisHash = null; }]) {
    const copy = structuredClone(config); modify(copy); rehash(copy);
    assert.throws(() => validateTestnetChainConfig(copy, copy.configHash));
  }
  for (const modify of [(copy) => { copy.contracts.payments.creationInputMatches = false; },
    (copy) => { copy.configuration.quoteSigner = config.roles.deployer; }, (copy) => { copy.planHash = id('wrong-plan'); },
    (copy) => { copy.publicNetworkAuthenticityVerified = true; }]) {
    const copy = structuredClone(evidence); modify(copy); assert.throws(() => buildConfig({ evidence: copy }), { code: 'INVALID_CONFIG' });
  }
});

test('production mode permits pruned genesis but never accepts a fixture reader or endpoint override', async () => {
  const publicConfig = buildConfig({ mode: 'base-sepolia', genesisHash: null });
  assert.equal(publicConfig.genesisHash, null);
  await assert.rejects(createTestnetChain({ config: publicConfig, expectedConfigHash: publicConfig.configHash, fixtureReader: reader }), { code: 'INVALID_PROVIDER' });
  await assert.rejects(createTestnetChain({ config: publicConfig, expectedConfigHash: publicConfig.configHash, reader }), { code: 'INVALID_CONFIG' });
  assert.throws(() => buildConfig({ mode: 'base-sepolia', origin: 'http://127.0.0.1:8000' }), { code: 'INVALID_CONFIG' });
  assert.deepEqual(quoteDomain(31337, chain.identity.router), { ...chain.quoteDomain, chainId: 31337 });
});

test('actual local paid proof binds exact transaction, receipt, event, quote, finalized state and configuration', async () => {
  const proof = await payProof();
  const receipt = await provider.send('eth_getTransactionReceipt', [paidHash]);
  assert.equal(proof.transactionHash, paidHash); assert.equal(proof.blockHash, receipt.blockHash);
  assert.equal(proof.blockNumber, BigInt(receipt.blockNumber).toString());
  assert.equal(proof.amount, offer.quote.amount); assert.equal(proof.payer, offer.quote.payer);
  assert.equal(proof.quoteId, offer.quote.quoteId); assert.equal(proof.requestHash, offer.quote.requestHash);
  assert.equal(proof.configHash, config.configHash); assert.ok(Object.isFrozen(proof));
  assert.equal(await token.balanceOf(chain.identity.recipient), BigInt(offer.quote.amount));
  assert.equal(await token.allowance(offer.quote.payer, chain.identity.router), 0n);
  const changing = structuredClone(offer); const pending = payProof(changing); changing.quote.amount = '999999';
  assert.equal((await pending).amount, offer.quote.amount, 'Authenticated offer is snapshotted before RPC awaits');
});

test('full signed offer is authenticated before any RPC and its router EIP712 domain is checked', async () => {
  for (const modify of [(copy) => { copy.resultHash = id('tampered-result'); }, (copy) => { copy.quote.amount = '1'; },
    (copy) => { copy.configHash = id('other-config'); }, (copy) => { copy.domain.chainId = 31337; },
    (copy) => { copy.expiresAt = new Date(0).toISOString(); }, (copy) => { copy.unexpected = true; }]) {
    const changed = structuredClone(offer); modify(changed); const beforeCalls = calls.length;
    await assert.rejects(payProof(changed), { code: 'INVALID_OFFER' }); assert.equal(calls.length, beforeCalls);
  }
  const wrongDomain = structuredClone(offer);
  wrongDomain.signature = await quoteSigner.signTypedData({ ...chain.quoteDomain, chainId: 31337 }, QUOTE_TYPES, wrongDomain.quote);
  await assert.rejects(payProof(await resign(wrongDomain)), { code: 'INVALID_OFFER' });
});

test('pending, reverted and unfinalized payments never produce a paid proof', async () => {
  await rejectsWith((method, params, value) => method === 'eth_getTransactionReceipt' && params[0] === paidHash ? null : value, 'PAYMENT_PENDING');
  await rejectsWith((method, params, value) => { if (method === 'eth_getTransactionReceipt' && params[0] === paidHash) value.status = '0x0'; return value; }, 'PAYMENT_REVERTED');
  const oldHead = await provider.send('eth_getBlockByNumber', [`0x${BigInt(config.checkpoint.blockNumber).toString(16)}`, false]);
  await rejectsWith((method, params, value) => method === 'eth_getBlockByNumber' && params[0] === 'finalized' ? oldHead : value, 'NOT_FINALIZED');
});

test('tx and receipt mismatch, wrong chain/sender/value/input and missing or altered Paid events fail closed', async () => {
  const fields = [['hash', id('different-tx')], ['blockHash', id('different-block')], ['blockNumber', '0x99'], ['transactionIndex', '0x1'],
    ['from', config.roles.deployer], ['to', chain.identity.token], ['chainId', '0x7a69'], ['value', '0x1'], ['input', '0x00']];
  for (const [field, value] of fields) await rejectsWith((method, params, reply) => {
    if (method === 'eth_getTransactionByHash' && params[0] === paidHash) reply[field] = value; return reply;
  }, 'PAYMENT_MISMATCH');
  const router = new Interface(artifacts.MotePayments.abi);
  for (const alter of [(receipt) => { receipt.logs = []; }, (receipt) => { receipt.logs.push(structuredClone(receipt.logs.at(-1))); },
    (receipt) => { receipt.logs.at(-1).removed = true; }, (receipt) => { receipt.logs.at(-1).transactionHash = id('other-tx'); },
    (receipt) => { receipt.logs.at(-1).blockHash = id('other-block'); }, (receipt) => { receipt.logs.at(-1).transactionIndex = '0x9'; },
    (receipt) => { receipt.logs.at(-1).data = router.encodeEventLog(router.getEvent('Paid'), [offer.quote.quoteId, offer.quote.requestHash, offer.quote.payer, 1n]).data; },
    (receipt) => { receipt.logs.at(-1).topics[2] = id('other-request'); },
    (receipt) => { receipt.logs[0].logIndex = '0xa'; receipt.logs.at(-1).logIndex = '0xA'; },
    (receipt) => { receipt.logs.at(-1).data += '00'; }]) {
    await rejectsWith((method, params, value) => { if (method === 'eth_getTransactionReceipt' && params[0] === paidHash) alter(value); return value; }, 'PAYMENT_MISMATCH');
  }
  const paidBlockNumber = (await provider.send('eth_getTransactionReceipt', [paidHash])).blockNumber;
  await rejectsWith((method, params, value) => {
    if (method === 'eth_getBlockByNumber' && (params[0] === paidBlockNumber || params[0] === 'finalized')) value.transactions = [id('unrelated-transaction')];
    return value;
  }, 'PAYMENT_MISMATCH');
});

test('identity checks reject checkpoint/genesis/runtime/immutable/deployment changes', async () => {
  const headTag = `0x${BigInt(config.checkpoint.blockNumber).toString(16)}`;
  await rejectsWith((method, params, value) => method === 'eth_chainId' ? '0x2105' : value, 'CHAIN_IDENTITY_MISMATCH');
  for (const tag of [headTag, '0x0']) await rejectsWith((method, params, value) => {
    if (method === 'eth_getBlockByNumber' && params[0] === tag) value.hash = id('reset-chain'); return value;
  }, 'CHAIN_IDENTITY_MISMATCH');
  await rejectsWith((method, params, value) => method === 'eth_getCode' ? '0x6000' : value, 'CHAIN_IDENTITY_MISMATCH');
  const iface = new Interface(artifacts.MotePayments.abi);
  await rejectsWith((method, params, value) => method === 'eth_call' && params[0].data === iface.encodeFunctionData('quoteSigner')
    ? iface.encodeFunctionResult('quoteSigner', [config.roles.deployer]) : value, 'CHAIN_IDENTITY_MISMATCH');
  await rejectsWith((method, params, value) => { if (method === 'eth_getTransactionByHash' && params[0] === deploymentHashes.payments) value.input = '0x00'; return value; }, 'CHAIN_IDENTITY_MISMATCH');
  for (const [field, replacement] of [['removed', true], ['transactionHash', id('other-mint-tx')], ['blockHash', id('other-mint-block')], ['transactionIndex', '0x9']]) {
    await rejectsWith((method, params, value) => {
      if (method === 'eth_getTransactionReceipt' && params[0] === deploymentHashes.token) value.logs[0][field] = replacement;
      return value;
    }, 'CHAIN_IDENTITY_MISMATCH');
  }
});

test('finalized support and beginning/ending canonical anchors are mandatory', async () => {
  await rejectsWith((method, params, value) => method === 'eth_getBlockByNumber' && params[0] === 'finalized' ? null : value, 'FINALITY_UNAVAILABLE');
  await rejectsWith((method, params, value) => { if (method === 'eth_getBlockByNumber' && params[0] === 'finalized') throw new Error('unsupported'); return value; }, 'FINALITY_UNAVAILABLE');
  let finalizedReads = 0;
  await rejectsWith((method, params, value) => { if (method === 'eth_getBlockByNumber' && params[0] === 'finalized' && ++finalizedReads === 2) value.hash = id('late-fork'); return value; }, 'SETTLEMENT_REORG');
  let stateRead = false;
  await rejectsWith((method, params, value) => {
    if (method === 'eth_call') stateRead = true;
    if (stateRead && method === 'eth_getBlockByNumber' && params[0] === `0x${BigInt(config.checkpoint.blockNumber).toString(16)}`) value.hash = id('late-anchor-fork');
    return value;
  }, 'CHAIN_IDENTITY_MISMATCH');
});

test('consumed state and mined deadline are verified independently of event data', async () => {
  const iface = new Interface(artifacts.MotePayments.abi);
  await rejectsWith((method, params, value) => method === 'eth_call' && params[0].data === iface.encodeFunctionData('consumed', [offer.quote.quoteId])
    ? iface.encodeFunctionResult('consumed', [false]) : value, 'PAYMENT_MISMATCH');
  const paidBlockNumber = (await provider.send('eth_getTransactionReceipt', [paidHash])).blockNumber;
  await rejectsWith((method, params, value) => {
    if (method === 'eth_getBlockByNumber' && (params[0] === paidBlockNumber || params[0] === 'finalized')) value.timestamp = `0x${(BigInt(offer.quote.deadline) + 1n).toString(16)}`;
    return value;
  }, 'PAYMENT_MISMATCH');
});

test('previously finalized payment remains recoverable after quote expiry without another transfer', async () => {
  const before = await token.balanceOf(chain.identity.recipient);
  await provider.send('evm_increaseTime', [120]); await provider.send('evm_mine', []);
  const head = await provider.send('eth_getBlockByNumber', ['latest', false]);
  assert.ok(BigInt(head.timestamp) > BigInt(offer.quote.deadline));
  const first = await payProof(); const second = await payProof();
  assert.equal(first.transactionHash, second.transactionHash); assert.equal(first.logIndex, second.logIndex);
  assert.equal(await token.balanceOf(chain.identity.recipient), before);
  await assert.rejects(payments.pay(offer.quote, offer.signature));
});

test('completed recovery preserves and revalidates its historical signed finalized anchor after heads advance', async () => {
  const previous = await payProof(); const finalizedAnchor = previous.finalized;
  assert.ok(BigInt(finalizedAnchor.blockNumber) > BigInt(previous.blockNumber), 'Historical anchor is later than the unchanged payment block');
  await provider.send('evm_mine', []);
  const verifyStored = () => chain.verifyPayment({ offer, transactionHash: paidHash, finalizedAnchor });
  const proof = await verifyStored();
  assert.ok(BigInt(proof.finalized.blockNumber) > BigInt(finalizedAnchor.blockNumber));
  assert.equal(proof.blockHash, previous.blockHash);
  await assert.rejects(chain.verifyPayment({ offer, transactionHash: paidHash, finalizedAnchor: { ...finalizedAnchor, blockHash: id('other-historical-anchor') } }), { code: 'SETTLEMENT_REORG' });
  await assert.rejects(chain.verifyPayment({ offer, transactionHash: paidHash, finalizedAnchor: { ...finalizedAnchor, blockNumber: (BigInt(proof.finalized.blockNumber) + 1n).toString() } }), { code: 'SETTLEMENT_REORG' });
  for (const lateOnly of [false, true]) {
    let historicalReads = 0;
    await rejectsWith((method, params, value) => {
      if (method === 'eth_getBlockByNumber' && params[0] === `0x${BigInt(finalizedAnchor.blockNumber).toString(16)}`
        && ++historicalReads >= (lateOnly ? 2 : 1)) value.hash = id('historical-anchor-reorg');
      return value;
    }, 'SETTLEMENT_REORG', verifyStored);
  }
  await assert.rejects(chain.verifyPayment({ offer, transactionHash: paidHash, finalizedAnchor: { ...finalizedAnchor, extra: true } }), { code: 'INVALID_PROOF' });
});
