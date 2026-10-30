import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { id, ZeroHash, ContractFactory } from 'ethers';
import { createLocalChain, quoteDomain, QUOTE_TYPES } from '../src/chain.mjs';
import { compileContracts } from '../scripts/compile.mjs';

let chain;
let payerAddress;
let routerAddress;
let sequence = 0;

before(async () => {
  chain = await createLocalChain();
  payerAddress = await chain.payer.getAddress();
  routerAddress = await chain.payments.getAddress();
});
after(async () => chain?.close());

async function signedQuote(changes = {}, domainChanges = {}) {
  const block = await chain.provider.getBlock('latest');
  const quote = {
    quoteId: id(`contract-test-quote-${++sequence}`),
    requestHash: id('bounded-json-input'),
    payer: payerAddress,
    amount: 100n,
    deadline: BigInt(block.timestamp + 300),
    ...changes,
  };
  const signature = await chain.quoteSigner.signTypedData(
    { ...quoteDomain(chain.chainId, routerAddress), ...domainChanges }, QUOTE_TYPES, quote,
  );
  return { quote, signature };
}

test('fixed supply, six decimals, standard ERC20 transfer and exact approvals', async () => {
  assert.equal(await chain.token.name(), 'Mote');
  assert.equal(await chain.token.symbol(), 'MOTE');
  assert.equal(await chain.token.decimals(), 6n);
  assert.equal(await chain.token.totalSupply(), 1_000_000n * 10n ** 6n);
  assert.equal(await chain.token.balanceOf(payerAddress), 100n * 10n ** 6n);
  const abi = compileContracts({ writeArtifacts: false }).MoteToken.abi;
  assert.equal(abi.some((entry) => ['mint', 'owner', 'pause', 'blacklist', 'upgradeTo'].includes(entry.name)), false);

  const recipient = await (await chain.provider.getSigner(3)).getAddress();
  await (await chain.token.connect(chain.payer).transfer(recipient, 25n)).wait();
  assert.equal(await chain.token.balanceOf(recipient), 25n);
  await (await chain.token.connect(chain.payer).approve(routerAddress, 100n)).wait();
  assert.equal(await chain.token.allowance(payerAddress, routerAddress), 100n);
});

test('signed payment transfers exact amount, emits binding receipt, and consumes approval', async () => {
  const { quote, signature } = await signedQuote();
  const beforePayer = await chain.token.balanceOf(payerAddress);
  const merchantAddress = await chain.merchant.getAddress();
  const beforeMerchant = await chain.token.balanceOf(merchantAddress);
  const receipt = await (await chain.payments.connect(chain.payer).pay(quote, signature)).wait();
  assert.equal(await chain.token.balanceOf(payerAddress), beforePayer - quote.amount);
  assert.equal(await chain.token.balanceOf(merchantAddress), beforeMerchant + quote.amount);
  assert.equal(await chain.token.allowance(payerAddress, routerAddress), 0n);
  assert.equal(await chain.payments.consumed(quote.quoteId), true);
  const paid = receipt.logs.map((log) => { try { return chain.payments.interface.parseLog(log); } catch { return null; } })
    .find((event) => event?.name === 'Paid');
  assert.equal(paid.args.quoteId, quote.quoteId);
  assert.equal(paid.args.requestHash, quote.requestHash);
  assert.equal(paid.args.payer, payerAddress);
  assert.equal(paid.args.amount, quote.amount);
  await assert.rejects(chain.payments.connect(chain.payer).pay(quote, signature), /revert|CALL_EXCEPTION/);
});

test('wrong payer, altered amount, altered request, wrong chain and wrong router are rejected', async () => {
  await (await chain.token.connect(chain.payer).approve(routerAddress, 1000n)).wait();
  const { quote, signature } = await signedQuote();
  await assert.rejects(chain.payments.connect(chain.merchant).pay(quote, signature), /revert|CALL_EXCEPTION/);
  await assert.rejects(chain.payments.connect(chain.payer).pay({ ...quote, amount: 101n }, signature), /revert|CALL_EXCEPTION/);
  await assert.rejects(chain.payments.connect(chain.payer).pay({ ...quote, requestHash: id('other') }, signature), /revert|CALL_EXCEPTION/);
  const wrongChain = await signedQuote({}, { chainId: 1 });
  await assert.rejects(chain.payments.connect(chain.payer).pay(wrongChain.quote, wrongChain.signature), /revert|CALL_EXCEPTION/);
  const wrongRouter = await signedQuote({}, { verifyingContract: await chain.token.getAddress() });
  await assert.rejects(chain.payments.connect(chain.payer).pay(wrongRouter.quote, wrongRouter.signature), /revert|CALL_EXCEPTION/);
  assert.equal(await chain.payments.consumed(quote.quoteId), false);
});

