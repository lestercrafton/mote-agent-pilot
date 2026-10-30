import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { TestnetMoteClient, LOCAL_FIXTURE_ACKNOWLEDGMENT } from '../src/testnet-client.mjs';
import { TestnetBudgetJournal } from '../src/testnet-journal.mjs';
import { createEthereumClientHarness, startEthereumWorker } from './helpers/ethereum-client-harness.mjs';

let h, sequence=0;
const input={document:{invoice:'synthetic-local-ethereum',quantity:3},schema:{type:'object',required:['quantity'],properties:{quantity:{type:'integer',minimum:1}}}};
const key=prefix=>`${prefix}-${++sequence}`;
const offerFor=client=>client.quote(input,key('ethereum-quote'),{publicSynthetic:true});
const guardSigner={getAddress(){throw new Error('Recovery called signer');},sendTransaction(){throw new Error('Recovery sent transaction');}};
before(async()=>{h=await createEthereumClientHarness();});
after(async()=>{await h?.close();});
function recoverer(f){return TestnetMoteClient.forLocalFixture({...f.clientOptions,journal:f.reopen(),signer:undefined});}

test('explicit loopback factory runs SAME standard client+Ethereum fee boundary and no public constructor relaxation',async()=>{
  const f=h.makeClient();
  assert.equal(f.client.constructor,TestnetMoteClient);
  assert.equal(f.client.assertFeeBoundary,TestnetMoteClient.prototype.assertFeeBoundary);
  assert.throws(()=>new TestnetMoteClient(f.clientOptions),{code:'CHAIN_DENIED'});
  assert.throws(()=>TestnetMoteClient.forLocalFixture({...f.clientOptions,acknowledgment:'yes'}),{code:'FIXTURE_ACKNOWLEDGMENT_REQUIRED'});
  assert.throws(()=>TestnetMoteClient.forLocalFixture({...f.clientOptions,reader:{...h.reader,endpoint:'https://ethereum-sepolia-rpc.publicnode.com'}}),{code:'FIXTURE_TRANSPORT_DENIED'});
  assert.throws(()=>TestnetMoteClient.forLocalFixture({...f.clientOptions,signer:{...guardSigner,provider:{_getConnection:()=>({url:'https://ethereum-sepolia-rpc.publicnode.com'})}}}),{code:'FIXTURE_SIGNER_DENIED'});
  const manifest=await f.client.discover();assert.equal(manifest.chainId??manifest.payment?.chainId??h.policy.chainId,11155111);
  const offer=await offerFor(f.client),orderKey=key('ethereum-order');
  const before=await h.token.balanceOf(h.policy.recipient),nonce=await h.provider.send('eth_getTransactionCount',[h.policy.payer,'pending']);
  const result=await f.client.execute(offer,orderKey);
  assert.equal(result.result.valid,true);assert.equal(result.receipt.chainId,11155111);assert.equal(result.receipt.protocol,'mote-ethereum-sepolia-test-v1');
  assert.equal((await h.token.balanceOf(h.policy.recipient))-before,BigInt(offer.quote.amount));
  assert.equal(BigInt(await h.provider.send('eth_getTransactionCount',[h.policy.payer,'pending']))-BigInt(nonce),2n);
  const row=f.journal.read(offer.quote.quoteId);assert.equal(row.phase,'complete');assert.equal(row.approvalIntent.gasLimit,'250000');assert.equal(row.paymentIntent.gasLimit,'500000');
  const receipts=await Promise.all([row.approvalHash,row.paymentHash].map(hash=>h.provider.send('eth_getTransactionReceipt',[hash])));
  const actual=receipts.reduce((sum,r)=>sum+BigInt(r.gasUsed)*BigInt(r.effectiveGasPrice),0n);
  assert.equal(f.journal.budget().gasSpentWei,actual.toString());assert.equal(f.journal.budget().gasReservedWei,'0');
  const recovered=await recoverer(f).recover(offer,null,orderKey);assert.deepEqual(recovered,result);
  assert.equal(BigInt(await h.provider.send('eth_getTransactionCount',[h.policy.payer,'pending']))-BigInt(nonce),2n);
});

