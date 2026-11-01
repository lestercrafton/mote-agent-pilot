import {readFileSync,lstatSync,mkdirSync,writeFileSync,openSync,closeSync,fsyncSync,readdirSync} from 'node:fs';
import {Journal} from '../src/journal.mjs';
import {validateProductionSettings,PRODUCTION_ROOT,PRODUCTION_ACTIVATION} from '../src/production-policy.mjs';
import {readTransition} from '../src/release-binding.mjs';
import {readReceiptSigner} from '../src/receipt-storage.mjs';
import {privateFile} from '../src/startup.mjs';
process.umask(0o077);
try{
 if(process.env.MOTE_USDC_INITIALIZE!=='approved-new-empty-production-journal-v1'||process.env.MOTE_USDC_ENABLED!=='false')throw Error('GATE');
 readTransition(process.env);
 const settings=JSON.parse(privateFile(PRODUCTION_ROOT+'/config.json',65536));
 const c=validateProductionSettings({...process.env,MOTE_USDC_ENABLED:'true',MOTE_USDC_ACTIVATION:PRODUCTION_ACTIVATION},settings);
 readReceiptSigner({env:process.env,expectedAddress:c.offerSigner});
 // Never reset limits or replace an interrupted/previous database. SQLite create
 // uses O_EXCL; any surviving file requires review, not another initialization.
 if(readdirSync(PRODUCTION_ROOT).some(n=>n.startsWith('orders.sqlite')))throw Error('EXISTING_JOURNAL');
 const j=new Journal(PRODUCTION_ROOT+'/orders.sqlite',c.identity,{...settings.limits,create:true});j.close();
 const expected={identity:c.identity,config:c,limits:settings.limits};
 writeFileSync(PRODUCTION_ROOT+'/expected.json',JSON.stringify(expected)+'\n',{flag:'wx',mode:0o600});
 const fd=openSync(PRODUCTION_ROOT+'/expected.json','r');try{fsyncSync(fd);}finally{closeSync(fd);}
 process.stdout.write(JSON.stringify({initialized:true,configHash:c.identity,enabled:false})+'\n');
}catch{process.stderr.write('{"error":"PRODUCTION_INITIALIZATION_STOPPED_RECONCILE_BEFORE_RETRY"}\n');process.exitCode=1;}
