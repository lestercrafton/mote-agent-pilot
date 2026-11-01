import {readFileSync} from 'node:fs';
import {Journal} from '../src/journal.mjs';
import {Service} from '../src/service.mjs';
import {FinalizedProof} from '../src/chain-proof.mjs';
import {PUBLIC_FIXTURE_OPERATOR,input} from './fixtures.mjs';
import {pagedChain} from './pagination-fixture.mjs';
const [root,mode] = process.argv.slice(2), d=JSON.parse(readFileSync(root+'/pagination-fixture.json','utf8'));
const chain=pagedChain(d.c,d.now,{top:10000n,timestamp:n=>d.expiry-701+Number(n)});
chain.transfers=new Map(d.transfers);chain.used=new Set(d.transfers.map(([,v])=>v.payment.payload.authorization.nonce));
if(mode==='pause')chain.pageHook=async logs=>{process.send({checkpoint:'first-log-page'});await new Promise(()=>{});return logs;};
const journal=new Journal(root+'/server.sqlite',d.c.identity);
let verifyCalls=0,settleCalls=0;
const service=new Service({config:d.c,journal,proof:new FinalizedProof(d.c,chain.rpc),receiptSigner:PUBLIC_FIXTURE_OPERATOR,facilitator:{verify(){verifyCalls++;throw Error('NO_VERIFY');},settle(){settleCalls++;throw Error('NO_SETTLE');}},now:()=>d.now+10000});
const keepAlive=setInterval(()=>{},1000);
try{const out=await service.execute(input,d.payment);console.log(JSON.stringify({status:out.status,transaction:out.receipt?.transaction,verifyCalls,settleCalls,attempts:journal.attempts(),pages:chain.pages.map(p=>p.map(String)),response:out}));}
finally{clearInterval(keepAlive);journal.close();}
