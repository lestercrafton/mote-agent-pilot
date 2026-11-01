import test from 'node:test';
import A from 'node:assert/strict';
import {productionDraft} from '../src/production-draft.mjs';
import {productionLimits,validateProductionSettings,PRODUCTION_ACTIVATION} from '../src/production-policy.mjs';
import {hashJson} from '../src/core/json.mjs';
import {Journal} from '../src/journal.mjs';
import {fixture,input} from './fixtures.mjs';
const budget={authorizedMicrousd:'1000000',reservePerAttemptMicrousd:'1000'};
const MiB=1024*1024;
test('production state allowance accepts only 8 through 16 whole MiB and remains settings-bound',()=>{
 const args={payTo:'0x'+'4'.padStart(40,'0'),receiptSigner:'0x'+'5'.padStart(40,'0'),notBefore:1000,providerBudget:budget};
 for(const n of [8,12,16]) {const d=productionDraft({...args,storageBudgetBytes:n*MiB});A.equal(d.settings.limits.storageBudgetBytes,n*MiB);A.equal(d.enabled,false);const env={MOTE_USDC_ENABLED:'true',MOTE_USDC_ACTIVATION:PRODUCTION_ACTIVATION,MOTE_USDC_SETTINGS_HASH:d.settingsHash,MOTE_PUBLIC_ORIGIN:d.settings.config.origin};validateProductionSettings(env,d.settings);d.settings.limits.storageBudgetBytes=(n===16?8:16)*MiB;A.throws(()=>validateProductionSettings(env,d.settings),/SETTINGS_BINDING/);}
 for(const v of [0,7*MiB,17*MiB,8*MiB+1,8.5*MiB,'33554432',null,Infinity])A.throws(()=>productionLimits(budget,v),/STATE_ALLOWANCE/);
});
test('state allowance cannot be enlarged on restart to reset existing journal identity',async()=>{
 const limits=productionLimits(budget,8*MiB),f=fixture({limits});try {const p=await f.payment(),r=await f.service.execute(input,p);A.throws(()=>new Journal(f.journal.path,f.c.identity,{...limits,storageBudgetBytes:16*MiB}),/JOURNAL_IDENTITY/);A.deepEqual(await f.service.execute(input,p),r);A.equal(f.journal.attempts(),1);}finally{f.close();}
});
