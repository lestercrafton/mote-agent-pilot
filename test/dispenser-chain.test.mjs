import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, id, keccak256 } from 'ethers';
import artifact from '../artifacts/MoteTestDispenser.json' with { type: 'json' };
import { createDispenserChain, createDispenserConfig, validateDispenserConfig, verifyDispenserDeployment } from '../src/dispenser-chain.mjs';
import { createDispenserHarness } from './helpers/dispenser-chain-harness.mjs';
import { hashJson } from '../src/json.mjs';

let h, payer, claimHash, claimProof;
const abi = new Interface(artifact.abi);
const rehash = config => { const { configHash, ...body } = config; return { ...body, configHash: hashJson(body) }; };
const transformed = transform => ({ endpoint: h.reader.endpoint, readOnly: true, async send(method, params = []) { const response = structuredClone(await h.reader.send(method, params)); return transform(method, params, response); } });
before(async () => { h = await createDispenserHarness(); payer = (await h.claimant.getAddress()).toLowerCase(); });
after(async () => h?.close());

test('actual loopback deployment/funding verifies full compiler immutables, original token/router identity and exact cap', async () => {
  const identity = h.dispenserChain.identity;
  assert.equal(identity.baseConfigHash, h.config.configHash); assert.equal(identity.dispenserConfigHash, h.dispenserConfig.configHash);
  assert.equal(identity.token, h.chain.identity.token); assert.equal(identity.router, h.chain.identity.router);
  assert.equal(identity.genesisHash, h.config.genesisHash); assert.equal(identity.chainId, 11155111);
  assert.equal(identity.claimAmount, '10000000'); assert.equal(identity.distributionCap, '10000000000'); assert.equal(identity.maxClaims, '1000');
  assert.equal(identity.claimsPerAddress, 1); assert.equal(identity.testOnly, true); assert.equal(identity.sybilResistance, false);
  assert.equal(identity.runtimeCodeHash, keccak256(await h.provider.getCode(identity.dispenser)));
  assert.equal(h.dispenserEvidence.publicNetworkAuthenticityVerified, false); assert.equal(h.dispenserEvidence.feeBudgetVerified, false); assert.equal(h.dispenserEvidence.broadcastAuthorization, false);
  assert.deepEqual(await h.dispenserChain.verifyIdentity(), identity);
  assert.equal(Object.isFrozen(identity), true); assert.equal(Object.isFrozen(identity.deployment), true);
  const inspected = await h.dispenserChain.inspectClaim({ payer });
  assert.equal(inspected.eligible, true); assert.equal(inspected.claimed, false); assert.equal(inspected.dispenserBalance, identity.distributionCap);
  assert.equal(await h.token.balanceOf(payer), 0n);
});

test('config rejects altered plan, base identity, unknown fields and self-rehashed immutable/runtime substitution', () => {
  assert.deepEqual(validateDispenserConfig(h.dispenserConfig, h.dispenserConfig.configHash, h.config), h.dispenserConfig);
  for (const patch of [{ baseConfigHash: id('wrong-base') }, { origin: 'https://wrong.example.invalid' }, { runtimeCodeHash: id('wrong-runtime') }, { genesisHash: id('wrong-genesis') }, { chainId: 84532 }, { mnemonic: 'never-accepted' }]) {
    const changed = rehash({ ...h.dispenserConfig, ...patch });
    assert.throws(() => validateDispenserConfig(changed, changed.configHash, h.config));
  }
  for (const change of [plan => plan.transactions[1].nonce = '999', plan => plan.contract.claimAmount = '999', plan => plan.transactions[0].data += '00', plan => plan.expectedTokenRuntimeHash = id('wrong-token-runtime'), plan => plan.contract.abiHash = id('wrong-abi')]) {
    const altered = structuredClone(h.dispenserConfig); change(altered.plan); const { planHash, ...body } = altered.plan; altered.plan.planHash = hashJson(body); const config = rehash(altered);
    assert.throws(() => validateDispenserConfig(config, config.configHash, h.config));
  }
  assert.throws(() => createDispenserConfig({ baseConfig: h.config, plan: h.dispenserPlan, evidence: { ...h.dispenserEvidence, broadcastAuthorization: true } }));
  const uppercase = structuredClone(h.dispenserConfig); uppercase.funding.transactionHash = '0x' + uppercase.funding.transactionHash.slice(2).toUpperCase();
  const mixed = rehash(uppercase); assert.throws(() => validateDispenserConfig(mixed, mixed.configHash, h.config), { code: 'INVALID_DISPENSER_CONFIG' });
});

test('fixture reader requires explicit literal loopback and public genesis never accepts fixture configuration', async () => {
  for (const reader of [{ ...h.reader, readOnly: false }, { ...h.reader, endpoint: 'https://ethereum-sepolia-rpc.publicnode.com' }, { ...h.reader, endpoint: 'http://localhost:1234' }, { ...h.reader, endpoint: 'http://user@127.0.0.1:1234' }]) {
    await assert.rejects(createDispenserChain(h.dispenserOptions(reader)), { code: 'INVALID_DISPENSER_PROVIDER' });
  }
  const opts = h.dispenserOptions(); delete opts.fixtureReader;
  await assert.rejects(createDispenserChain(opts), { code: 'INVALID_DISPENSER_PROVIDER' });
  const base = rehash({ ...h.config, mode: 'ethereum-sepolia' });
  await assert.rejects(createDispenserChain({ ...h.dispenserOptions(), baseConfig: base, expectedBaseConfigHash: base.configHash }));
});

