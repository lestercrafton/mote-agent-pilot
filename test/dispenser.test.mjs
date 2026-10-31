import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import ganache from 'ganache';
import solc from 'solc';
import { BrowserProvider, ContractFactory, ZeroAddress, id } from 'ethers';
import { compileContracts } from '../scripts/compile.mjs';
import { compileDispenser } from '../scripts/compile-dispenser.mjs';

// Public, insecure test-vector accounts; in-process Ganache only. No external
// RPC, new key generation, persistent keys, faucet requests or public transfers.
const PUBLIC_LOCAL_FIXTURE = 'test test test test test test test test test test test junk';
const FIXED_SUPPLY = 1_000_000n * 10n ** 6n;
const modes = { normal: 0, receiverTax: 1, senderTax: 2, falseReturn: 3, revert: 4, noOp: 5, caughtReentry: 6, bubbledReentry: 7 };
let evm, provider, accounts, addresses, tokenArtifact, dispenserArtifact, hostileArtifact;

function compileHostileToken() {
  const filename = 'test/fixtures/DispenserTokens.sol';
  const input = {
    language: 'Solidity', sources: { [filename]: { content: fs.readFileSync(new URL('./fixtures/DispenserTokens.sol', import.meta.url), 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import(name) {
    if (!name.startsWith('@openzeppelin/contracts/') || name.includes('..')) return { error: 'Unsupported test import' };
    return { contents: fs.readFileSync(fileURLToPath(new URL(`../node_modules/${name}`, import.meta.url)), 'utf8') };
  } }));
  assert.deepEqual((output.errors ?? []).filter(e => e.severity === 'error'), []);
  const result = output.contracts[filename].AdversarialDispenserToken;
  return { abi: result.abi, bytecode: `0x${result.evm.bytecode.object}` };
}

before(async () => {
  tokenArtifact = compileContracts({ writeArtifacts: false }).MoteToken;
  dispenserArtifact = compileDispenser({ writeArtifact: false });
  hostileArtifact = compileHostileToken();
  evm = ganache.provider({
    chain: { chainId: 31337, networkId: 31337, hardfork: 'shanghai' },
    wallet: { mnemonic: PUBLIC_LOCAL_FIXTURE, totalAccounts: 8 },
    logging: { quiet: true }, miner: { instamine: 'eager' },
  });
  provider = new BrowserProvider(evm, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 10;
  accounts = await Promise.all(Array.from({ length: 8 }, (_, i) => provider.getSigner(i)));
  addresses = await Promise.all(accounts.map(account => account.getAddress()));
});
after(async () => { provider?.destroy(); await evm?.disconnect(); });

async function deploy(artifact, ...args) {
  const contract = await new ContractFactory(artifact.abi, artifact.bytecode, accounts[0]).deploy(...args);
  await contract.waitForDeployment(); return contract;
}
async function fixture({ amount = 100n, cap = 300n, funding = 0n, hostile = false } = {}) {
  const token = hostile ? await deploy(hostileArtifact) : await deploy(tokenArtifact, addresses[0]);
  const dispenser = await deploy(dispenserArtifact, await token.getAddress(), amount, cap);
  const address = await dispenser.getAddress();
  if (funding) await (await token.transfer(address, funding)).wait();
  return { token, dispenser, address, amount, cap };
}
function claims(dispenser, receipt) {
  return receipt.logs.filter(log => log.address.toLowerCase() === dispenser.target.toLowerCase())
    .map(log => dispenser.interface.parseLog(log)).filter(log => log?.name === 'Claimed');
}
async function rejectedClaim(dispenser, account, reason) {
  await assert.rejects(dispenser.connect(account).claim.staticCall(), error => {
    return error.revert?.name === reason || error.reason === reason;
  }, `Expected ${reason}`);
  // A mined revert, not only estimation, proves all storage/token effects roll
  // back and no receipt event can accidentally report a successful claim.
  const tx = await dispenser.connect(account).claim({ gasLimit: 500_000n });
  let receipt;
  try { receipt = await tx.wait(); assert.fail('Claim unexpectedly succeeded'); }
  catch (error) { assert.equal(error.code, 'CALL_EXCEPTION'); receipt = error.receipt; }
  assert.equal(receipt.status, 0); assert.equal(receipt.logs.length, 0);
  return receipt;
}

test('separate dispenser is prefunded from unchanged fixed supply and exposes no owner/mint/sweep authority', async () => {
  const f = await fixture({ funding: 300n });
  assert.equal(await f.token.totalSupply(), FIXED_SUPPLY);
  assert.equal(await f.token.balanceOf(addresses[0]), FIXED_SUPPLY - 300n);
  assert.equal(await f.token.balanceOf(f.address), 300n);
  assert.equal(await f.dispenser.token(), await f.token.getAddress());
  assert.equal(await f.dispenser.claimAmount(), 100n); assert.equal(await f.dispenser.distributionCap(), 300n);
  assert.equal(await f.dispenser.distributed(), 0n); assert.equal(await f.dispenser.claimed(addresses[1]), false);
  assert.deepEqual(dispenserArtifact.abi.filter(entry => entry.type === 'function' && !['view', 'pure'].includes(entry.stateMutability)).map(entry => entry.name), ['claim']);
  assert.equal(dispenserArtifact.abi.some(entry => ['receive', 'fallback'].includes(entry.type)), false);
  assert.equal(tokenArtifact.abi.some(entry => ['mint', 'owner', 'sweep', 'upgradeTo'].includes(entry.name)), false);
});

test('empty or insufficient funding leaves a claim retryable; later funding permits exactly one payout', async () => {
  const f = await fixture();
  for (const partialFunding of [0n, 99n]) {
    if (partialFunding) await (await f.token.transfer(f.address, partialFunding)).wait();
    await rejectedClaim(f.dispenser, accounts[1], 'InsufficientFunding');
    assert.equal(await f.dispenser.claimed(addresses[1]), false); assert.equal(await f.dispenser.distributed(), 0n);
    assert.equal(await f.token.balanceOf(addresses[1]), 0n); assert.equal(await f.token.balanceOf(f.address), partialFunding);
  }
  await (await f.token.transfer(f.address, 1n)).wait();
  const receipt = await (await f.dispenser.connect(accounts[1]).claim()).wait();
  assert.equal(receipt.status, 1); assert.equal(await f.token.balanceOf(addresses[1]), 100n);
  assert.equal(await f.token.balanceOf(f.address), 0n); assert.equal(await f.token.totalSupply(), FIXED_SUPPLY);
  assert.equal(await f.dispenser.claimed(addresses[1]), true); assert.equal(await f.dispenser.distributed(), 100n);
  const events = claims(f.dispenser, receipt); assert.equal(events.length, 1);
  assert.equal(events[0].args.claimant, addresses[1]); assert.equal(events[0].args.amount, 100n); assert.equal(events[0].args.totalDistributed, 100n);
  await rejectedClaim(f.dispenser, accounts[1], 'AlreadyClaimed');
  assert.equal(await f.token.balanceOf(addresses[1]), 100n); assert.equal(await f.dispenser.distributed(), 100n);
});

test('one address is not one identity: distinct local fixture accounts can exhaust the immutable total cap', async () => {
  const f = await fixture({ funding: 300n });
  // All three fixture accounts are controlled by this one test process. This
  // explicitly demonstrates Sybilability, not anti-bot or unique-agent proof.
  for (let i = 1; i <= 3; i++) {
    const receipt = await (await f.dispenser.connect(accounts[i]).claim()).wait();
    assert.equal(await f.token.balanceOf(addresses[i]), 100n); assert.equal(await f.dispenser.claimed(addresses[i]), true);
    assert.equal(claims(f.dispenser, receipt)[0].args.totalDistributed, BigInt(i) * 100n);
  }
  await rejectedClaim(f.dispenser, accounts[4], 'DistributionCapExceeded');
  assert.equal(await f.dispenser.claimed(addresses[4]), false); assert.equal(await f.dispenser.distributed(), 300n);
});

test('excess funding and later topups cannot extend the cap; surplus has no withdrawal path', async () => {
  const f = await fixture({ amount: 100n, cap: 200n, funding: 700n });
  for (const account of accounts.slice(1, 3)) await (await f.dispenser.connect(account).claim()).wait();
  await rejectedClaim(f.dispenser, accounts[3], 'DistributionCapExceeded');
  assert.equal(await f.token.balanceOf(f.address), 500n);
  await (await f.token.transfer(f.address, 100n)).wait();
  await rejectedClaim(f.dispenser, accounts[3], 'DistributionCapExceeded');
  assert.equal(await f.token.balanceOf(f.address), 600n); assert.equal(await f.dispenser.distributed(), 200n);
  assert.equal(await f.token.totalSupply(), FIXED_SUPPLY);
});

test('competing distinct-address transactions cannot exceed the last available claim', async () => {
  const f = await fixture({ amount: 100n, cap: 100n, funding: 200n });
  const outcomes = await Promise.allSettled(accounts.slice(1, 3).map(async account => (await f.dispenser.connect(account).claim({ gasLimit: 500_000n })).wait()));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(result => result.status === 'rejected' && result.reason.receipt?.status === 0).length, 1);
  assert.equal(await f.dispenser.distributed(), 100n); assert.equal(await f.token.balanceOf(f.address), 100n);
  assert.equal((await Promise.all(addresses.slice(1, 3).map(address => f.dispenser.claimed(address)))).filter(Boolean).length, 1);
  assert.equal((await f.token.balanceOf(addresses[1])) + (await f.token.balanceOf(addresses[2])), 100n);
});

test('constructor rejects missing token code and zero, excessive, inverted or indivisible limits', async () => {
  const token = await deploy(tokenArtifact, addresses[0]), tokenAddress = await token.getAddress();
  const valid = await deploy(dispenserArtifact, tokenAddress, 100n, 100n);
  const maxAmount = await valid.MAX_CLAIM_AMOUNT(), maxCap = await valid.MAX_DISTRIBUTION_CAP();
  for (const args of [
    [ZeroAddress, 100n, 100n], [addresses[1], 100n, 100n], [tokenAddress, 0n, 100n],
    [tokenAddress, 100n, 0n], [tokenAddress, 100n, 99n], [tokenAddress, 100n, 101n],
    [tokenAddress, maxAmount + 1n, maxAmount + 1n], [tokenAddress, 1n, maxCap + 1n],
  ]) {
    const failed = await new ContractFactory(dispenserArtifact.abi, dispenserArtifact.bytecode, accounts[0]).deploy(...args, { gasLimit: 1_000_000n });
    await assert.rejects(failed.waitForDeployment(), error => error.code === 'CALL_EXCEPTION' && error.receipt?.status === 0);
    assert.equal(await provider.getCode(await failed.getAddress()), '0x');
  }
  const boundary = await deploy(dispenserArtifact, tokenAddress, maxAmount, maxCap);
  assert.equal(await boundary.claimAmount(), maxAmount); assert.equal(await boundary.distributionCap(), maxCap);
});

for (const [name, mode, error] of [
  ['recipient transfer tax', modes.receiverTax, 'UnexpectedBalanceDelta'],
  ['sender transfer tax', modes.senderTax, 'UnexpectedBalanceDelta'],
  ['false return after balance mutation', modes.falseReturn, 'SafeERC20FailedOperation'],
  ['reverting transfer', modes.revert, 'Controlled token rejection'],
  ['successful no-op transfer', modes.noOp, 'UnexpectedBalanceDelta'],
]) {
  test(`unsupported token ${name} rolls back balances, supply and claim state; same claimant can retry`, async () => {
    const f = await fixture({ hostile: true, funding: 300n });
    const supply = await f.token.totalSupply();
    await (await f.token.setMode(mode, f.address)).wait();
    await rejectedClaim(f.dispenser, accounts[1], error);
    assert.equal(await f.dispenser.claimed(addresses[1]), false); assert.equal(await f.dispenser.distributed(), 0n);
    assert.equal(await f.token.balanceOf(f.address), 300n); assert.equal(await f.token.balanceOf(addresses[1]), 0n); assert.equal(await f.token.totalSupply(), supply);
    await (await f.token.setMode(modes.normal, ZeroAddress)).wait();
    await (await f.dispenser.connect(accounts[1]).claim()).wait();
    assert.equal(await f.token.balanceOf(addresses[1]), 100n); assert.equal(await f.dispenser.distributed(), 100n);
  });
}

test('caught token reentry cannot claim for a second address or increase the outer exact payout', async () => {
  const f = await fixture({ hostile: true, funding: 300n });
  await (await f.token.setMode(modes.caughtReentry, f.address)).wait();
  const receipt = await (await f.dispenser.connect(accounts[1]).claim()).wait();
  assert.equal(await f.token.reentryAttempted(), true); assert.equal(await f.token.reentrySucceeded(), false);
  assert.equal(await f.token.reentryError(), id('ReentrancyGuardReentrantCall()').slice(0, 10));
  assert.equal(await f.dispenser.claimed(await f.token.getAddress()), false);
  assert.equal(await f.token.balanceOf(await f.token.getAddress()), 0n);
  assert.equal(await f.token.balanceOf(addresses[1]), 100n); assert.equal(await f.token.balanceOf(f.address), 200n);
  assert.equal(await f.dispenser.distributed(), 100n); assert.equal(claims(f.dispenser, receipt).length, 1);
});

test('bubbled token reentry reverts the entire claim and remains retryable', async () => {
  const f = await fixture({ hostile: true, funding: 300n });
  await (await f.token.setMode(modes.bubbledReentry, f.address)).wait();
  await rejectedClaim(f.dispenser, accounts[1], 'ReentrancyGuardReentrantCall');
  assert.equal(await f.dispenser.claimed(addresses[1]), false); assert.equal(await f.dispenser.distributed(), 0n);
  assert.equal(await f.token.balanceOf(f.address), 300n); assert.equal(await f.token.reentryAttempted(), false);
  await (await f.token.setMode(modes.normal, ZeroAddress)).wait();
  await (await f.dispenser.connect(accounts[1]).claim()).wait();
  assert.equal(await f.token.balanceOf(addresses[1]), 100n);
});

test('native value cannot be accepted through claim and does not consume the address entitlement', async () => {
  const f = await fixture({ funding: 100n });
  const tx = await accounts[1].sendTransaction({ to: f.address, data: f.dispenser.interface.encodeFunctionData('claim'), value: 1n, gasLimit: 300_000n });
  await assert.rejects(tx.wait(), error => error.code === 'CALL_EXCEPTION' && error.receipt?.status === 0);
  assert.equal(await provider.getBalance(f.address), 0n); assert.equal(await f.dispenser.claimed(addresses[1]), false);
  await (await f.dispenser.connect(accounts[1]).claim()).wait(); assert.equal(await f.token.balanceOf(addresses[1]), 100n);
});
