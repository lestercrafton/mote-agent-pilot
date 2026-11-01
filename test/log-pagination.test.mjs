import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {fork,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {FinalizedProof,rpcReader} from '../src/chain-proof.mjs';
import {lookupRpc,LOOKUP_LIMITS} from '../src/log-recovery.mjs';
import {Service} from '../src/service.mjs';
import {fixture,input,H,PUBLIC_FIXTURE_OPERATOR} from './fixtures.mjs';
import {pagedChain} from './pagination-fixture.mjs';

for(const at of [0n,199n,200n,399n,400n,1000n])test(`inclusive pages find authorization at block ${at}`,async()=>{
 const f=fixture();try{const p=await f.payment(),chain=pagedChain(f.c,f.chain.now),tx=await chain.place(p,at),proof=new FinalizedProof(f.c,chain.rpc);
 assert.equal((await proof.locate(p)).transaction,tx);assert.deepEqual(chain.pages,[[0n,199n],[200n,399n],[400n,599n],[600n,799n],[800n,999n],[1000n,1000n]]);
 assert.ok(chain.reads.length<=LOOKUP_LIMITS.rpcCalls);
 }finally{f.close();}
});
test('expiry anchors historical lookup after a long restart; 4096-block tail stays bounded',async()=>{
 const f=fixture();try{const p=await f.payment(),expiry=Number(p.payload.authorization.validBefore),chain=pagedChain(f.c,f.chain.now,{top:100000n,timestamp:n=>expiry-5001+Number(n)}),tx=await chain.place(p,4990n);
 assert.equal((await new FinalizedProof(f.c,chain.rpc).locate(p)).transaction,tx);assert.equal(chain.pages.length,21);assert.deepEqual(chain.pages[0],[905n,1104n]);assert.deepEqual(chain.pages.at(-1),[4905n,5000n]);assert.ok(chain.reads.length<=128);
 }finally{f.close();}
});
test('identical duplicate log is deduplicated only within its valid page',async()=>{
 const f=fixture();try{const p=await f.payment(),chain=pagedChain(f.c,f.chain.now),tx=await chain.place(p,200n);chain.pageHook=logs=>logs.length?[...logs,structuredClone(logs[0])]:logs;
 assert.equal((await new FinalizedProof(f.c,chain.rpc).locate(p)).transaction,tx);
 }finally{f.close();}
});
for(const kind of ['removed','wrong asset','wrong nonce','bad data','bad hash','outside page','conflicting duplicate','second event','oversize','not array'])test(`reject ${kind} log evidence`,async()=>{
 const f=fixture();try{const p=await f.payment(),chain=pagedChain(f.c,f.chain.now);await chain.place(p,200n);
 chain.pageHook=logs=>{if(!logs.length)return logs;const l=logs[0];
 if(kind==='removed')l.removed=true;if(kind==='wrong asset')l.address=PUBLIC_FIXTURE_OPERATOR.address;if(kind==='wrong nonce')l.topics[2]=H(999);
 if(kind==='bad data')l.data='0x00';if(kind==='bad hash')l.transactionHash='0x1';if(kind==='outside page')l.blockNumber='0xc7';
 if(kind==='conflicting duplicate')return[l,{...l,blockHash:H(999)}];if(kind==='second event')return[l,{...l,transactionHash:H(999)}];
 if(kind==='oversize')return Array(5).fill(l);if(kind==='not array')return{logs};return logs;};
 await assert.rejects(new FinalizedProof(f.c,chain.rpc).locate(p));
 }finally{f.close();}
});
test('later-page contradiction prevents early acceptance of an otherwise valid first candidate',async()=>{
 const f=fixture();try{const p=await f.payment(),chain=pagedChain(f.c,f.chain.now);await chain.place(p,200n);const log=structuredClone([...chain.transfers.values()][0].receipt.logs[0]);
 chain.pageHook=(logs,filter)=>BigInt(filter.fromBlock)===400n?[{...log,blockNumber:'0x190',blockHash:H(400),transactionHash:H(900)}]:logs;
 await assert.rejects(new FinalizedProof(f.c,chain.rpc).locate(p),/LOOKUP_CONTRADICTION/);
 }finally{f.close();}
});
for(const kind of ['omitted logs','partial then error','malformed partial page'])test(`${kind} cannot deliver, release used reservation, or settle again`,async()=>{
 const f=fixture();try{const p=await f.payment(),chain=pagedChain(f.c,f.chain.now),proof=new FinalizedProof(f.c,chain.rpc);let verify=0,settle=0;
 chain.pageHook=(logs,filter)=>{if(kind==='omitted logs')return[];if(BigInt(filter.fromBlock)===400n){if(kind==='partial then error')throw Error('RPC_FAIL');return null;}return logs;};
 const service=new Service({config:f.c,journal:f.journal,proof,receiptSigner:PUBLIC_FIXTURE_OPERATOR,facilitator:{async verify(){verify++;return{isValid:true,payer:p.payload.authorization.from};},async settle(){settle++;await chain.place(p,200n);throw Error('RESPONSE_LOST');}},now:()=>chain.now});
 assert.equal((await service.execute(input,p)).status,'pending');chain.now+=1000;
 if(kind==='omitted logs'){assert.equal((await service.execute(input,p)).status,'pending');}else await assert.rejects(service.execute(input,p));
 assert.equal(verify,1);assert.equal(settle,1);assert.equal(f.journal.attempts(),1);assert.equal(f.journal.get(p.payload.authorization.from.toLowerCase(),'fixture-payment-0001').status,'unknown');
 }finally{f.close();}
});
for(const kind of ['finalized reorg','end-block reorg','candidate contradicts receipt'])test(`${kind} fails closed`,async()=>{
 const f=fixture();try{const p=await f.payment(),expiry=Number(p.payload.authorization.validBefore),chain=pagedChain(f.c,f.chain.now,{top:10000n,timestamp:n=>expiry-701+Number(n)});await chain.place(p,600n);
 if(kind==='candidate contradicts receipt')chain.pageHook=logs=>logs.map(l=>({...l,blockHash:H(999)}));
 else chain.blockHook=(b,tag)=>chain.pages.length && tag!=='finalized' && BigInt(b.number)===(kind==='finalized reorg'?10000n:700n)?{...b,hash:H(999)}:b;
 await assert.rejects(new FinalizedProof(f.c,chain.rpc).locate(p),/CHANGED|CONTRADICTION/);
 }finally{f.close();}
});
test('used authorization outside the bounded historical tail is not silently declared unpaid',async()=>{
 const f=fixture();try{const p=await f.payment(),expiry=Number(p.payload.authorization.validBefore),chain=pagedChain(f.c,f.chain.now,{top:10000n,timestamp:n=>expiry-5001+Number(n)});await chain.place(p,200n);
 const proof=new FinalizedProof(f.c,chain.rpc);assert.equal(await proof.locate(p),null);assert.equal(await proof.expiredUnused(p),false);assert.equal(chain.pages[0][0],905n);
 }finally{f.close();}
});
test('strict transaction verifier rejects tampered calldata after a valid discovery hint',async()=>{
 const f=fixture();try{const p=await f.payment(),chain=pagedChain(f.c,f.chain.now);const tx=await chain.place(p,200n);chain.transfers.get(tx).tx.input+='00';
 await assert.rejects(new FinalizedProof(f.c,chain.rpc).locate(p),/TRANSACTION_SIGNATURE/);
 }finally{f.close();}
});
test('caller abort during a page stops immediately without later pages or acceptance',async()=>{
 const f=fixture(),controller=new AbortController();try{const p=await f.payment(),chain=pagedChain(f.c,f.chain.now);await chain.place(p,200n);chain.pageHook=logs=>{controller.abort();return logs;};
 await assert.rejects(new FinalizedProof(f.c,chain.rpc).locate(p,{signal:controller.signal}),/LOOKUP_CANCELLED/);assert.equal(chain.pages.length,1);
 }finally{f.close();}
});
test('deadline stops a hung RPC even if that implementation ignores abort',async()=>{
 const rpc=lookupRpc(()=>new Promise(()=>{}),{timeoutMs:20});try{await assert.rejects(rpc('eth_chainId',[]),/LOOKUP_DEADLINE/);}finally{rpc.close();}
});
test('late synchronous success is rejected even before the timeout callback can run',async()=>{
 const rpc=lookupRpc(()=>{const until=performance.now()+40;while(performance.now()<until){}return'0x1';},{timeoutMs:5});
 try{await assert.rejects(rpc('eth_chainId',[]),/LOOKUP_DEADLINE/);}finally{rpc.close();}
});
test('RPC budget and time extension fail closed; caller parameters are snapshotted',async()=>{
 const params=[{x:1}];let got;const rpc=lookupRpc(async(m,p)=>{got=p;return'0x1';});try{const pending=rpc('eth_chainId',params);params[0].x=2;await pending;assert.equal(got[0].x,1);
 for(let i=1;i<128;i++)await rpc('eth_chainId',[]);await assert.rejects(rpc('eth_chainId',[]),/LOOKUP_RPC_LIMIT/);
 assert.throws(()=>lookupRpc(()=>{}, {timeoutMs:15001}),/LOOKUP_DEADLINE/);
 }finally{rpc.close();}
});
test('HTTP reader propagates cancellation and rejects JSON-RPC partial/error envelopes',async()=>{
 const controller=new AbortController();const alive=setInterval(()=>{},1000);
 try{const reader=rpcReader('https://fixture.invalid',{fetchImpl:async(url,options)=>new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(Error('FETCH_ABORTED')),{once:true});})});
 const request=reader('eth_chainId',[],{signal:controller.signal});controller.abort();await assert.rejects(request,/FETCH_ABORTED/);
 for(const body of [{id:1,error:{code:-32614},result:[]},{id:1},{id:2,result:[]}]){const read=rpcReader('https://fixture.invalid',{fetchImpl:async()=>new Response(JSON.stringify(body))});await assert.rejects(read('eth_getLogs',[{}]),/RPC_UNAVAILABLE/);}
 }finally{clearInterval(alive);}
});
test('SIGKILL during pagination; a new process recovers old payment without a second settlement',async()=>{
 const f=fixture();let child;
 try{const p=await f.payment(),expiry=Number(p.payload.authorization.validBefore),chain=pagedChain(f.c,f.chain.now,{top:10000n,timestamp:n=>expiry-701+Number(n)});
 const service=new Service({config:f.c,journal:f.journal,proof:new FinalizedProof(f.c,chain.rpc),receiptSigner:PUBLIC_FIXTURE_OPERATOR,facilitator:{async verify(){return{isValid:true,payer:p.payload.authorization.from};},async settle(){await chain.place(p,600n);throw Error('RESPONSE_LOST');}},now:()=>f.chain.now});
 assert.equal((await service.execute(input,p)).status,'pending');assert.equal(f.journal.attempts(),1);
 writeFileSync(f.dir+'/pagination-fixture.json',JSON.stringify({c:f.c,now:f.chain.now,expiry,payment:p,transfers:[...chain.transfers]}),{mode:0o600});f.journal.close();
 const worker=fileURLToPath(new URL('./pagination-worker.mjs',import.meta.url));child=fork(worker,[f.dir,'pause'],{stdio:['ignore','ignore','pipe','ipc']});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('WORKER_TIMEOUT')),5000);child.once('message',m=>{clearTimeout(timer);assert.equal(m.checkpoint,'first-log-page');resolve();});child.once('exit',()=>{clearTimeout(timer);reject(Error('EARLY_EXIT'));});});
 const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;
 const {stdout}=await promisify(execFile)(process.execPath,[worker,f.dir,'recover']);const recovered=JSON.parse(stdout);
 assert.equal(recovered.status,'complete');assert.equal(recovered.verifyCalls,0);assert.equal(recovered.settleCalls,0);assert.equal(recovered.attempts,1);assert.equal(recovered.pages.length,4);
 const second=JSON.parse((await promisify(execFile)(process.execPath,[worker,f.dir,'recover'])).stdout);assert.deepEqual(second.response,recovered.response);assert.equal(second.pages.length,0);
 }finally{if(child&&!child.killed)child.kill('SIGKILL');f.close();}
});