test('expired, zero amount, zero quote ID and unauthorized signatures are rejected', async () => {
  const block = await chain.provider.getBlock('latest');
  for (const overrides of [{ deadline: BigInt(block.timestamp - 1) }, { amount: 0n }, { quoteId: ZeroHash }]) {
    const { quote, signature } = await signedQuote(overrides);
    await assert.rejects(chain.payments.connect(chain.payer).pay(quote, signature), /revert|CALL_EXCEPTION/);
    assert.equal(await chain.payments.consumed(quote.quoteId), false);
  }
  const { quote } = await signedQuote();
  const wrongSignature = await chain.quoteSigner.signTypedData(quoteDomain(chain.chainId, routerAddress), QUOTE_TYPES, { ...quote, amount: 9n });
  await assert.rejects(chain.payments.connect(chain.payer).pay(quote, wrongSignature), /revert|CALL_EXCEPTION/);
});

test('failed approval or insufficient balance cannot consume a quote or charge the payer', async () => {
  await (await chain.token.connect(chain.payer).approve(routerAddress, 0n)).wait();
  const { quote, signature } = await signedQuote();
  const balance = await chain.token.balanceOf(payerAddress);
  await assert.rejects(chain.payments.connect(chain.payer).pay(quote, signature), /revert|CALL_EXCEPTION/);
  assert.equal(await chain.payments.consumed(quote.quoteId), false);
  assert.equal(await chain.token.balanceOf(payerAddress), balance);

  // The same quote succeeds after a legitimate exact approval; failure did not use it.
  await (await chain.token.connect(chain.payer).approve(routerAddress, quote.amount)).wait();
  await (await chain.payments.connect(chain.payer).pay(quote, signature)).wait();
  const excessive = await signedQuote({ amount: balance + 1n });
  await (await chain.token.connect(chain.payer).approve(routerAddress, excessive.quote.amount)).wait();
  await assert.rejects(chain.payments.connect(chain.payer).pay(excessive.quote, excessive.signature), /revert|CALL_EXCEPTION/);
  assert.equal(await chain.payments.consumed(excessive.quote.quoteId), false);
});

test('a second router cannot replay another router signature', async () => {
  const artifact = compileContracts({ writeArtifacts: false }).MotePayments;
  const second = await new ContractFactory(artifact.abi, artifact.bytecode, chain.merchant)
    .deploy(await chain.token.getAddress(), await chain.merchant.getAddress(), chain.quoteSigner.address);
  await second.waitForDeployment();
  const { quote, signature } = await signedQuote();
  await (await chain.token.connect(chain.payer).approve(await second.getAddress(), quote.amount)).wait();
  await assert.rejects(second.connect(chain.payer).pay(quote, signature), /revert|CALL_EXCEPTION/);
  assert.equal(await second.consumed(quote.quoteId), false);
});

test('competing transactions cannot spend the same token balance twice', async () => {
  const balance = await chain.token.balanceOf(payerAddress);
  const amount = (balance / 2n) + 1n;
  const first = await signedQuote({ amount });
  const second = await signedQuote({ amount });
  await (await chain.token.connect(chain.payer).approve(routerAddress, amount * 2n)).wait();
  const nonce = await chain.provider.getTransactionCount(payerAddress, 'pending');
  const attempts = await Promise.allSettled([first, second].map(async ({ quote, signature }, index) => {
    const tx = await chain.payments.connect(chain.payer).pay(quote, signature, { nonce: nonce + index, gasLimit: 300000n });
    return tx.wait();
  }));
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1);
  assert.equal(await chain.token.balanceOf(payerAddress), balance - amount);
  const used = await Promise.all([first, second].map(({ quote }) => chain.payments.consumed(quote.quoteId)));
  assert.equal(used.filter(Boolean).length, 1);
});

test('reset local chains reject old-boot quote signatures', async () => {
  const { quote, signature } = await signedQuote();
  const fresh = await createLocalChain();
  try {
    // Public fixture transaction accounts recreate addresses; the signer is per-boot.
    assert.equal(await fresh.payments.getAddress(), routerAddress);
    assert.notEqual(fresh.quoteSigner.address, chain.quoteSigner.address);
    await assert.rejects(
      fresh.payments.connect(fresh.payer).pay.staticCall(quote, signature),
      (error) => error.revert?.name === 'InvalidSignature',
    );
    assert.equal(await fresh.payments.consumed(quote.quoteId), false);
  } finally {
    await fresh.close();
  }
});
