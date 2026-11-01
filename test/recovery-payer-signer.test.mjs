import test,{beforeEach,afterEach,mock}from'node:test';import assert from'node:assert/strict';import{Wallet,Interface,Transaction}from'../node_modules/ethers/lib.esm/index.js';
import{createExactPayerSigner}from'../recovery/payer-signer.mjs';import{QUOTE_TYPES,quoteDomain}from'../src/testnet-chain.mjs';import pins from'../recovery/pins.json'with{type:'json'};
const fixture=n=>new Wallet('0x'+'00'.repeat(31)+n.toString(16).padStart(2,'0'));
const A=fixture(1),Q=fixture(2),P=fixture(3),contracts={token:'0x'+'44'.repeat(20),router:'0x'+'55'.repeat(20),dispenser:'0x'+'66'.repeat(20)};
const roles={operator:A.address,payer:P.address,quoteSigner:Q.address};
const ti=new Interface(['function approve(address,uint256) returns(bool)']),ri=new Interface(['function pay((bytes32 quoteId,bytes32 requestHash,address payer,uint256 amount,uint256 deadline),bytes)']);
const request=(i,data)=>({type:2,chainId:11155111,from:P.address,to:[contracts.dispenser,contracts.token,contracts.router][i],nonce:i,value:0n,gasLimit:BigInt(['500000','250000','500000'][i]),maxFeePerGas:2000000000n,maxPriorityFeePerGas:1000000000n,data});
async function offer(){const quote={quoteId:'0x'+'77'.repeat(32),requestHash:pins.requestHash,payer:P.address,amount:'4200',deadline:'2100000000'};return{quote,signature:await Q.signTypedData(quoteDomain(11155111,contracts.router),QUOTE_TYPES,quote),resultHash:pins.resultHash,origin:pins.origin,chainId:11155111,token:contracts.token,router:contracts.router,recipient:A.address,quoteSigner:Q.address};}
test('fixed public fixture signer accepts exact claim approval payment only, then exhausted',async()=>{const sends=[];const s=createExactPayerSigner({wallet:P,roles,contracts,broadcast:async(raw,hash)=>{sends.push(Transaction.from(raw));return hash;}});await s.sendTransaction(request(0,'0x4e71d92d'));const o=await offer();s.bindOffer(o);await s.sendTransaction(request(1,ti.encodeFunctionData('approve',[contracts.router,4200])));await s.sendTransaction(request(2,ri.encodeFunctionData('pay',[o.quote,o.signature])));await assert.rejects(s.sendTransaction(request(2,ri.encodeFunctionData('pay',[o.quote,o.signature]))));assert.equal(sends.length,3);assert.equal(s.privateKey,undefined);assert(sends.every(tx=>tx.chainId===11155111n&&tx.value===0n));});
test('approval cannot occur before authenticated original offer is bound',async()=>{let calls=0;const s=createExactPayerSigner({wallet:P,roles,contracts,broadcast:async(raw,hash)=>{calls++;return hash;}});await s.sendTransaction(request(0,'0x4e71d92d'));await assert.rejects(s.sendTransaction(request(1,ti.encodeFunctionData('approve',[contracts.router,4200]))));assert.equal(calls,1);});
test('signed intent is immutable and original encoding pinned before signer awaits',async()=>{let sends=0;const wallet={address:P.address,async signTransaction(tx){assert(Object.isFrozen(tx));assert(Object.isFrozen(tx.accessList));try{tx.to=A.address;}catch{}return P.signTransaction({...tx,to:A.address});}};const s=createExactPayerSigner({wallet,roles,contracts,broadcast:async()=>{sends++;}});await assert.rejects(s.sendTransaction(request(0,'0x4e71d92d')));assert.equal(sends,0);await assert.rejects(s.sendTransaction(request(0,'0x4e71d92d')));});
test('unknown broadcast consumes stage and never signs or broadcasts again',async()=>{let signed=0,sent=0;const s=createExactPayerSigner({wallet:{address:P.address,signTransaction:tx=>{signed++;return P.signTransaction(tx);}},roles,contracts,broadcast:async()=>{sent++;throw Error('PRIVATE_RPC_CANARY');}});await assert.rejects(s.sendTransaction(request(0,'0x4e71d92d')),e=>e.message==='LAUNCH_PAYER_REFUSED_OR_UNKNOWN'&&!e.cause);await assert.rejects(s.sendTransaction(request(0,'0x4e71d92d')));assert.equal(signed,1);assert.equal(sent,1);});
test('changed chain fee amount nonce destination and extras reject before signer',async()=>{let calls=0;for(const patch of [{chainId:1},{maxFeePerGas:2000000001n},{value:1n},{nonce:1},{to:A.address},{accessList:[]},{gasLimit:500001n}]){const s=createExactPayerSigner({wallet:{address:P.address,async signTransaction(){calls++;}},roles,contracts,broadcast:async()=>{calls++;}});await assert.rejects(s.sendTransaction({...request(0,'0x4e71d92d'),...patch}));}assert.equal(calls,0);});
test('offer mutation, wrong request or unauthorized quote signer cannot change payment',async()=>{const s=createExactPayerSigner({wallet:P,roles,contracts,broadcast:async(raw,h)=>h});await s.sendTransaction(request(0,'0x4e71d92d'));const o=await offer();assert.throws(()=>s.bindOffer({...o,quote:{...o.quote,amount:'4201'}}));s.bindOffer(o);o.quote.amount='9999';await s.sendTransaction(request(1,ti.encodeFunctionData('approve',[contracts.router,4200])));await assert.rejects(s.sendTransaction(request(2,ri.encodeFunctionData('pay',[o.quote,o.signature]))));});

beforeEach(()=>mock.method(Date,'now',()=>Date.parse('2026-10-31T22:00:00Z')));afterEach(()=>mock.restoreAll());

test('accessor cannot change zero value between checking and signing; no accessor or signer is invoked',async()=>{
 let accesses=0,signed=0,sent=0;const tx=request(0,'0x4e71d92d');
 Object.defineProperty(tx,'value',{enumerable:true,get(){return accesses++===0?0n:1n;}});
 const s=createExactPayerSigner({wallet:{address:P.address,signTransaction:async v=>{signed++;return P.signTransaction(v);}},roles,contracts,broadcast:async(raw,h)=>{sent++;return h;}});
 await assert.rejects(s.sendTransaction(tx));assert.equal(accesses,0);assert.equal(signed,0);assert.equal(sent,0);
});

test('offer is snapshotted before validation, so a changing nested getter cannot alter signed payment',async()=>{
 const sent=[];const s=createExactPayerSigner({wallet:P,roles,contracts,broadcast:async(raw,h)=>{sent.push(Transaction.from(raw));return h;}});
 await s.sendTransaction(request(0,'0x4e71d92d'));const o=await offer();let reads=0;
 Object.defineProperty(o.quote,'amount',{enumerable:true,get(){return reads++===0?'4200':'4201';}});
 s.bindOffer(o);assert.equal(reads,1);await s.sendTransaction(request(1,ti.encodeFunctionData('approve',[contracts.router,4200])));
 const stable=await offer();await s.sendTransaction(request(2,ri.encodeFunctionData('pay',[stable.quote,stable.signature])));
 assert.equal(ri.decodeFunctionData('pay',sent[2].data)[0].amount,4200n);assert.equal(reads,1);
});
