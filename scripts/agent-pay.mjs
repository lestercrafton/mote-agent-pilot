#!/usr/bin/env node
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Wallet } from 'ethers';
import {
  checkUsdcBalance,
  createEoaSigner,
  DEFAULT_RPCS,
  discoverPaidService,
  formatUsdc,
  payAndAudit,
} from '../src/agent-client.mjs';
import { rpcReader } from '../src/chain-proof.mjs';

const DEFAULT_ORIGIN = 'https://mote-testnet-pilot.onrender.com';

function usage() {
  console.log(`Usage: node scripts/agent-pay.mjs [options]

Autonomous Mote x402 agent client (zero manual wallet popups).

Modes:
  --dry-run                Discover live service, fetch 402 quote, check caps, and sign locally (no payment sent)
  --init-wallet <path>     Create a new 0600 disposable EOA key file and print its public Base address
  --check-balance          Check the payer wallet's live USDC balance for the discovered network
  --recover <paymentId>    Recover an existing payment's receipt from the local journal without signing again

Options:
  --origin <url>           Mote service origin (default: ${DEFAULT_ORIGIN})
  --input <json>           JSON payload for /v1/usdc/audit (default: manifest example)
  --input-file <path>      Read JSON payload from file
  --max-per-call <units>   Max micro-USDC per job (default: 10000 = 0.01 USDC)
  --max-total <units>      Max total micro-USDC for this journal (default: 10000 = 0.01 USDC)
  --journal <path>         Client SQLite journal path inside a 0700 dir (default: ./.mote-agent-state/client.sqlite)
  --payment-id <id>        Explicit payment ID (16-128 chars, [A-Za-z0-9_-])
  --key-file <path>        Read 0x-prefixed 32-byte private key from a 0600 file (or set MOTE_PAYER_PRIVATE_KEY)
  --rpc <url>              Override chain RPC URL
  --poll-ms <ms>           Finality poll interval for 202 pending responses (default: 5000)
  --max-polls <n>          Maximum 202 polls before returning pending (default: 60)
  --verify-recovery        Immediately replay original signed payload after 200 to prove identical receipt recovery
  --no-balance-check       Skip pre-flight USDC balance check
  --no-finality-check      Skip client-side on-chain finality proof verification
  --quiet                  Suppress progress events on stderr
  --help                   Show this help text
`);
}

function parseArgs(argv) {
  const opts = {
    origin: DEFAULT_ORIGIN,
    input: null,
    inputFile: null,
    maxPerPayment: '10000',
    maxTotal: '10000',
    journal: resolve('.mote-agent-state/client.sqlite'),
    paymentId: null,
    keyFile: null,
    initWallet: null,
    rpcUrl: null,
    pollIntervalMs: 5000,
    maxPolls: 60,
    dryRun: false,
    checkBalanceOnly: false,
    recoverOnly: false,
    verifyRecovery: false,
    checkBalance: true,
    verifyFinality: true,
    quiet: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[++i];
    };
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--origin') opts.origin = next();
    else if (arg === '--input') opts.input = JSON.parse(next());
    else if (arg === '--input-file') opts.inputFile = next();
    else if (arg === '--max-per-call') opts.maxPerPayment = next();
    else if (arg === '--max-total') opts.maxTotal = next();
    else if (arg === '--journal') opts.journal = resolve(next());
    else if (arg === '--payment-id') opts.paymentId = next();
    else if (arg === '--key-file') opts.keyFile = resolve(next());
    else if (arg === '--init-wallet') opts.initWallet = resolve(next());
    else if (arg === '--rpc') opts.rpcUrl = next();
    else if (arg === '--poll-ms') opts.pollIntervalMs = Number(next());
    else if (arg === '--max-polls') opts.maxPolls = Number(next());
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--check-balance') opts.checkBalanceOnly = true;
    else if (arg === '--recover') { opts.recoverOnly = true; opts.paymentId = next(); }
    else if (arg === '--verify-recovery') opts.verifyRecovery = true;
    else if (arg === '--no-balance-check') opts.checkBalance = false;
    else if (arg === '--no-finality-check') opts.verifyFinality = false;
    else if (arg === '--quiet') opts.quiet = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function readKeyFile(filePath) {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('KEY_FILE_NOT_REGULAR');
  if ((stat.mode & 0o077) !== 0) throw new Error('KEY_FILE_PERMISSIONS_TOO_OPEN (chmod 600 required)');
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const raw = readFileSync(fd, 'utf8').trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error('KEY_FILE_INVALID_HEX');
    return raw;
  } finally {
    closeSync(fd);
  }
}

