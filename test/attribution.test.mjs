import test from 'node:test';
import A from 'node:assert/strict';
import { encodeBuilderCodeSuffix } from '@x402/extensions/builder-code';
import { validateTransferCalldata } from '../src/attribution.mjs';
import { fixture } from './fixtures.mjs';
const prefix='0x12345678';const marker='80218021802180218021802180218021';
const wire=hex=>hex+(hex.length/2).toString(16).padStart(4,'0')+'02'+marker;
for(const data of [{a:'bc_myapp'},{w:'cdp'},{a:'bc_myapp',w:'bc_myfacilitator',s:['client_one','service_two']},{w:'cdp',m:{x402Example:7,x402Array:[1n,'two',{a:3}]}}])test('official encoder vector validates '+Object.keys(data).join(','),()=>{
 const suffix=encodeBuilderCodeSuffix(data).slice(2);A.equal(validateTransferCalldata(prefix+suffix,prefix).schema,2);
});
test('published single-app vector and no-suffix direct call',()=>{A.equal(validateTransferCalldata(prefix+'a161616862635f6d79617070000c02'+marker,prefix).bytes,12);A.equal(validateTransferCalldata(prefix,prefix),null);});
for(const [name,hex] of [
 ['duplicate keys','a26177616361776164'],['unknown key','a1617a6163'],['nonminimal string','a16177780163'],
 ['indefinite map','bf61776163ff'],['invalid UTF8','a1617761ff'],['trailing CBOR','a16177616300'],
 ['empty map','a0'],['byte string','a161774163'],['negative integer','a1616da1647834303220'],
 ['float','a1616da16478343032f93c00'],['tag','a1616da16478343032c000'],['unknown metadata prefix','a1616da1617a00'],
 ['noncanonical top order','a26177616361616161'],['service scalar','a161736163'],['empty services','a1617380'],
])test('reject attribution '+name,()=>A.throws(()=>validateTransferCalldata(prefix+wire(hex),prefix)));
test('reject malformed marker/schema/length, gaps, trailing bytes and changed call',()=>{
 const suffix=encodeBuilderCodeSuffix({w:'cdp'}).slice(2);
 for(const actual of [prefix+suffix+'00',prefix+'00'+suffix,prefix+suffix.slice(0,-1)+'0',prefix+suffix.slice(0,-34)+'01'+marker,prefix+suffix.slice(0,-38)+'ffff02'+marker,'0x22345678'+suffix])A.throws(()=>validateTransferCalldata(actual,prefix));
});
test('reject excessive metadata, service counts, depth and noncanonical maps',()=>{
 let deep=1;for(let i=0;i<8;i++)deep=[deep];
 for(const d of [{s:Array.from({length:12},(_,i)=>'s'+i)},{s:['a','a']},{w:'A'},{m:{x402text:'x'.repeat(257)}},{m:{x402x:deep}}])A.throws(()=>validateTransferCalldata(prefix+encodeBuilderCodeSuffix(d).slice(2),prefix));
});
test('full proof accepts official signed attribution but preserves transfer binding',async()=>{
 const f=fixture();try{const p=await f.payment();const h=await f.chain.settle(p,encodeBuilderCodeSuffix({w:'cdp',m:{x402Example:7}}).slice(2));A.equal((await f.proof.settled(p,h)).transaction,h);p.payload.authorization.value='999';await A.rejects(f.proof.settled(p,h),/UNSUPPORTED_TRANSFER_CALL/);}finally{f.close();}
});
