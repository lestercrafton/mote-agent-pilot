import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseJson } from '../src/json.mjs';
import { createTestnetChain, createTestnetChainConfig, validateTestnetChainConfig } from '../src/testnet-chain.mjs';
import { initializeTestnetStore, inspectTestnetStoreSnapshot, decodeTestnetStoreRow } from '../src/testnet-store.mjs';
import { createBaseSepoliaReader, createEthereumSepoliaReader } from '../src/testnet-rpc.mjs';
import { getTestnetNetwork } from '../src/testnet-networks.mjs';

const help = `Mote public-synthetic testnet administration. No key generation or transaction submission.
  prepare-config --plan PLAN.json --receipts HASHES.json --origin HTTPS_ORIGIN --out NEW_CONFIG.json
  verify-config --config CONFIG.json --hash PINNED_CONFIG_HASH
  identity --config CONFIG.json --hash PINNED_CONFIG_HASH --out NEW_IDENTITY.json
  init-store --config CONFIG.json --hash PINNED_CONFIG_HASH --database NEW_DATABASE.sqlite
  inspect-store --config CONFIG.json --hash PINNED_CONFIG_HASH --database EXISTING_DATABASE.sqlite
  reconcile-store --config CONFIG.json --hash PINNED_CONFIG_HASH --database EXISTING_DATABASE.sqlite [--after QUOTE_ID] [--limit 1..20]

prepare-config independently re-verifies deployment with the pinned network read-only RPC and compiler.
Other network commands use the pinned registered-network read-only adapter. inspect-store is offline.
init-store explicitly creates both new order and process-lock databases; startup never initializes.
reconcile-store only reports known proofs. It never signs, sends, clears quarantine or writes state.
Restored copies stay recovery-only; no command silently activates old payment authority.
`;
function options(argv) {
  const [command = 'help', ...tail] = argv;
  const fields = { help: [], 'prepare-config': ['plan','receipts','origin','out'], 'verify-config': ['config','hash'], identity: ['config','hash','out'], 'init-store': ['config','hash','database'], 'inspect-store': ['config','hash','database'], 'reconcile-store': ['config','hash','database','after','limit'] };
  if (!Object.hasOwn(fields, command)) throw new Error('Unsupported command; signing and broadcasts are not implemented.');
  const values = {};
  for (let i=0;i<tail.length;i+=2) {
    const key=tail[i]?.slice(2);
    if (!tail[i]?.startsWith('--') || !fields[command].includes(key) || Object.hasOwn(values,key) || !tail[i+1] || tail[i+1].startsWith('--')) throw new Error('Unknown, repeated or missing option.');
    values[key]=tail[i+1];
  }
  for (const key of fields[command].filter(x=>!['after','limit'].includes(x))) if (!values[key]) throw new Error('Required public configuration option is missing.');
  return { command, values };
}
async function jsonFile(filename) {
  const info=await stat(filename);
  if (!info.isFile() || info.size>131072) throw new Error('Expected a bounded public JSON file.');
  return parseJson(await readFile(filename,'utf8'));
}
async function save(filename,value) { await writeFile(filename,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600}); }
const display = value => process.stdout.write(JSON.stringify(value,null,2)+'\n');