test('deployment/funding proof rejects wrong sender/nonce/calldata/signature and missing or reorged receipts', async () => {
  const target = h.dispenserHashes.funding;
  for (const change of [tx => tx.from = payer, tx => tx.nonce = '0x63', tx => tx.input += '00', tx => tx.r = '0x01', tx => tx.value = '0x1', tx => tx.chainId = '0x1', tx => tx.to = h.dispenserChain.identity.dispenser, tx => tx.blockHash = id('wrong-block')]) {
    const reader = transformed((method, params, value) => { if (method === 'eth_getTransactionByHash' && params[0] === target) change(value); return value; });
    await assert.rejects(createDispenserChain(h.dispenserOptions(reader)), { code: 'DISPENSER_TRANSACTION_MISMATCH' });
  }
  const missing = transformed((method, params, value) => method === 'eth_getTransactionReceipt' && params[0] === target ? null : value);
  await assert.rejects(createDispenserChain(h.dispenserOptions(missing)), { code: 'DISPENSER_DEPLOYMENT_PENDING' });
  const reorg = transformed((method, params, value) => { if (method === 'eth_getTransactionReceipt' && params[0] === target) value.blockHash = id('removed-funding'); return value; });
  await assert.rejects(createDispenserChain(h.dispenserOptions(reorg)), { code: 'DISPENSER_TRANSACTION_MISMATCH' });
});

test('full runtime comparison detects changes inside every immutable group as well as ordinary code', async () => {
  const dispenser = h.dispenserChain.identity.dispenser;
  for (const position of [0, ...Object.values(artifact.immutableReferences).map(entries => entries[0].start)]) {
    const reader = transformed((method, params, value) => {
      if (method === 'eth_getCode' && params[0].toLowerCase() === dispenser) {
        const bytes = Buffer.from(value.slice(2), 'hex'); bytes[position] ^= 1; return `0x${bytes.toString('hex')}`;
      }
      return value;
    });
    await assert.rejects(createDispenserChain(h.dispenserOptions(reader)), { code: 'DISPENSER_IDENTITY_MISMATCH' });
  }
  const token = transformed((method, params, value) => method === 'eth_getCode' && params[0].toLowerCase() === h.config.deployments.token.address ? '0x00' : value);
  await assert.rejects(createDispenserChain(h.dispenserOptions(token)), { code: 'CHAIN_IDENTITY_MISMATCH' });
});

test('funding receipt requires exact canonical transfer event and cannot be replaced by arbitrary code or balance', async () => {
  for (const change of [log => log.removed = true, log => log.data = '0x' + '0'.repeat(64), log => log.transactionHash = id('other-transfer'), log => log.transactionIndex = '0x9', log => log.blockHash = id('other-block')]) {
    const reader = transformed((method, params, value) => { if (method === 'eth_getTransactionReceipt' && params[0] === h.dispenserHashes.funding) change(value.logs[0]); return value; });
    await assert.rejects(createDispenserChain(h.dispenserOptions(reader)), { code: 'DISPENSER_EVENT_MISMATCH' });
  }
  const duplicated = transformed((method, params, value) => { if (method === 'eth_getTransactionReceipt' && params[0] === h.dispenserHashes.funding) value.logs.push({ ...value.logs[0], logIndex: '0x00' }); return value; });
  await assert.rejects(createDispenserChain(h.dispenserOptions(duplicated)));
});

test('actual finalized claim binds original signed caller, exact payout and claim state; replay consumes no second tokens', async () => {
  const before = await h.token.balanceOf(payer);
  const sent = await h.dispenser.claim({ type: 2, gasLimit: 250000n, maxFeePerGas: 5000000000n, maxPriorityFeePerGas: 1000000000n }); await sent.wait(); claimHash = sent.hash;
  claimProof = await h.dispenserChain.verifyClaim({ payer, transactionHash: claimHash });
  assert.equal(claimProof.success, true); assert.equal(claimProof.payer, payer); assert.equal(claimProof.amount, h.dispenserChain.identity.claimAmount);
  assert.equal(claimProof.transactionHash, claimHash); assert.equal(claimProof.dispenserConfigHash, h.dispenserConfig.configHash);
  assert.equal((await h.token.balanceOf(payer)) - before, BigInt(claimProof.amount));
  const inspection = await h.dispenserChain.inspectClaim({ payer }); assert.equal(inspection.claimed, true); assert.equal(inspection.eligible, false); assert.equal(inspection.reason, 'already_claimed');
  assert.deepEqual(await h.dispenserChain.verifyClaim({ payer, transactionHash: claimHash }), claimProof);
  await assert.rejects(h.dispenser.claim()); assert.equal((await h.token.balanceOf(payer)) - before, BigInt(claimProof.amount));
});