test('complete execution cap denial happens before reservations or signer calls',async()=>{
  let calls=0;const signer={provider:h.payer.provider,async getAddress(){calls++;return h.policy.payer;},async sendTransaction(){calls++;throw new Error('must not send');}};
  const f=h.makeClient({maxGasPerTransactionWei:'1000'},signer),offer=await offerFor(f.client);
  await assert.rejects(f.client.execute(offer,key('deny-order')),e=>/LIMIT|CAP/.test(e.code));
  assert.equal(calls,0);assert.equal(f.journal.list().length,0);
});

test('lost real HTTP delivery recovers after reopening using original chain payment and no signer',async()=>{
  const f=h.makeClient(),offer=await offerFor(f.client),orderKey=key('lost-order'),original=f.client.fetchImpl;
  let dropped=false;
  f.client.fetchImpl=async(url,options)=>{const response=await original(url,options);if(url.endsWith('/v1/orders')&&!dropped){dropped=true;await response.text();throw new Error('controlled lost response after real service commit');}return response;};
  const nonce=BigInt(await h.provider.send('eth_getTransactionCount',[h.policy.payer,'pending']));
  await assert.rejects(f.client.execute(offer,orderKey),e=>e.doNotRepay&&e.settlementState==='finalized');
  assert.equal(f.journal.read(offer.quote.quoteId).phase,'settled');const budget=f.journal.budget();f.journal.close();
  const result=await recoverer(f).recover(offer,null,orderKey);assert.equal(result.result.valid,true);
  assert.equal(BigInt(await h.provider.send('eth_getTransactionCount',[h.policy.payer,'pending']))-nonce,2n);assert.deepEqual(f.reopen().budget(),budget);
});

test('crash before original broadcast retains intent and recovery never resumes it',async()=>{
  const signer={provider:h.payer.provider,getAddress:()=>h.payer.getAddress(),sendTransaction:async()=>{throw new Error('controlled before broadcast crash');}};
  const f=h.makeClient({},signer),offer=await offerFor(f.client),orderKey=key('before-send-order'),nonce=BigInt(await h.provider.send('eth_getTransactionCount',[h.policy.payer,'pending']));
  await assert.rejects(f.client.execute(offer,orderKey),{code:'PAYMENT_STATE_UNKNOWN'});
  assert.equal(f.journal.read(offer.quote.quoteId).phase,'approval_unknown');const budget=f.journal.budget();
  await assert.rejects(recoverer(f).recover(offer,null,orderKey),{code:'PAYMENT_STATE_UNKNOWN'});assert.deepEqual(f.journal.budget(),budget);
  assert.equal(BigInt(await h.provider.send('eth_getTransactionCount',[h.policy.payer,'pending'])),nonce);
});

test('lost payment-send response accounts observed payment but retains original fee cap and gate',async()=>{
  let paymentHash;
  const signer={provider:h.payer.provider,getAddress:()=>h.payer.getAddress(),async sendTransaction(tx){const sent=await h.payer.sendTransaction(tx);if(tx.to.toLowerCase()===h.policy.router){paymentHash=sent.hash;throw new Error('controlled lost payment send response');}return sent;}};
  const f=h.makeClient({},signer),offer=await offerFor(f.client),orderKey=key('unknown-hash-order');
  await assert.rejects(f.client.execute(offer,orderKey),{code:'PAYMENT_STATE_UNKNOWN'});
  assert.equal(f.journal.read(offer.quote.quoteId).paymentHash,null);assert.ok(paymentHash);
  const recovered=await recoverer(f).recover(offer,paymentHash,orderKey);assert.equal(recovered.result.valid,true);
  const row=f.journal.read(offer.quote.quoteId);assert.equal(row.phase,'payment_unknown');assert.equal(row.paymentReservedWei,h.policy.maxGasPerTransactionWei);
  assert.equal(row.tokenSpent,offer.quote.amount);const other=await offerFor(f.client);assert.throws(()=>f.journal.reserve(other,key('unknown-second-order')),{code:'WALLET_BUSY'});
});

