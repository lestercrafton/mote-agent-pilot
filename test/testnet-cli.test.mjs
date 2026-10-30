import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/testnet.mjs', import.meta.url));
const run = (args, cwd) => exec(process.execPath, [script, ...args], { cwd, timeout: 15000, maxBuffer: 1024 * 1024 });
const roles = { chainId: 84532, deployer: '0x1111111111111111111111111111111111111111', initialHolder: '0x2222222222222222222222222222222222222222', merchant: '0x3333333333333333333333333333333333333333', quoteSigner: '0x4444444444444444444444444444444444444444', nonce: '0' };

test('CLI exposes no broadcast, signer, alternate RPC or credential option', async () => {
  const help = await run(['help']);
  assert.match(help.stdout, /no signer, funding or broadcast/);
  for (const args of [['broadcast'], ['inspect', '--rpc', 'https://example.com'], ['inspect', '--private-key', 'synthetic-do-not-log'], ['help', '--out', 'unused'], ['inspect', '--out']]) {
    await assert.rejects(run(args), error => {
      assert.equal(error.code, 1);
      assert.ok(!error.stdout.includes('synthetic-do-not-log') && !error.stderr.includes('synthetic-do-not-log'));
      return true;
    });
  }
});

test('offline CLI validates roles before creating files and never overwrites a prepared plan', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mote-testnet-cli-'));
  const config = join(directory, 'roles.json');
  const out = join(directory, 'plan');
  try {
    for (const input of [{ ...roles, chainId: 1 }, { ...roles, privateKey: 'synthetic-do-not-log' }, { ...roles, quoteSigner: null }]) {
      await writeFile(config, JSON.stringify(input));
      await assert.rejects(run(['plan', '--config', config, '--out', out], directory), error => {
        assert.equal(error.code, 1);
        assert.ok(!error.stdout.includes('synthetic-do-not-log') && !error.stderr.includes('synthetic-do-not-log'));
        return true;
      });
      await assert.rejects(access(out), { code: 'ENOENT' });
    }
    await writeFile(config, JSON.stringify(roles));
    const result = JSON.parse((await run(['plan', '--config', config, '--out', out], directory)).stdout);
    assert.equal(result.status, 'prepared-offline');
    assert.equal(result.publicDeployment, false);
    assert.equal(result.broadcastEnabled, false);
    const before = await readFile(join(out, 'plan.json'), 'utf8');
    const plan = JSON.parse(before);
    assert.equal(plan.transactions.length, 2);
    assert.equal(plan.authorization, false);
    assert.equal(plan.transactions.every(tx => tx.chainId === 84532 && tx.to === null && tx.value === '0'), true);
    assert.ok(Object.keys(JSON.parse(await readFile(join(out, 'solc-input.json'), 'utf8')).sources).length > 2);
    await assert.rejects(run(['plan', '--config', config, '--out', out], directory), { code: 1 });
    assert.equal(await readFile(join(out, 'plan.json'), 'utf8'), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Ethereum offline plan selects only its own network; no secret or broadcast options added', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mote-ethereum-cli-'));
  try {
    const config = join(directory, 'roles.json'), out = join(directory, 'plan');
    await writeFile(config, JSON.stringify({ ...roles, chainId: 11155111 }));
    const result = JSON.parse((await run(['plan', '--config', config, '--out', out], directory)).stdout);
    assert.equal(result.chainId, 11155111);
    const plan = JSON.parse(await readFile(join(out, 'plan.json'), 'utf8'));
    assert.equal(plan.network, 'ethereum-sepolia');
    assert.equal(plan.schema, 'mote-ethereum-sepolia-deployment-plan-v1');
    for (const args of [['inspect', '--network', 'mainnet'], ['inspect', '--network', '11155111'], ['plan', '--network', 'ethereum-sepolia'], ['inspect', '--private-key', 'fixture-do-not-echo']]) await assert.rejects(run(args), {code:1});
  } finally { await rm(directory, {recursive:true,force:true}); }
});