test('claim proof distinguishes absent proof, finalized revert, unfinalized and wrong payer without any write', async () => {
  await assert.rejects(h.dispenserChain.verifyClaim({ payer, transactionHash: id('not-submitted') }), error => error.code === 'CLAIM_PENDING' && error.doNotReleaseReservation && error.doNotRepay);
  await assert.rejects(h.dispenserChain.verifyClaim({ payer: await h.operator.getAddress(), transactionHash: claimHash }), { code: 'DISPENSER_TRANSACTION_MISMATCH' });
  const sent = await h.dispenser.claim({ type: 2, gasLimit: 250000n, maxFeePerGas: 5000000000n, maxPriorityFeePerGas: 1000000000n }); await assert.rejects(sent.wait());
  await assert.rejects(h.dispenserChain.verifyClaim({ payer, transactionHash: sent.hash }), error => error.code === 'CLAIM_REVERTED' && error.doNotReleaseReservation);
  const parentBlock = await h.reader.send('eth_getBlockByNumber', ['0x' + (BigInt(claimProof.blockNumber) - 1n).toString(16), false]);
  const reader = transformed((method, params, value) => method === 'eth_getBlockByNumber' && params[0] === 'finalized' ? parentBlock : value);
  const chain = await createDispenserChain(h.dispenserOptions(reader));
  await assert.rejects(chain.verifyClaim({ payer, transactionHash: claimHash }), { code: 'NOT_FINALIZED' });
});

test('altered claim event, historical finality anchor and late canonical changes are rejected', async () => {
  const altered = transformed((method, params, value) => { if (method === 'eth_getTransactionReceipt' && params[0] === claimHash) value.logs.find(log => log.address.toLowerCase() === h.dispenserChain.identity.dispenser).removed = true; return value; });
  const changedChain = await createDispenserChain(h.dispenserOptions(altered));
  await assert.rejects(changedChain.verifyClaim({ payer, transactionHash: claimHash }), { code: 'DISPENSER_EVENT_MISMATCH' });
  await h.provider.send('evm_mine', []);
  assert.equal((await h.dispenserChain.verifyClaim({ payer, transactionHash: claimHash, finalizedAnchor: claimProof.finalized })).transactionHash, claimHash);
  await assert.rejects(h.dispenserChain.verifyClaim({ payer, transactionHash: claimHash, finalizedAnchor: { ...claimProof.finalized, blockHash: id('old-finality-fork') } }), { code: 'SETTLEMENT_REORG' });
  let armed = false, count = 0;
  const late = transformed((method, params, value) => {
    if (armed && method === 'eth_getBlockByNumber' && params[0] === '0x' + BigInt(claimProof.blockNumber).toString(16) && ++count >= 2) value.hash = id('late-claim-block-fork');
    return value;
  });
  const lateChain = await createDispenserChain(h.dispenserOptions(late)); armed = true;
  await assert.rejects(lateChain.verifyClaim({ payer, transactionHash: claimHash }), { code: 'SETTLEMENT_REORG' });
});

test('verification helpers cannot authorize transactions and preserve exact pinned config on reopening', async () => {
  let writes = 0;
  const reader = { ...h.reader, async send(method, params) { if (/send|sign|wallet|personal/i.test(method)) writes++; return h.reader.send(method, params); } };
  const evidence = await verifyDispenserDeployment({ baseConfig: h.config, expectedBaseConfigHash: h.config.configHash, plan: h.dispenserPlan, transactionHashes: h.dispenserHashes, fixtureReader: reader });
  assert.equal(evidence.broadcastAuthorization, false); assert.equal(evidence.publicNetworkAuthenticityVerified, false);
  const reopened = await createDispenserChain(h.dispenserOptions(reader)); assert.deepEqual(reopened.identity, h.dispenserChain.identity);
  await reopened.verifyClaim({ payer, transactionHash: claimHash, finalizedAnchor: claimProof.finalized }); assert.equal(writes, 0);
  assert.equal('sendTransaction' in reopened, false); assert.equal('reader' in reopened, false); assert.equal('signer' in reopened, false);
});

test('finalized-head regression at proof completion retains uncertainty even if the claim block stays canonical', async () => {
  const latest = await h.reader.send('eth_getBlockByNumber', ['latest', false]);
  const earlier = await h.reader.send('eth_getBlockByNumber', ['0x' + (BigInt(latest.number) - 1n).toString(16), false]);
  let armed = false, sawClaim = false;
  const reader = transformed((method, params, value) => {
    if (armed && method === 'eth_getTransactionReceipt' && params[0] === claimHash) sawClaim = true;
    return sawClaim && method === 'eth_getBlockByNumber' && params[0] === 'finalized' ? earlier : value;
  });
  const chain = await createDispenserChain(h.dispenserOptions(reader)); armed = true;
  await assert.rejects(chain.verifyClaim({ payer, transactionHash: claimHash }), error => error.code === 'SETTLEMENT_REORG' && error.doNotReleaseReservation && error.doNotRepay);
});