test('live original owner waits for approval finality then pays once; read-only recovery remains separate',async()=>{
  const f=h.makeClient(),orderKey=key('wait-order'),original=h.reader.send;
  let pendingReads=2,receiptHash;
  // Only RPC observation is delayed; no fee or receipt verification is replaced.
  const reader={...h.reader,async send(method,params){const value=await original(method,params);if(method==='eth_getTransactionReceipt'&&value&&value.from?.toLowerCase()===h.policy.payer){receiptHash??=value.transactionHash;if(value.transactionHash===receiptHash&&pendingReads-->0)return null;}return value;}};
  const client=TestnetMoteClient.forLocalFixture({...f.clientOptions,reader,finalityWaitMs:2000,finalityPollMs:100});
  const offer=await offerFor(client);
  const nonce=BigInt(await h.provider.send('eth_getTransactionCount',[h.policy.payer,'pending']));
  assert.equal((await client.execute(offer,orderKey)).result.valid,true);
  assert.ok(pendingReads<0);assert.equal(BigInt(await h.provider.send('eth_getTransactionCount',[h.policy.payer,'pending']))-nonce,2n);
});

test('separate processes share one token budget and wallet gate on real local Ethereum RPC',async()=>{
  const seed=h.makeClient({maxTotalSpend:'3000'});seed.journal.close();
  const job={options:seed.options,config:h.config,rpcUrl:h.rpcUrl,baseUrl:h.baseUrl,localServiceOrigin:h.localServiceOrigin,input,quoteKey:key('process-quote'),orderKey:key('process-order')};
  const children=[startEthereumWorker(job),startEthereumWorker({...job,quoteKey:key('process-quote'),orderKey:key('process-order')})];
  const results=await Promise.all(children.map(c=>c.done));for(const r of results)assert.equal(r.code,0,r.stderr);
  assert.equal(results.filter(r=>r.result.ok).length,1,JSON.stringify(results.map(r=>r.result)));
  assert.equal(results.find(r=>!r.result.ok).result.error.code,'TOTAL_LIMIT');
  const journal=seed.reopen();assert.equal(journal.list().length,1);assert.equal(journal.list()[0].phase,'complete');
});

test('bounded finality timeout retains the known approval and restarted recovery never progresses to payment',async()=>{
  const f=h.makeClient(),original=h.reader.send;
  const reader={...h.reader,async send(method,params){const value=await original(method,params);return method==='eth_getTransactionReceipt'&&value?.from?.toLowerCase()===h.policy.payer?null:value;}};
  const client=TestnetMoteClient.forLocalFixture({...f.clientOptions,reader,finalityWaitMs:0});
  const offer=await offerFor(client),orderKey=key('timeout-order'),nonce=BigInt(await h.provider.send('eth_getTransactionCount',[h.policy.payer,'pending']));
  await assert.rejects(client.execute(offer,orderKey),e=>e.code==='PAYMENT_STATE_UNKNOWN'&&e.cause?.code==='FINALITY_TIMEOUT');
  assert.ok(f.journal.read(offer.quote.quoteId).approvalHash);assert.equal(f.journal.read(offer.quote.quoteId).phase,'approval_unknown');
  await assert.rejects(recoverer(f).recover(offer,null,orderKey),{code:'PAYMENT_STATE_UNKNOWN'});
  assert.equal(f.journal.read(offer.quote.quoteId).phase,'approved');assert.equal(f.journal.budget().gasReservedWei,h.policy.maxGasPerTransactionWei);
  assert.equal(BigInt(await h.provider.send('eth_getTransactionCount',[h.policy.payer,'pending']))-nonce,1n);
  assert.throws(()=>TestnetMoteClient.forLocalFixture({...f.clientOptions,finalityWaitMs:1800001}),{code:'FINALITY_WAIT_INVALID'});
});

