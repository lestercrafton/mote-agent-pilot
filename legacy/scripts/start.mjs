import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalChain } from '../src/chain.mjs';
import { createService } from '../src/service.mjs';
import { startHttp } from '../src/http.mjs';

const chain = await createLocalChain();
const directory = await mkdtemp(join(tmpdir(), 'mote-local-'));
const database = join(directory, 'orders.sqlite');
const service = await createService({ chain, database });
const http = await startHttp({ service, port: Number(process.env.PORT ?? 8787) });
process.stdout.write(`${JSON.stringify({ status: 'ready', url: http.baseUrl, mode: 'local-evm-fixture', fixturePayer: await chain.payer.getAddress(), database, note: 'Fresh in-memory EVM; public fixture balances have no value. npm run demo proves automatic policy-governed payment. No public RPC or real credentials.' }, null, 2)}\n`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await http.close(); service.close(); await chain.close();
}
process.once('SIGINT', () => close().catch(console.error));
process.once('SIGTERM', () => close().catch(console.error));
