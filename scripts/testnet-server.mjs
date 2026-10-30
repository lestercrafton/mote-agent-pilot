import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseJson } from '../src/json.mjs';
import { createTestnetChain, validateTestnetChainConfig } from '../src/testnet-chain.mjs';
import { createPilotQuoteSigner } from '../src/testnet-signer.mjs';
import { createTestnetService } from '../src/testnet-service.mjs';
import { startTestnetHttp, testnetOrigin } from '../src/testnet-http.mjs';
import { getTestnetNetwork } from '../src/testnet-networks.mjs';

export function pilotEnvironment(env) {
  const chainId = { 'base-sepolia-public-synthetic-test': 84532, 'ethereum-sepolia-public-synthetic-test': 11155111 }[env.MOTE_MODE];
  if (!chainId) throw new Error('Explicit registered testnet pilot mode is required.');
  const network = getTestnetNetwork(chainId);
  const quoteKeyName = chainId === 11155111 ? 'MOTE_ETHEREUM_SEPOLIA_QUOTE_PRIVATE_KEY' : 'MOTE_BASE_SEPOLIA_QUOTE_PRIVATE_KEY';
  if (Object.entries(env).some(([key,value]) => value && key !== quoteKeyName && /PRIVATE_?KEY|MNEMONIC|SEED_PHRASE|DEPLOYER_KEY|WALLET_KEY/i.test(key))) throw new Error('Transaction wallet authority is forbidden in the web process.');
  if (!env.MOTE_CHAIN_CONFIG || !/^0x[0-9a-fA-F]{64}$/.test(env.MOTE_CONFIG_HASH ?? '')) throw new Error('A verified config file and separately pinned config hash are required.');
  if (!/^0x[0-9a-fA-F]{64}$/.test(env[quoteKeyName] ?? '')) throw new Error('An already-provisioned offline quote key is required; this command cannot create one.');
  const origin = testnetOrigin(env.MOTE_PUBLIC_ORIGIN ?? env.RENDER_EXTERNAL_URL ?? '');
  const database = resolve(env.MOTE_DATABASE ?? '/var/data/orders.sqlite');
  if (env.RENDER === 'true' && dirname(database) !== '/var/data') throw new Error('Render order state must be on the configured persistent disk.');
  const port = Number(env.PORT ?? '10000');
  if (!/^\d+$/.test(env.PORT ?? '10000') || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port.');
  if (env.MOTE_RECOVERY_ONLY !== undefined && !['true','false'].includes(env.MOTE_RECOVERY_ONLY)) throw new Error('Recovery mode must be explicit boolean text.');
  return { origin, database, port, chainId, networkSlug: network.slug, quoteKeyName, configPath: resolve(env.MOTE_CHAIN_CONFIG), configHash: env.MOTE_CONFIG_HASH, recoveryOnly: env.MOTE_RECOVERY_ONLY === 'true' };
}
export async function startPilotFromEnvironment(env) {
  const settings = pilotEnvironment(env);
  const info = await stat(settings.configPath);
  if (!info.isFile() || info.size > 131072) throw new Error('Invalid public configuration file.');
  const config = validateTestnetChainConfig(parseJson(await readFile(settings.configPath,'utf8')), settings.configHash);
  if (config.mode !== settings.networkSlug || config.chainId !== settings.chainId || config.origin !== settings.origin) throw new Error('The deployed web entrypoint cannot use fixture mode or another origin.');
  if (['deployer','initialHolder','merchant'].some(role => config.roles[role] === config.roles.quoteSigner)) throw new Error('The web quote key must be separate from deployment, holder and merchant authority.');
  const adapter = await createTestnetChain({ config, expectedConfigHash: settings.configHash });
  const quoteSigner = createPilotQuoteSigner(env[settings.quoteKeyName], adapter.identity);
  const service = await createTestnetService({ adapter, quoteSigner, origin: settings.origin, database: settings.database, recoveryOnly: settings.recoveryOnly });
  let transport;
  try { transport = await startTestnetHttp({ service, origin: settings.origin, port: settings.port }); }
  catch (error) { service.close(); throw error; }
  let closed = false;
  return { service, transport, async close() { if (closed) return; closed = true; try { await transport.close(); } finally { service.close(); } } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  try {
    const app = await startPilotFromEnvironment(process.env);
    process.stdout.write(JSON.stringify({ status: 'listening', mode: process.env.MOTE_MODE, testOnly: true, broadcastsTransactions: false }) + '\n');
    for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => app.close().catch(() => { process.exitCode=1; }));
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: { code: /^[A-Z][A-Z0-9_]{2,80}$/.test(error.code ?? '') ? error.code : 'PILOT_STARTUP_FAILED', message: 'Startup failed closed. Check public configuration, pinned deployment, initialized durable state and approved quote-signer provisioning. Secret values are never logged.' } }) + '\n');
    process.exitCode=1;
  }
}