test('concurrent original calls and later replay deliver one result with only one exact approval/payment pair',async()=>{
  const f=h.makeClient(),offer=await offerFor(f.client),orderKey=key('duplicate-order'),nonce=BigInt(await h.provider.send('eth_getTransactionCount',[h.policy.payer,'pending']));
  const [a,b]=await Promise.all([f.client.execute(offer,orderKey),f.client.execute(offer,orderKey)]);
  assert.deepEqual(a,b);assert.deepEqual(await f.client.execute(offer,orderKey),a);
  assert.equal(f.journal.list().length,1);assert.equal(BigInt(await h.provider.send('eth_getTransactionCount',[h.policy.payer,'pending']))-nonce,2n);
  await assert.rejects(f.client.execute(offer,key('conflicting-order')),{code:'IDEMPOTENCY_CONFLICT'});
});

test('malformed exact transaction requests cannot reach signer or durable intent even when a quote is reserved',async()=>{
  let sends=0;const signer={provider:h.payer.provider,getAddress:()=>h.payer.getAddress(),async sendTransaction(){sends++;throw new Error('must not send');}};
  const f=h.makeClient({},signer),offer=await offerFor(f.client);f.journal.reserve(offer,key('malformed-order'));
  const intent=f.client.makeIntent('approval',offer,BigInt(await h.provider.send('eth_getTransactionCount',[h.policy.payer,'pending'])));
  for(const change of [{chainId:84532},{value:'1'},{type:3},{maxPriorityFeePerGas:'3000000000'},{gasLimit:'16777217'},{nonce:'9007199254740992'},{authorizationList:[]},{gasPrice:'2'},{maxFeePerGas:'4000000000'}]){
    await assert.rejects(f.client.sendIntent(offer.quote.quoteId,'approval','reserved',{...intent,...change}));
    assert.equal(f.journal.read(offer.quote.quoteId).phase,'reserved');
  }
  assert.equal(sends,0);f.journal.cancelReserved(offer.quote.quoteId);
});

test('quote expiry after finalized approval stops payment and retains the approved wallet gate',async()=>{
  const snapshot=await h.provider.send('evm_snapshot',[]);
  try{
    const signer={provider:h.payer.provider,getAddress:()=>h.payer.getAddress(),async sendTransaction(tx){const sent=await h.payer.sendTransaction(tx);await sent.wait();if(tx.to.toLowerCase()===h.policy.token){await h.provider.send('evm_increaseTime',[3601]);await h.provider.send('evm_mine',[]);}return sent;}};
    const f=h.makeClient({},signer),offer=await offerFor(f.client),orderKey=key('expiry-order');
    const nonce=BigInt(await h.provider.send('eth_getTransactionCount',[h.policy.payer,'pending'])),balance=await h.token.balanceOf(h.policy.recipient);
    await assert.rejects(f.client.execute(offer,orderKey),e=>e.code==='PAYMENT_STATE_UNKNOWN'&&e.cause?.code==='QUOTE_EXPIRED');
    assert.equal(f.journal.read(offer.quote.quoteId).phase,'approved');assert.equal(f.journal.budget().gasReservedWei,h.policy.maxGasPerTransactionWei);
    assert.equal(BigInt(await h.provider.send('eth_getTransactionCount',[h.policy.payer,'pending']))-nonce,1n);assert.equal(await h.token.balanceOf(h.policy.recipient),balance);
    await assert.rejects(recoverer(f).recover(offer,null,orderKey),{code:'PAYMENT_STATE_UNKNOWN'});
  }finally{await h.provider.send('evm_revert',[snapshot]);}
});
