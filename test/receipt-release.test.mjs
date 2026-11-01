import test from 'node:test';
import A from 'node:assert/strict';
import {readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {fixture} from './fixtures.mjs';
import {provisionReceiptSigner,readReceiptSigner} from '../src/receipt-storage.mjs';
import {hashJson} from '../src/core/json.mjs';
import {validateReceiptRelease} from '../src/receipt-release.mjs';
const hash=n=>'0x'+n.repeat(64);
const intent={format:'mote-usdc-receipt-signer-v1',binding:hash('a'),address:'0x'+'3'.repeat(40),purpose:'offers-and-receipts-only-unfunded'};
const grant={format:'mote-receipt-release-v1',intentHash:hashJson(intent),receiptSigner:intent.address,releaseBinding:hash('b')};
const options={expectedHash:hashJson(grant),currentBinding:hash('b'),intent};
test('explicit receipt source grant binds the original public intent and new source without changing either',()=>{const before=JSON.stringify({grant,intent});A.equal(validateReceiptRelease(grant,options),grant);A.equal(JSON.stringify({grant,intent}),before);});
for(const [name,mutate] of Object.entries({hash:x=>x.expectedHash=hash('c'),source:x=>x.currentBinding=hash('c'),original:x=>x.intent.binding=hash('c'),address:x=>x.intent.address='0x'+'4'.repeat(40),sameSource:x=>x.currentBinding=x.intent.binding}))test(`receipt source grant rejects ${name}`,()=>{const o=structuredClone(options);mutate(o);A.throws(()=>validateReceiptRelease(grant,o));});
for(const field of Object.keys(grant))test(`receipt source grant rejects altered ${field} even with a new hash`,()=>{const r={...grant,[field]:'bad'},o={...options,expectedHash:hashJson(r)};A.throws(()=>validateReceiptRelease(r,o));});
test('receipt grant rejects extra fields, missing hash, and non-hash original binding',()=>{const r={...grant,allowAll:true};A.throws(()=>validateReceiptRelease(r,{...options,expectedHash:hashJson(r)}));A.throws(()=>validateReceiptRelease(grant,{...options,expectedHash:undefined}));const i={...intent,binding:'public-scalar-fixture'},g={...grant,intentHash:hashJson(i)};A.throws(()=>validateReceiptRelease(g,{...options,intent:i,expectedHash:hashJson(g)}));});
test('held-directory fixture reuses the same key only with exact protected grant; original records stay byte-identical',()=>{
 const f=fixture();try{
  const original={fixture:true,root:f.dir,fixtureBinding:hash('a')},made=provisionReceiptSigner(original),files=['receipt-intent.json','receipt.key','receipt-installed.json'],before=files.map(n=>readFileSync(f.dir+'/'+n)),intent=JSON.parse(before[0]);
  const next={...original,fixtureBinding:hash('b'),expectedAddress:made.address},grant={format:'mote-receipt-release-v1',intentHash:hashJson(intent),receiptSigner:made.address,releaseBinding:hash('b')},path=f.dir+'/release-'+hash('b').slice(2)+'.json';
  A.throws(()=>readReceiptSigner(next));writeFileSync(path,JSON.stringify(grant),{flag:'wx',mode:0o600});
  A.throws(()=>readReceiptSigner({...next,env:{}}),/RECEIPT_RELEASE_HASH/);
  const signer=readReceiptSigner({...next,env:{MOTE_RECEIPT_RELEASE_HASH:hashJson(grant)}});A.equal(signer.address,made.address);A.deepEqual(Object.keys(signer).sort(),['address','signMessage']);
  for(let i=0;i<files.length;i++)A.deepEqual(readFileSync(f.dir+'/'+files[i]),before[i]);
  chmodSync(path,0o644);A.throws(()=>readReceiptSigner({...next,env:{MOTE_RECEIPT_RELEASE_HASH:hashJson(grant)}}),/RECEIPT_FILE/);A.throws(()=>provisionReceiptSigner(original),/ALREADY_RESERVED/);
 }finally{f.close();}
});
