import { config, assert, address } from './protocol.mjs';
import {validateProviderBudget} from './provider-budget.mjs';
import { hashJson } from './core/json.mjs';

export const PRODUCTION_ACTIVATION='base-usdc-receive-beta-v1';
export const PRODUCTION_ROOT='/var/data/mote-usdc/production';
export const PROPOSED_LIMITS=Object.freeze({maxPending:8,perPayer:2,maxRecords:null,maxAttempts:null,budgetEpoch:'base-usdc-continuous-1',clientBudget:'1000000',verifyPerMinute:30,maxVerifications:16,storageBudgetBytes:8*1024*1024});
export const STATE_ALLOWANCE = Object.freeze({minBytes:8*1024*1024,maxBytes:16*1024*1024,stepBytes:1024*1024});
export function productionLimits(providerBudget,storageBudgetBytes=PROPOSED_LIMITS.storageBudgetBytes) {
  assert(Number.isSafeInteger(storageBudgetBytes)&&storageBudgetBytes>=STATE_ALLOWANCE.minBytes&&storageBudgetBytes<=STATE_ALLOWANCE.maxBytes&&storageBudgetBytes%STATE_ALLOWANCE.stepBytes===0,'PRODUCTION_STATE_ALLOWANCE');
  validateProviderBudget(providerBudget);
  return {...PROPOSED_LIMITS,storageBudgetBytes,providerBudget:structuredClone(providerBudget)};
}
const exact=(v,keys)=>assert(v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===keys.sort().join(','),'PRODUCTION_FIELDS');
export function validateProductionSettings(env,settings) {
  assert(env.MOTE_USDC_ENABLED==='true'&&env.MOTE_USDC_ACTIVATION===PRODUCTION_ACTIVATION,'PRODUCTION_DISABLED');
  exact(settings,['config','limits','rpcUrl','offhost','operation','backup']);
  assert(hashJson(settings)===env.MOTE_USDC_SETTINGS_HASH,'PRODUCTION_SETTINGS_BINDING');
  const c=config(settings.config),op=settings.operation;
  assert(hashJson(c)===hashJson(settings.config),'PRODUCTION_CONFIG_CANONICAL');
  assert(c.network==='eip155:8453'&&c.path==='/v1/usdc/audit'&&c.origin===env.MOTE_PUBLIC_ORIGIN&&c.origin==='https://mote-testnet-pilot.onrender.com','PRODUCTION_ROUTE');
  assert(c.amount==='10000','PRODUCTION_PRICE');
  assert(c.payTo!==c.offerSigner&&c.offerSigner!==address('0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf')&&c.offerSigner!==address('0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF'),'PRODUCTION_SIGNER');
  exact(op,['notBefore','providerBudget','purpose']);
  assert(Number.isSafeInteger(op.notBefore)&&op.notBefore>0,'PRODUCTION_WINDOW');
  validateProviderBudget(op.providerBudget);
  assert(BigInt(op.providerBudget.reservePerAttemptMicrousd)>=1000n,'PRODUCTION_PROVIDER_RESERVE'); // Published nonfree rate before tax; a sufficient tax/price reserve still needs operator approval.
  assert(op.purpose==='continuous-receive-beta','PRODUCTION_PROVIDER_TERMS');
  assert(c.policyEpoch==='base-usdc-beta:'+hashJson(op),'PRODUCTION_POLICY_IDENTITY');
  assert(hashJson(settings.limits)===hashJson(productionLimits(op.providerBudget,settings.limits?.storageBudgetBytes)),'PRODUCTION_LIMITS');
  assert(settings.rpcUrl==='https://mainnet.base.org','PRODUCTION_RPC');
  assert(hashJson(settings.offhost)===hashJson({enabled:false,destination:null}),'OFFHOST_DISABLED');
  assert(hashJson(settings.backup)===hashJson({intervalSeconds:3600,maxAgeSeconds:7200,maxSnapshots:3,maxTotalBytes:256*1024*1024,retainSnapshots:2}),'PRODUCTION_BACKUP');
  return c;
}
// Clock is an OS trust boundary. Continuous production has no notAfter; older
// bounded fixture/test configurations still enforce an explicit deadline.
// Existing orders can recover after expiry; only new authority is stopped.
export function admissionWindow(operation,now=()=>Math.floor(Date.now()/1000)) {
  let last=0;
  return ()=>{const t=now();assert(Number.isSafeInteger(t)&&t>=last,'CLOCK_ROLLBACK');last=t;assert(t>=operation.notBefore&&(operation.notAfter===undefined||t<operation.notAfter),'PRODUCTION_WINDOW_CLOSED');};
}