function loadWallet(opts) {
  if (opts.dryRun && !opts.keyFile && !process.env.MOTE_PAYER_PRIVATE_KEY) {
    return Wallet.createRandom();
  }
  if (opts.keyFile) return new Wallet(readKeyFile(opts.keyFile));
  if (process.env.MOTE_PAYER_PRIVATE_KEY) {
    const key = process.env.MOTE_PAYER_PRIVATE_KEY.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('MOTE_PAYER_PRIVATE_KEY_INVALID');
    return new Wallet(key);
  }
  throw new Error('NO_PAYER_KEY: set MOTE_PAYER_PRIVATE_KEY, pass --key-file <0600-path>, or use --dry-run');
}

function initDisposableWallet(filePath) {
  if (existsSync(filePath)) throw new Error(`Refusing to overwrite existing wallet file: ${filePath}`);
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const wallet = Wallet.createRandom();
  const fd = openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, `${wallet.privateKey}\n`, { encoding: 'utf8' });
  } finally {
    closeSync(fd);
  }
  console.log(JSON.stringify({
    created: true,
    keyFile: filePath,
    mode: '0600',
    address: wallet.address,
    network: 'eip155:8453 (Base)',
    nextStep: 'Fund this address with a small amount of native Base USDC (e.g., 0.05 USDC; zero ETH gas needed for EIP-3009) and run scripts/agent-pay.mjs --key-file <path> --verify-recovery',
  }, null, 2));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { usage(); return; }
  if (opts.initWallet) { initDisposableWallet(opts.initWallet); return; }

  const wallet = loadWallet(opts);

  if (opts.checkBalanceOnly) {
    const discovery = await discoverPaidService({ origin: opts.origin });
    const rpc = rpcReader(opts.rpcUrl ?? DEFAULT_RPCS[discovery.config.network]);
    const bal = await checkUsdcBalance({ network: discovery.config.network, payer: wallet.address, rpc });
    console.log(JSON.stringify({
      origin: discovery.origin,
      network: discovery.config.network,
      payer: wallet.address.toLowerCase(),
      priceMicroUsdc: discovery.config.amount,
      priceUsdc: formatUsdc(discovery.config.amount),
      balanceMicroUsdc: bal.balanceMicroUsdc.toString(),
      balanceUsdc: bal.formattedUsdc,
      sufficient: bal.balanceMicroUsdc >= BigInt(discovery.config.amount),
    }, null, 2));
    return;
  }

  const input = opts.inputFile ? JSON.parse(readFileSync(resolve(opts.inputFile), 'utf8')) : opts.input;
  const result = await payAndAudit({
    origin: opts.origin,
    input,
    signer: createEoaSigner(wallet),
    journalPath: opts.journal,
    paymentId: opts.paymentId,
    maxPerPayment: opts.maxPerPayment,
    maxTotal: opts.maxTotal,
    rpcUrl: opts.rpcUrl,
    dryRun: opts.dryRun,
    recoverOnly: opts.recoverOnly,
    verifyRecovery: opts.verifyRecovery,
    checkBalance: opts.checkBalance,
    verifyFinality: opts.verifyFinality,
    pollIntervalMs: opts.pollIntervalMs,
    maxPolls: opts.maxPolls,
    onEvent: (event) => {
      if (!opts.quiet) console.error(JSON.stringify(event));
    },
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    error: error?.code ?? 'AGENT_CLIENT_ERROR',
    message: error?.message ?? String(error),
    ...(error?.httpStatus ? { httpStatus: error.httpStatus } : {}),
    ...(error?.serverBody ? { serverBody: error.serverBody } : {}),
  }, null, 2));
  process.exitCode = 1;
});