export async function runPilotAdmin(argv) {
  const { command,values }=options(argv);
  if (command==='help') { process.stdout.write(help); return; }
  if (command==='prepare-config') {
    // Compiler/dev dependencies are loaded solely by this explicit offline/read
    // preparation command, never by the hosted server or ordinary recovery.
    const { validateTestnetPlan,verifyTestnetDeployment }=await import('../src/testnet-plan.mjs');
    const { createVerificationBundle }=await import('../src/verification-bundle.mjs');
    const plan=validateTestnetPlan(await jsonFile(values.plan));
    const network=getTestnetNetwork(plan.chainId);
    const provider=plan.chainId===11155111?createEthereumSepoliaReader():createBaseSepoliaReader();
    const evidence=await verifyTestnetDeployment({plan,provider,transactionHashes:await jsonFile(values.receipts)});
    const config=createTestnetChainConfig({plan,evidence,verificationBundle:createVerificationBundle(),origin:values.origin,genesisHash:network.genesisHash??null,mode:network.slug});
    await save(values.out,config);
    display({status:'verified-config-prepared',configHash:config.configHash,publicNetworkIndependentlyAuthenticated:false,signingAuthorized:false,broadcastPerformed:false}); return;
  }
  const config=validateTestnetChainConfig(await jsonFile(values.config),values.hash);
  if (config.mode!==getTestnetNetwork(config.chainId).slug) throw new Error('Public admin CLI refuses fixture configuration.');
  const identity={origin:config.origin,chainId:config.chainId,genesisHash:config.genesisHash,token:config.deployments.token.address,router:config.deployments.payments.address,recipient:config.roles.merchant,quoteSigner:config.roles.quoteSigner,checkpoint:config.checkpoint,configHash:config.configHash};
  let adapter;
  if (command!=='inspect-store') adapter=await createTestnetChain({config,expectedConfigHash:values.hash});
  if (command==='verify-config') { display({status:'deployment-evidence-verified',identity:adapter.identity,signingAuthorized:false,broadcastPerformed:false}); return; }
  if (command==='identity') { await save(values.out,adapter.identity); display({status:'public-identity-written',configHash:config.configHash}); return; }
  if (command==='init-store') { display({...initializeTestnetStore({path:values.database,identity:adapter.identity}),signingAuthorized:false,broadcastPerformed:false}); return; }
  const filename=resolve(values.database); const info=await stat(filename);
  if (!info.isFile() || info.size>512*1024*1024) throw new Error('Expected existing bounded order database.');
  const db=new DatabaseSync(filename,{readOnly:true,allowExtension:false,defensive:true});
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN;');
    const inspected=inspectTestnetStoreSnapshot(db,identity);
    if (command==='inspect-store') { display({...inspected,mode:inspected.recoveryRequired?'recovery-only':'normal',writesPerformed:false,activationAuthorized:false}); return; }
    const limit=Number(values.limit??'5');
    if (!Number.isInteger(limit)||limit<1||limit>20||values.after&&!/^0x[0-9a-fA-F]{64}$/.test(values.after)) throw new Error('Invalid bounded reconciliation page.');
    const rows=db.prepare('SELECT * FROM quotes WHERE id > ? ORDER BY id LIMIT ?').all(values.after??'',limit+1);
    const results=[];
    for (const raw of rows.slice(0,limit)) {
      const row=decodeTestnetStoreRow(raw);
      if (!row.offer) { results.push({quoteId:row.id,status:'unsigned-draft',action:'preserve'}); continue; }
      const candidates=row.transactionHash?[{transaction_hash:row.transactionHash}]:db.prepare('SELECT DISTINCT transaction_hash FROM attempts WHERE quote_id=? ORDER BY transaction_hash LIMIT 6').all(row.id);
      if (!candidates.length) results.push({quoteId:row.id,status:'no-known-proof',action:'retain-original-offer-and-input'});
      for (const candidate of candidates.slice(0,5)) {
        try { const proof=await adapter.verifyPayment({offer:row.offer,transactionHash:candidate.transaction_hash,...(row.response?{finalizedAnchor:row.response.receipt.finalized}:{})}); results.push({quoteId:row.id,transactionHash:candidate.transaction_hash,status:'finalized-valid',blockNumber:proof.blockNumber}); }
        catch(error) { results.push({quoteId:row.id,transactionHash:candidate.transaction_hash,status:'unresolved',code:/^[A-Z][A-Z0-9_]{2,80}$/.test(error.code??'')?error.code:'EVIDENCE_UNAVAILABLE',action:'retain-and-reconcile-never-repay'}); }
      }
      if(candidates.length>5) results.push({quoteId:row.id,status:'additional-candidates-not-checked'});
    }
    display({status:'read-only-reconciliation-page',recoveryRequired:inspected.recoveryRequired,results,hasMore:rows.length>limit,nextAfter:rows.slice(0,limit).at(-1)?.id??null,writesPerformed:false,signerCalls:0,activationAuthorized:false,missingRowsCannotBeEnumeratedFromSnapshot:true});
  } finally { try { db.exec('ROLLBACK;'); } finally { db.close(); } }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.umask(0o077);
  runPilotAdmin(process.argv.slice(2)).catch(error=>{process.stderr.write(JSON.stringify({error:{code:/^[A-Z][A-Z0-9_]{2,80}$/.test(error.code??'')?error.code:'PILOT_ADMIN_FAILED',message:'Operation failed closed. Check public configuration, existing state, finality and destination paths. No signing or submission occurred.'}})+'\n');process.exitCode=1;});
}
