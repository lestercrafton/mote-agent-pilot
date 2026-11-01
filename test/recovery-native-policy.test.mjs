import test,{beforeEach,afterEach,mock} from 'node:test';
import assert from 'node:assert/strict';
import {Wallet,Transaction} from 'ethers';
import {createFixtureCustody} from '../recovery/keychain-custody.mjs';
import {openRecoveryOperatorSigner} from '../recovery/operator-signer.mjs';
import {createBootstrapPlan} from '../src/bootstrap-plan.mjs';
import {R1} from '../src/recovery-r1-policy.mjs';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const fixture=n=>new Wallet('0x'+'00'.repeat(31)+String(n).padStart(2,'0'));
function plan(){return createBootstrapPlan({chainId:11155111,operator:fixture(1).address,merchant:fixture(1).address,quoteSigner:fixture(2).address,payer:fixture(3).address,operatorNonce:'0',payerNativeWei:'7000000000000000'}).transactions.map(({transaction:{from,...tx}})=>tx);}
beforeEach(()=>mock.method(Date,'now',()=>Date.parse('2026-10-31T22:00:00Z')));afterEach(()=>mock.restoreAll());
test('real frozen custody policy accepts full shape while wrapper rejects old nonces before secret reads',async()=>{
 const allowedTransactions=plan();let c;
 const signer=await openRecoveryOperatorSigner({nativeOptions:{role:'bootstrap'},allowedTransactions,openSigner:async o=>{c=createFixtureCustody({acknowledgement:'PUBLIC_FIXTURE_BYTES_ONLY_NO_KEYCHAIN',role:o.role,allowedTransactions:o.allowedTransactions});c.provision();return c.openSigner();}});
 try{
  for(const tx of allowedTransactions.slice(0,2))await assert.rejects(signer.signTransaction(tx),{code:'R1_OPERATOR_INTENT_REFUSED'});assert.equal(c.readCount,0);
  for(const tx of allowedTransactions.slice(2)){const signed=Transaction.from(await signer.signTransaction(tx));assert.equal(signed.nonce,Number(tx.nonce));assert.equal(signed.from,fixture(1).address);}assert.equal(c.readCount,3);
 }finally{c.destroy();}
});
test('request mutation during native await cannot redirect allowed encoding; expiry refuses before secret read',async()=>{
 const allowedTransactions=plan(),tx=structuredClone(allowedTransactions[2]);let reads=0;
 const signer=await openRecoveryOperatorSigner({nativeOptions:{role:'bootstrap'},allowedTransactions,openSigner:async()=>({getAddress:async()=>fixture(1).address,async signTransaction(v){reads++;tx.to=fixture(3).address;return fixture(1).signTransaction(v);}})});
 const raw=await signer.signTransaction(tx);assert.equal(Transaction.from(raw).to,null);assert.equal(reads,1);
 mock.method(Date,'now',()=>R1.operationalDeadline);await assert.rejects(signer.signTransaction(allowedTransactions[3]));assert.equal(reads,1);
});
test('copied custody module retains frozen source after reversing import-only relocation',()=>{
 const s=readFileSync(new URL('../recovery/keychain-custody.mjs',import.meta.url),'utf8').replaceAll("from '../node_modules/","from '../../mote-custody-handoff-candidate-v0722/node_modules/").replaceAll("from '../src/","from '../../mote-custody-handoff-candidate-v0722/src/");
 assert.equal(createHash('sha256').update(s).digest('hex'),'5dd82847fc3458306da3569dc90305e2f9b20227accda9abbbc87a2d5614b9fb');
});
