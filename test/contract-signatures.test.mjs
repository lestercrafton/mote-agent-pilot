import test from 'node:test';import assert from 'node:assert/strict';import {join} from 'node:path';
import {TypedDataEncoder,AbiCoder} from 'ethers';
import {fixture,input,H,PUBLIC_FIXTURE_PAYER,PUBLIC_FIXTURE_OPERATOR} from './fixtures.mjs';
import {CONTRACT,WRAPPER,wrapTyped,ContractFixtureChain} from './contract-fixtures.mjs';
import {Journal} from '../src/journal.mjs';import {Service} from '../src/service.mjs';import {authorize,recoverAuthorization} from '../src/client.mjs';
import {DeployedSignatureVerifier,deployedPaymentValidator,opaqueSignature,ERC1271} from '../src/contract-signatures.mjs';
import {FinalizedProof,authorizationCalldata} from '../src/chain-proof.mjs';
import {address,BINDING,AUTH_TYPES,authDomain,validatePayment} from '../src/protocol.mjs';
import {snapshot,inspectJournal} from '../src/maintenance.mjs';
import {ADMISSION} from '../src/admission-evidence.mjs';
import {ExactEvmScheme as OfficialFacilitator} from '@x402/evm/exact/facilitator';
import {checkWrapped} from './contract-fixtures.mjs';
function setup(){
 const f=fixture({config:{payerSignatureProfile:'deployed-erc1271-v1'}}),chain=new ContractFixtureChain(f.c,f.chain.now),proof=new FinalizedProof(f.c,chain.rpc,{allowContractSignatures:true}),validator=deployedPaymentValidator(new DeployedSignatureVerifier({network:f.c.network,rpc:chain.rpc}));
 const policy={...f.policy,payer:address(CONTRACT)},client=new Journal(join(f.dir,'contract-client.sqlite'),{config:f.c.identity,policy},{create:true,clientBudget:policy.maxTotal});
 const facilitator={verifies:0,settles:0,async verify(p){this.verifies++;return {isValid:true,payer:CONTRACT};},async settle(p){this.settles++;return {success:true,network:f.c.network,transaction:await chain.settle(p)};}};
 const makeService=()=>new Service({config:f.c,journal:f.journal,facilitator,proof,receiptSigner:PUBLIC_FIXTURE_OPERATOR,paymentValidator:validator,admissionEvidence:true,now:()=>chain.now});
 const service=makeService();
 return {...f,chain,proof,validator,client,policy,facilitator,service,makeService,async pay(id='contract-payment-0001'){const offerResponse=await service.offer(input);return authorize({config:f.c,input,offerResponse,paymentId:id,signer:{address:CONTRACT,signTypedData:wrapTyped},journal:client,policy,now:chain.now,paymentValidator:validator});},close(){client.close();f.close();}};
}
test('224-byte Coinbase wrapper uses a different replay-safe digest; never extract inner ECDSA',async()=>{
 const t={domain:{name:'Fixture',version:'1',chainId:8453,verifyingContract:CONTRACT},types:{Check:[{name:'value',type:'uint256'}]},message:{value:1n}};
 const sig=await wrapTyped(t);assert.equal((sig.length-2)/2,224);assert.equal(opaqueSignature(sig),sig);
 const [wrapper]=AbiCoder.defaultAbiCoder().decode(WRAPPER,sig);assert.equal(wrapper.signatureData.length,132);assert.notEqual(wrapper.signatureData,sig);
 const f=setup();try{const p=await f.pay();assert.throws(()=>validatePayment(f.c,input,p,f.chain.now),/EOA_ONLY/);}finally{f.close();}
});
test('full opaque payment, exact bytes settlement, receipt and restart retry settle once',async()=>{const f=setup();try{
 const p=await f.pay();const result=await f.service.execute(input,p);assert.equal(result.status,'complete');
 assert.equal(authorizationCalldata(p,{allowContractSignatures:true}).slice(0,10),'0xcf092995');
 assert.deepEqual(await f.makeService().execute(input,recoverAuthorization(f.client,p.extensions['payment-identifier'].info.id)),result);
 assert.equal(f.facilitator.settles,1);assert.equal(f.facilitator.verifies,1);
 assert.equal(f.chain.signatureCalls.every(p=>p[0].gas==='0x7a120'&&p[1].requireCanonical===true),true);
}finally{f.close();}});
test('lost settlement response recovers without signing or settling again',async()=>{const f=setup();try{
 const p=await f.pay();f.facilitator.settle=async p=>{f.facilitator.settles++;await f.chain.settle(p);throw Error('lost');};
 assert.equal((await f.service.execute(input,p)).status,'pending');
 assert.equal((await f.makeService().execute(input,p)).status,'complete');assert.equal(f.facilitator.settles,1);
}finally{f.close();}});
test('concurrent identical requests have one durable settlement owner',async()=>{const f=setup();try{
 const p=await f.pay();await Promise.all(Array.from({length:4},()=>f.service.execute(input,p)));assert.equal(f.facilitator.settles,1);
 assert.equal((await f.service.execute(input,p)).status,'complete');
}finally{f.close();}});
for(const field of ['authorization','binding'])test(`wrong ${field} digest/owner fails before facilitator`,async()=>{const f=setup();try{
 const p=await f.pay();const t={domain:authDomain(f.c),types:AUTH_TYPES,message:p.payload.authorization};const wrong=await wrapTyped(t,CONTRACT,PUBLIC_FIXTURE_OPERATOR);
 if(field==='authorization')p.payload.signature=wrong;else p.extensions[BINDING].info.signature=wrong;
 await assert.rejects(f.service.execute(input,p),/CONTRACT_SIGNATURE_INVALID/);assert.equal(f.facilitator.verifies,0);assert.equal(f.facilitator.settles,0);
}finally{f.close();}});
for(const response of ['0x1626ba7e','0x1626ba7e'+'00'.repeat(29),'0xffffffff'+'00'.repeat(28),'0x1626ba7e'+'00'.repeat(27)+'01'])test(`reject malformed/wrong ERC1271 response ${response.length}`,async()=>{const f=setup();try{
 const p=await f.pay();f.chain.contractOverride=(m,p)=>m==='eth_call'&&p[0].data.startsWith('0x1626ba7e')?response:undefined;
 await assert.rejects(f.service.execute(input,p),/CONTRACT_SIGNATURE_INVALID/);assert.equal(f.facilitator.verifies,0);
}finally{f.close();}});
for(const sig of ['0x','0xz1','0x123','0x'+'00'.repeat(4097),'0x12'+'6492'.repeat(16)])test(`reject bounded invalid/6492 signature ${sig.length}`,()=>assert.throws(()=>opaqueSignature(sig)));
test('RPC error, wrong chain, reorg and no-code wrapper all fail closed',async()=>{const f=setup();try{
 const p=await f.pay();
 for(const mode of ['rpc','chain','reorg','nocode']){
  f.chain.contractOverride=(m,params)=>{if(mode==='rpc'&&m==='eth_getCode')throw Error('rpc outage');if(mode==='chain'&&m==='eth_chainId')return '0x1';if(mode==='reorg'&&m==='eth_getBlockByNumber'&&params[0]!=='finalized')return {number:'0x64',hash:H(999)};if(mode==='nocode'&&m==='eth_getCode')return '0x';};
  await assert.rejects(f.service.execute(input,p));assert.equal(f.facilitator.verifies,0);
 }
}finally{f.close();}});
test('revocation preserves exact-payload read-only recovery, never authorizes a new settlement',async()=>{const f=setup();try{
 const p=await f.pay();f.facilitator.settle=async p=>{f.facilitator.settles++;throw Error('unknown');};
 assert.equal((await f.service.execute(input,p)).status,'pending');f.chain.revoked=true;
 assert.equal((await f.makeService().execute(input,p)).status,'pending');assert.equal(f.facilitator.settles,1);assert.equal(f.journal.attempts(),1);
 const altered=structuredClone(p);altered.extensions[BINDING].info.signature='0x11';await assert.rejects(f.makeService().execute(input,altered),/ADMISSION_SIGNATURE/);
}finally{f.close();}});
test('fresh expiry after RPC and after reservation prevents settlement',async()=>{for(const point of ['rpc','reservation']){const f=setup();try{
 const p=await f.pay();let n=0;
 if(point==='rpc')f.chain.contractOverride=(m)=>{if(m==='eth_chainId'&&++n===2)f.chain.now=Number(p.payload.authorization.validBefore);};
 else f.service.hook=async stage=>{if(stage==='afterReservation')f.chain.now=Number(p.payload.authorization.validBefore);};
 await assert.rejects(f.service.execute(input,p),/AUTH_EXPIRED|OFFER_EXPIRED/);assert.equal(f.facilitator.settles,0);assert.equal(f.journal.attempts(),point==='reservation'?1:0);
}finally{f.close();}}});
test('signed admission survives offline backup and quarantined restore after wallet revocation',async()=>{const f=setup();try{
 const p=await f.pay(),result=await f.service.execute(input,p);f.chain.revoked=true;
 const expected={identity:f.c.identity,config:f.c,limits:f.journal.limits};
 const saved=await snapshot({source:f.journal.path,destination:join(f.dir,'backup.sqlite'),expected});
 const restored=await snapshot({source:saved.destination,destination:join(f.dir,'restored.sqlite'),expected,restore:true});
 const j=new Journal(restored.destination,f.c.identity,{recoveryOnly:true});try{
  const s=new Service({config:f.c,journal:j,facilitator:{verify(){throw Error('forbidden');},settle(){throw Error('forbidden');}},proof:f.proof,receiptSigner:PUBLIC_FIXTURE_OPERATOR,paymentValidator:f.validator,admissionEvidence:true,now:()=>f.chain.now});
  assert.deepEqual(await s.execute(input,p),result);await assert.rejects(s.offer(input),/JOURNAL_QUARANTINED/);
 }finally{j.close();}
 const row=f.journal.db.prepare('SELECT * FROM orders').get(),stored=JSON.parse(row.payment);stored.extensions[ADMISSION].body.blockHash=H(999);
 f.journal.db.prepare('UPDATE orders SET payment=? WHERE authKey=?').run(JSON.stringify(stored),row.authKey);
 assert.throws(()=>inspectJournal(f.journal.db,expected),/ADMISSION_SIGNATURE/);await assert.rejects(f.service.execute(input,p),/ADMISSION_SIGNATURE/);
}finally{f.close();}});
test('caller-supplied admission cannot authorize an absent order',async()=>{const f=setup();try{
 const p=await f.pay();p.extensions[ADMISSION]={body:{},signature:'0x11'};
 await assert.rejects(f.service.execute(input,p),/UNEXPECTED_ADMISSION_EVIDENCE/);assert.equal(f.facilitator.verifies,0);assert.equal(f.facilitator.settles,0);
}finally{f.close();}});
test('strict proof rejects altered opaque signature and disabled-mode opaque call',async()=>{const f=setup();try{
 const p=await f.pay(),h=await f.chain.settle(p);const changed=structuredClone(p);changed.payload.signature=changed.payload.signature.slice(0,-2)+'01';
 await assert.rejects(f.proof.settled(changed,h),/UNSUPPORTED_TRANSFER_CALL/);
 await assert.rejects(new FinalizedProof(f.c,f.chain.rpc).settled(p,h));assert.equal((await f.proof.settled(p,h)).transaction,h);
}finally{f.close();}});
test('exact amount, chain, payee, request binding and expiry remain enforced',async()=>{const f=setup();try{
 const p=await f.pay();for(const mutate of [p=>p.payload.authorization.value='1001',p=>p.accepted.network='eip155:1',p=>p.payload.authorization.to=CONTRACT,p=>p.payload.authorization.validBefore='1']){const bad=structuredClone(p);mutate(bad);await assert.rejects(f.service.execute(input,bad));}
 await assert.rejects(f.service.execute({...input,document:{changed:true}},p));assert.equal(f.facilitator.verifies,0);
}finally{f.close();}});
test('caller mutation during RPC cannot change verified message or signature',async()=>{const f=setup();try{
 const p=await f.pay(),original=structuredClone(p);let once=true;f.chain.contractOverride=(m)=>{if(m==='eth_chainId'&&once){once=false;p.payload.authorization.to=CONTRACT;p.payload.signature='0x11';}};
 const v=await f.validator(f.c,input,p,f.chain.now);assert.equal(v.payer,address(CONTRACT));assert.notEqual(p.payload.signature,original.payload.signature);
}finally{f.close();}});
test('strict proof supports canonical bytes overload even for a65-byte signature',async()=>{const f=fixture();try{
 const p=await f.payment(),chain=new ContractFixtureChain(f.c,f.chain.now);chain.encoding='bytes';const h=await chain.settle(p);
 assert.equal(chain.transfers.get(h).tx.input.slice(0,10),'0xcf092995');
 const proof=new FinalizedProof(f.c,chain.rpc,{allowContractSignatures:true});assert.equal((await proof.settled(p,h)).transaction,h);
 await assert.rejects(new FinalizedProof(f.c,chain.rpc).settled(p,h),/UNSUPPORTED_TRANSFER_CALL/);
}finally{f.close();}});
test('official pinned x402 SDK preserves full224-byte signature through verify/simulate/settle fixtures',async()=>{const f=setup();try{
 const p=await f.pay();let simulated=0,written=0;
 const sdk=new OfficialFacilitator({getAddresses:()=>[PUBLIC_FIXTURE_OPERATOR.address],getCode:async()=> '0x6000',
  async readContract(call){
   if(call.functionName==='isValidSignature')return checkWrapped(call.args[0],call.args[1],call.address,84532)?'0x1626ba7e':'0xffffffff';
   assert.equal(call.functionName,'transferWithAuthorization');assert.equal(call.args.length,7);assert.equal(call.args[6],p.payload.signature);simulated++;return undefined;
  },
  async writeContract(call){assert.equal(call.functionName,'transferWithAuthorization');assert.equal(call.args.length,7);assert.equal(call.args[6],p.payload.signature);written++;return f.chain.settle(p);},
  async waitForTransactionReceipt({hash}){return {...f.chain.transfers.get(hash).receipt,status:'success'};},
  async sendTransaction(){throw Error('no deployment permitted');}
 });
 assert.equal((await sdk.verify(p,p.accepted)).isValid,true);const settled=await sdk.settle(p,p.accepted);assert.equal(settled.success,true);assert.equal(simulated,1);assert.equal(written,1);
 assert.equal((await f.proof.settled(p,settled.transaction)).transaction,settled.transaction);
 const bad=structuredClone(p);bad.payload.signature=bad.payload.signature.slice(0,-2)+'01';assert.equal((await sdk.verify(bad,bad.accepted)).isValid,false);assert.equal(written,1);
}finally{f.close();}});
