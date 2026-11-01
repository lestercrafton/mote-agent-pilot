// OFFLINE SYNTHETIC STORAGE QUALIFICATION ONLY. Public fixture keys and invented
// transaction hashes model already-completed rows; they are NOT chain evidence.
// No provider, RPC, key generation, production paths or network operations.
import A from 'node:assert/strict';
import {mkdtempSync,realpathSync,lstatSync,readFileSync,writeFileSync,mkdirSync,statSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getBytes} from 'ethers';
import {PUBLIC_FIXTURE_OPERATOR as operator,PUBLIC_FIXTURE_PAYER as payer,input as tiny,H} from '../test/fixtures.mjs';
import {config,makeOffer,BINDING,PROFILE,AUTH_TYPES,authDomain,bindDomain,BIND_TYPES,bindingMessage,validatePayment} from '../src/protocol.mjs';
import {hashJson} from '../src/core/json.mjs';
import {Journal} from '../src/journal.mjs';
import {Service} from '../src/service.mjs';
import {snapshot} from '../src/maintenance.mjs';
import {diskStatus} from '../src/disk.mjs';
import {productionLimits} from '../src/production-policy.mjs';
const [mode,arg,nArg]=process.argv.slice(2),MiB=1024*1024;
let root;
if(mode==='init') {
 A.ok(['tiny','large'].includes(arg));
 root=realpathSync(mkdtempSync(join(tmpdir(),'mote-state-capacity-')));
 const c=config({origin:'http://127.0.0.1:18899',payTo:operator.address,offerSigner:operator.address});
 const now=1800000000,input=arg==='tiny'?tiny:{document:{data:'x'.repeat(60000)},schema:{type:'object'}};
 const limits=productionLimits({authorizedMicrousd:'100000000',reservePerAttemptMicrousd:'1000'},16*MiB);
 const offer=(await makeOffer(c,input,operator,now)).extensions[BINDING].info.offer;
 writeFileSync(join(root,'fixture.json'),JSON.stringify({c,now,input,limits,offer,shape:arg}),{flag:'wx',mode:0o600});
 new Journal(join(root,'orders.sqlite'),c.identity,{create:true,...limits}).close();
 console.log(JSON.stringify({mode,root,shape:arg,allowanceBytes:limits.storageBudgetBytes,synthetic:true}));
} else {
 root=realpathSync(arg);A.ok(root.startsWith(realpathSync(tmpdir())+'/mote-state-capacity-'));
 const st=lstatSync(root);A.ok(st.isDirectory()&&!st.isSymbolicLink()&&st.uid===process.getuid()&&(st.mode&0o077)===0);
 const {c,now,input,limits,offer,shape}=JSON.parse(readFileSync(join(root,'fixture.json'))),path=join(root,'orders.sqlite'),expected={identity:c.identity,config:c,limits};
 const payment=async i=>{
  const id='state-fixture-'+String(i).padStart(8,'0'),a={from:payer.address.toLowerCase(),to:c.payTo,value:c.amount,validAfter:'0',validBefore:String(now+120),nonce:H(i+1)};
  const signature=await payer.signTypedData(authDomain(c),AUTH_TYPES,a),binding=await payer.signTypedData(bindDomain(c),BIND_TYPES,bindingMessage(c,input,offer,id,a));
  return {x402Version:2,payload:{authorization:a,signature},resource:offer.body.resource,accepted:offer.body.requirements,extensions:{'payment-identifier':{info:{required:true,id}},[BINDING]:{info:{required:true,profile:PROFILE,offer,signature:binding}}}};
 };
 if(mode==='fill') {
  const batch=Number(nArg);A.ok(Number.isSafeInteger(batch)&&batch>0&&batch<=250);const j=new Journal(path,c.identity,limits);let full=false,added=0;
  try{for(let k=0;k<batch;k++){const i=j.attempts(),p=await payment(i),v=validatePayment(c,input,p,now);let row;try{row=j.reserve(v,p,now).row;}catch(e){if(e.code!=='STORAGE_BUDGET')throw e;full=true;break;}
   const receipt={profile:c.profile,configHash:c.identity,paymentId:v.id,payer:v.payer,requestFingerprint:v.fingerprint,resultHash:v.resultHash,amount:c.amount,asset:c.asset,payTo:c.payTo,transaction:H(i+100000),blockNumber:'80',blockHash:H(80),network:c.network};
   j.noteHash(row.authKey,receipt.transaction);j.complete(row.authKey,{status:'complete',result:v.result,receipt,signature:await operator.signMessage(getBytes(hashJson(receipt)))});added++;
  }
  const used=j.db.prepare('SELECT coalesce(sum(reservedBytes),0) AS n FROM orders').get().n,orders=j.attempts();
  j.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  console.log(JSON.stringify({mode,shape,added,full,orders,reservedBytes:used,allowanceBytes:limits.storageBudgetBytes,databaseBytes:statSync(path).size,storage:diskStatus(path),synthetic:true}));
  }finally{j.close();}
 } else if(mode==='backup'||mode==='restore') {
  const destination=join(root,mode+'.sqlite'),source=mode==='backup'?path:join(root,'backup.sqlite');
  const start=performance.now();const result=await snapshot({source,destination,expected,restore:mode==='restore'});
  console.log(JSON.stringify({mode,shape,durationMs:performance.now()-start,manifest:result.manifest,storage:diskStatus(path),synthetic:true}));
 } else if(mode==='recover') {
  let calls=0;const forbidden=()=>{calls++;throw Error('NETWORK_OR_SIGNER_FORBIDDEN');};
  const first=new Journal(path,c.identity,limits),count=first.attempts(),used=first.db.prepare('SELECT sum(reservedBytes) AS n FROM orders').get().n;
  const fresh=await payment(count),v=validatePayment(c,input,fresh,now);A.throws(()=>first.reserve(v,fresh,now),/STORAGE_BUDGET/);A.equal(first.attempts(),count);
  const samples=[0,Math.floor(count/2),count-1].map(i=>first.db.prepare('SELECT * FROM orders WHERE paymentId=?').get('state-fixture-'+String(i).padStart(8,'0')));first.close();
  for(let pass=0;pass<2;pass++){const j=new Journal(join(root,'restore.sqlite'),c.identity,{...limits,recoveryOnly:true});try{
   const s=new Service({config:c,journal:j,facilitator:{verify:forbidden,settle:forbidden},proof:{settled:forbidden,locate:forbidden},receiptSigner:{address:c.offerSigner,signMessage:forbidden},now:()=>now+86400});
   for(const row of samples) A.deepEqual(await s.execute(input,JSON.parse(row.payment)),JSON.parse(row.response));
   await A.rejects(s.offer(input),/QUARANTINED/);A.equal(j.attempts(),count);A.equal(j.db.prepare('SELECT sum(reservedBytes) AS n FROM orders').get().n,used);
  }finally{j.close();}}
  A.equal(calls,0);console.log(JSON.stringify({mode,shape,orders:count,identicalRecoveries:6,restarts:2,networkOrSignerCalls:calls,fullAdmissionRejected:true,restoredAdmissionRejected:true,synthetic:true}));
 } else throw Error('MODE');
}
