import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getAddress } from 'ethers';
import { parseJson } from '../src/json.mjs';
import { createTestnetPlan, validateTestnetPlan, verifyTestnetDeployment } from '../src/testnet-plan.mjs';
import { createVerificationBundle } from '../src/verification-bundle.mjs';
import { createBaseSepoliaReader, inspectBaseSepolia, createEthereumSepoliaReader, inspectEthereumSepolia } from '../src/testnet-rpc.mjs';
import { getTestnetNetwork } from '../src/testnet-networks.mjs';
import { compileContracts } from './compile.mjs';

const HELP = `Mote pinned testnet preparation — no signer, funding or broadcast commands.

  node scripts/testnet.mjs inspect [--network base-sepolia|ethereum-sepolia] [--out observation.json]
  node scripts/testnet.mjs account --address PUBLIC_ADDRESS [--network base-sepolia|ethereum-sepolia] [--out account.json]
  node scripts/testnet.mjs verification --out NEW_DIRECTORY
  node scripts/testnet.mjs plan --config PUBLIC_ROLES.json --out NEW_DIRECTORY
  node scripts/testnet.mjs verify --plan plan.json --receipts hashes.json [--out result.json]

inspect/account select a pinned network (default Base); verify infers it from the plan.
Base reads https://sepolia.base.org; Ethereum reads https://ethereum-sepolia-rpc.publicnode.com.
plan/verification are offline. Existing output files/directories are never replaced.
No private key, mnemonic, API key, alternate RPC, gas authorization or send option is accepted.
Account balances are test ETH base units; an observation does not authorize spending.
`;

function args(argv) {
  const [command = 'help', ...tail] = argv;
  const allowed = { help: [], inspect: ['out','network'], account: ['address', 'out','network'], verification: ['out'], plan: ['config', 'out'], verify: ['plan', 'receipts', 'out'] };
  if (!Object.hasOwn(allowed, command)) throw new Error('Unknown command. Use help; no broadcast command exists.');
  const options = {};
  for (let i = 0; i < tail.length; i += 2) {
    const key = tail[i]?.slice(2);
    if (!tail[i]?.startsWith('--') || !allowed[command].includes(key) || Object.hasOwn(options, key) || !tail[i + 1] || tail[i + 1].startsWith('--')) throw new Error('Unsupported, duplicate or missing option. Use help.');
    options[key] = tail[i + 1];
  }
  return { command, options };
}
async function readJson(filename) {
  if (!filename) throw new Error('Required public JSON filename is missing.');
  const info = await stat(filename);
  if (!info.isFile() || info.size > 65536) throw new Error('Public input must be a regular JSON file of at most 65536 bytes.');
  return parseJson(await readFile(filename, 'utf8'));
}
async function save(filename, value) {
  await writeFile(filename, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
}
async function output(value, filename) {
  if (filename) await save(filename, value);
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}
async function verificationFiles(directory, bundle) {
  const artifacts = compileContracts({ writeArtifacts: false });
  await save(resolve(directory, 'solc-input.json'), bundle.input);
  const { input, ...build } = bundle;
  await save(resolve(directory, 'build-info.json'), build);
  for (const name of ['MoteToken', 'MotePayments']) await save(resolve(directory, `${name}.abi.json`), artifacts[name].abi);
}

export async function runTestnetCli(argv) {
  const { command, options } = args(argv);
  if (command === 'help') { process.stdout.write(HELP); return; }
  const selected = options.network ?? 'base-sepolia';
  const selectedChain = { 'base-sepolia':84532, 'ethereum-sepolia':11155111 }[selected];
  if (!selectedChain) throw new Error('Only the two pinned testnet names are supported.');
  const readerFor = chainId => getTestnetNetwork(chainId).chainId === 11155111 ? createEthereumSepoliaReader() : createBaseSepoliaReader();
  const inspect = (chainId, reader) => chainId === 11155111 ? inspectEthereumSepolia({reader}) : inspectBaseSepolia({reader});
  if (command === 'inspect') { await output(await inspect(selectedChain,readerFor(selectedChain)), options.out); return; }
  if (command === 'account') {
    if (!options.address) throw new Error('An existing public testnet address is required; this command cannot create a wallet.');
    const address = getAddress(options.address);
    const reader = readerFor(selectedChain);
    const observation = await inspect(selectedChain,reader);
    const [balance, pendingNonce, latestNonce, code] = await Promise.all([
      reader.send('eth_getBalance', [address, 'latest']), reader.send('eth_getTransactionCount', [address, 'pending']),
      reader.send('eth_getTransactionCount', [address, 'latest']), reader.send('eth_getCode', [address, 'latest']),
    ]);
    await output({ status: 'read-only-account-observation', chainId: observation.chainId, address,
      observedAt: new Date().toISOString(), testEthBalanceWei: BigInt(balance).toString(),
      pendingNonce: BigInt(pendingNonce).toString(), latestNonce: BigInt(latestNonce).toString(),
      pendingNonceMatchesLatest: pendingNonce === latestNonce, hasContractCode: code !== '0x',
      feeBudgetVerified: false, deploymentAuthorized: false, faucetClaimed: false }, options.out);
    return;
  }
  if (command === 'verification' || command === 'plan') {
    if (!options.out) throw new Error('A new output directory is required.');
    const plan = command === 'plan' ? createTestnetPlan(await readJson(options.config)) : null;
    const bundle = createVerificationBundle();
    // All validation/compilation happens before creating output state.
    await mkdir(options.out, { recursive: false });
    await verificationFiles(options.out, bundle);
    if (plan) await save(resolve(options.out, 'plan.json'), plan);
    process.stdout.write(JSON.stringify({ status: 'prepared-offline', directory: resolve(options.out),
      planHash: plan?.planHash ?? null, verificationInputHash: bundle.inputHash,
      chainId: plan?.chainId ?? null, publicDeployment: false, broadcastEnabled: false,
      note: 'Public artifacts only. Resolve signer provisioning, fee limits and approval before any external signing or submission.' }, null, 2) + '\n');
    return;
  }
  const plan = validateTestnetPlan(await readJson(options.plan));
  const transactionHashes = await readJson(options.receipts);
  const provider = readerFor(plan.chainId);
  const observation = await inspect(plan.chainId,provider);
  const verification = await verifyTestnetDeployment({ plan, provider, transactionHashes });
  await output({ ...verification, networkObservation: observation, paidServiceReady: false }, options.out);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runTestnetCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.code ?? 'TESTNET_PREPARATION_ERROR'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
