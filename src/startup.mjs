import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { Wallet } from 'ethers';
import { config, assert, address } from './protocol.mjs';
import { hashJson } from './core/json.mjs';
import { Journal } from './journal.mjs';
import { CdpTransport, cdpAuth } from './facilitator.mjs';
import { FinalizedProof, rpcReader } from './chain-proof.mjs';
import { Service } from './service.mjs';
import { offhostPlan } from './maintenance.mjs';
import { installCombinedRoutes, USDC_PATH } from './combined.mjs';
import { startFilePilotFromEnvironment } from '../legacy/scripts/testnet-file-server.mjs';
import { startFilePilotFromEnvironment as startTransitionPilot } from './legacy-transition-startup.mjs';
import { readTransition } from './release-binding.mjs';
import { PRODUCTION_ROOT,PRODUCTION_ACTIVATION,validateProductionSettings,admissionWindow } from './production-policy.mjs';
import { BackupSupervisor } from './backup-supervisor.mjs';
import { readReceiptSigner } from './receipt-storage.mjs';
export const USDC_ROOT='/var/data/mote-usdc';
export function privateFile(path,maxBytes) {
  assert(realpathSync(path)===path,'PRIVATE_PATH');
  const s=lstatSync(path);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&0o077)===0&&s.size>0&&s.size<=maxBytes,'PRIVATE_FILE');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const f=fstatSync(fd);assert(s.ino===f.ino&&s.dev===f.dev,'PRIVATE_FILE');return readFileSync(fd);}finally{closeSync(fd);}
}
export function validateStartupSettings(env,settings) {
  assert(env.MOTE_USDC_ENABLED==='true'&&env.MOTE_USDC_ACTIVATION==='base-sepolia-beta-v1','USDC_ACTIVATION');
  assert(hashJson(settings)===env.MOTE_USDC_SETTINGS_HASH,'USDC_SETTINGS_BINDING');
  const c=config(settings.config);
  assert(c.network==='eip155:84532'&&c.path===USDC_PATH&&c.origin===env.MOTE_PUBLIC_ORIGIN,'USDC_TESTNET_ONLY');
  assert(settings.limits&&Object.keys(settings.limits).sort().join(',')==='budgetEpoch,clientBudget,maxAttempts,maxPending,maxRecords,maxVerifications,perPayer,storageBudgetBytes,verifyPerMinute','USDC_LIMIT_FIELDS');
  offhostPlan(settings.offhost);
  assert(settings.rpcUrl==='https://sepolia.base.org','USDC_RPC');
  return c;
}
export async function prepareUsdc(env) {
  if(env.MOTE_USDC_ACTIVATION===PRODUCTION_ACTIVATION)return prepareProduction(env);
  assert(env.MOTE_USDC_ENABLED==='true'&&env.MOTE_USDC_ACTIVATION==='base-sepolia-beta-v1','USDC_ACTIVATION');
  const d=lstatSync(USDC_ROOT);assert(d.isDirectory()&&!d.isSymbolicLink()&&realpathSync(USDC_ROOT)===USDC_ROOT&&d.uid===process.getuid()&&(d.mode&0o077)===0,'USDC_DIRECTORY');
  const settings=JSON.parse(privateFile(USDC_ROOT+'/config.json',65536).toString('utf8'));
  const c=validateStartupSettings(env,settings);
  // Existing keys are supplied through an independently approved path. This function never creates keys.
  const key=privateFile(USDC_ROOT+'/receipt.key',128);let credentialBytes;
  let journal;
  try {
    const hex=key.toString('utf8').trim();assert(/^0x[0-9a-fA-F]{64}$/.test(hex)&&!/^0x0{63}[12]$/.test(hex),'USDC_RECEIPT_KEY');
    const receiptSigner=new Wallet(hex);assert(address(receiptSigner.address)===c.offerSigner,'USDC_RECEIPT_SIGNER');
    credentialBytes=privateFile(USDC_ROOT+'/cdp.json',8192);const credentials=JSON.parse(credentialBytes.toString('utf8'));
    assert(Object.keys(credentials).sort().join(',')==='apiKeyId,apiKeySecret','USDC_CREDENTIAL_FORMAT');
    journal=new Journal(USDC_ROOT+'/orders.sqlite',c.identity,{...settings.limits,create:false,recoveryOnly:env.MOTE_USDC_RECOVERY_ONLY==='true'});
    const facilitator=new CdpTransport({auth:cdpAuth(credentials)}); await facilitator.supported(c);
    const proof=new FinalizedProof(c,rpcReader(settings.rpcUrl));await proof.anchor();
    return new Service({config:c,journal,facilitator,proof,receiptSigner});
  } catch(e){journal?.close();throw e;} finally{key.fill(0);credentialBytes?.fill(0);}
}
export function defaultLegacyFactory(env){return env.MOTE_RELEASE_TRANSITION_HASH?startTransitionPilot(env):startFilePilotFromEnvironment(env);}
export function installProductionControls(service,{operation,backups,now}) {
  const gate=admissionWindow(operation,now),j=service.j,original=j.assertNewAuthority.bind(j),ready=j.readiness.bind(j);
  j.assertNewAuthority=()=>{original();gate();backups.assertReady();};
  const offer=service.offer.bind(service);service.offer=async input=>{assert(j.attempts()<j.limits.maxAttempts,'FACILITATOR_BUDGET');return offer(input);};
  j.readiness=()=>{const state=ready();let windowOpen=false;try{gate();windowOpen=true;}catch{}return {...state,newAdmissionAllowed:state.newAdmissionAllowed&&windowOpen&&backups.status().available&&j.attempts()<j.limits.maxAttempts,windowOpen,backup:backups.status(),settlementAttempts:j.attempts(),settlementAttemptCap:j.limits.maxAttempts};};
  service.shutdown=()=>backups.stop();
  service.disclosure={mode:'bounded-mainnet-beta',priceUSDC:'0.01',newPaymentsUntil:operation.notAfter,settlementAttemptCap:j.limits.maxAttempts,operator:'Lester Crafton',jurisdiction:'Tennessee, USA',refunds:'No automatic refunds; operator review required. Do not sign a replacement payment on timeout.',privacy:'Public synthetic inputs only. Results, public payer address and signed authorizations are retained on the private service disk and local backups. No off-host backup or input logging is enabled.',wallets:'EOA EIP-3009 payer and Mote request-binding helper required. Smart-wallet payers are not supported.'};
  return service;
}
export async function prepareProduction(env) {
  assert(env.MOTE_USDC_ENABLED==='true'&&env.MOTE_USDC_ACTIVATION===PRODUCTION_ACTIVATION,'PRODUCTION_DISABLED');
  readTransition(env); // actual source/commit authorized before reading any secret
  const d=lstatSync(PRODUCTION_ROOT);assert(d.isDirectory()&&!d.isSymbolicLink()&&realpathSync(PRODUCTION_ROOT)===PRODUCTION_ROOT&&d.uid===process.getuid()&&(d.mode&0o077)===0,'USDC_DIRECTORY');
  const settings=JSON.parse(privateFile(PRODUCTION_ROOT+'/config.json',65536));
  const c=validateProductionSettings(env,settings);
  let credentialBytes,journal,backups;
  try {
    const receiptSigner=readReceiptSigner({env,expectedAddress:c.offerSigner});
    credentialBytes=privateFile(USDC_ROOT+'/cdp.json',8192);const credentials=JSON.parse(credentialBytes);
    assert(Object.keys(credentials).sort().join(',')==='apiKeyId,apiKeySecret'&&hashJson({apiKeyId:credentials.apiKeyId})===env.MOTE_CDP_KEY_ID_HASH,'USDC_CREDENTIAL_IDENTITY');
    journal=new Journal(PRODUCTION_ROOT+'/orders.sqlite',c.identity,{...settings.limits,create:false,recoveryOnly:env.MOTE_USDC_RECOVERY_ONLY==='true'});
    const facilitator=new CdpTransport({auth:cdpAuth(credentials)});await facilitator.supported(c);
    const proof=new FinalizedProof(c,rpcReader(settings.rpcUrl));await proof.anchor();
    const service=new Service({config:c,journal,facilitator,proof,receiptSigner,maxActive:4,requestsPerMinute:60});
    backups=new BackupSupervisor({source:journal.path,directory:PRODUCTION_ROOT+'/backups',expected:{identity:c.identity,config:c,limits:journal.limits},policy:settings.backup});
    // Failure leaves recovery serving but blocks every new reservation/settle.
    try{await backups.start();}catch{}
    return installProductionControls(service,{operation:settings.operation,backups});
  }catch(e){backups?.stop();journal?.close();throw e;}finally{credentialBytes?.fill(0);}
}
export async function startCombinedFromEnvironment(env, { legacyFactory=defaultLegacyFactory, usdcFactory=prepareUsdc }={}) {
  assert(['false','true',undefined].includes(env.MOTE_USDC_ENABLED),'USDC_ENABLE_FLAG');
  // Pass the actual deployment environment unchanged: never spoof the source commit to bypass legacy custody.
  const legacy=await legacyFactory(env);
  let usdc=null;
  try {if(env.MOTE_USDC_ENABLED==='true')usdc=await usdcFactory(env);return {...installCombinedRoutes({legacy,usdc}),legacy,usdc};}
  catch(e){usdc?.shutdown?.();usdc?.j.close();await legacy.close();throw e;}
}
