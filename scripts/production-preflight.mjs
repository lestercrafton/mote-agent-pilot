import {privateFile,USDC_ROOT} from '../src/startup.mjs';
import {PRODUCTION_ROOT} from '../src/production-policy.mjs';
import {readTransition} from '../src/release-binding.mjs';
import {readReceiptSigner} from '../src/receipt-storage.mjs';
import {preflightConfig,checkProductionDependencies} from '../src/production-preflight.mjs';
import {hashJson} from '../src/core/json.mjs';
import {CdpTransport,cdpAuth} from '../src/facilitator.mjs';
import {FinalizedProof,rpcReader} from '../src/chain-proof.mjs';
process.umask(0o077);
let bytes;
try{
 if(process.env.MOTE_USDC_PREFLIGHT!=='approved-source-bound-read-only-v1'||process.env.MOTE_USDC_ENABLED!=='false')throw Error('GATE');
 readTransition(process.env);
 const c=preflightConfig(JSON.parse(privateFile(PRODUCTION_ROOT+'/config.draft.json',8192)));
 const receiptSigner=readReceiptSigner({env:process.env,expectedAddress:c.offerSigner});
 bytes=privateFile(USDC_ROOT+'/cdp.json',8192);const credentials=JSON.parse(bytes);
 if(Object.keys(credentials).sort().join(',')!=='apiKeyId,apiKeySecret'||hashJson({apiKeyId:credentials.apiKeyId})!==process.env.MOTE_CDP_KEY_ID_HASH)throw Error('IDENTITY');
 const result=await checkProductionDependencies({c,receiptSigner,facilitator:new CdpTransport({auth:cdpAuth(credentials)}),proof:new FinalizedProof(c,rpcReader('https://mainnet.base.org'))});
 process.stdout.write(JSON.stringify(result)+'\n');
}catch{process.stderr.write('{"error":"PRODUCTION_PREFLIGHT_FAILED"}\n');process.exitCode=1;}
finally{bytes?.fill(0);}
