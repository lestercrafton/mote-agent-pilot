import {constants,openSync,closeSync,lstatSync,fstatSync,readFileSync,writeFileSync,fsyncSync,readdirSync,realpathSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Wallet,hexlify} from 'ethers';
import {openQuoteDirectory} from '../legacy/src/quote-directory.mjs';
import {verifyRenderPrivateGroupMount} from '../legacy/src/render-mount-policy.mjs';
import {readTransition} from './release-binding.mjs';
import {PRODUCTION_ROOT} from './production-policy.mjs';
import {assert,address} from './protocol.mjs';
import {hashJson} from './core/json.mjs';
const names={intent:'receipt-intent.json',key:'receipt.key',receipt:'receipt-installed.json'};
const fixtureKey=Buffer.from('00'.repeat(31)+'02','hex');
function open(options) {
  const fixture=options.fixture===true;let root=PRODUCTION_ROOT,binding;
  if(fixture){assert(process.env.NODE_TEST_CONTEXT&&options.root?.startsWith(realpathSync(tmpdir())+'/'),'RECEIPT_FIXTURE_ONLY');root=options.root;binding='public-scalar-fixture';}
  else {assert(!options.root&&!options.hook&&process.platform==='linux'&&!process.env.NODE_TEST_CONTEXT,'RECEIPT_NATIVE_ONLY');const t=readTransition(options.env);binding=hashJson(t);verifyRenderPrivateGroupMount();
    const p=lstatSync('/var/data/mote-usdc');assert(p.isDirectory()&&!p.isSymbolicLink()&&p.uid===process.getuid()&&(p.mode&0o777)===0o700&&realpathSync('/var/data/mote-usdc')==='/var/data/mote-usdc','RECEIPT_DIRECTORY');}
  const s=lstatSync(root);assert(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&0o777)===0o700&&realpathSync(root)===root,'RECEIPT_DIRECTORY');
  const io=openQuoteDirectory(root,{expected:s,fixture});
  const verify=()=>{io.verify();const n=lstatSync(root);assert(n.dev===s.dev&&n.ino===s.ino&&n.uid===s.uid&&n.mode===s.mode&&!n.isSymbolicLink(),'RECEIPT_DIRECTORY_CHANGED');};
  return {io,verify,binding,fixture};
}
function write(store,name,bytes){store.verify();const fd=openSync(store.io.child(name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}store.io.sync();}
function read(store,name,max) {store.verify();const path=store.io.child(name),s=lstatSync(path);assert(s.isFile()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&0o777)===0o600&&s.nlink===1&&s.size>0&&s.size<=max,'RECEIPT_FILE');const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const n=fstatSync(fd);assert(n.dev===s.dev&&n.ino===s.ino&&n.size===s.size&&n.mode===s.mode&&n.uid===s.uid&&n.nlink===s.nlink,'RECEIPT_FILE_CHANGED');return readFileSync(fd);}finally{closeSync(fd);}}
const json=o=>Buffer.from(JSON.stringify(o)+'\n');
// This entry point is NOT called by startup. It is a separate, specifically
// approved one-time operation. Any existing item (including an interrupted
// intent) blocks a new identity; it never overwrites or "repairs" custody.
export function provisionReceiptSigner(options) {
  const store=open(options);let bytes;
  try {
    if(!store.fixture)assert(options.env.MOTE_RECEIPT_PROVISION==='create-one-unfunded-receipt-signer-v1','RECEIPT_PROVISION_APPROVAL');
    const existing=readdirSync(store.io.location());assert(!Object.values(names).some(n=>existing.includes(n)),'RECEIPT_ALREADY_RESERVED');
    bytes=store.fixture?Buffer.from(fixtureKey):randomBytes(32);
    const signer=new Wallet(hexlify(bytes)),intent={format:'mote-usdc-receipt-signer-v1',binding:store.binding,address:address(signer.address),purpose:'offers-and-receipts-only-unfunded'};
    write(store,names.intent,json(intent));options.hook?.('intent');
    write(store,names.key,bytes);options.hook?.('key');
    write(store,names.receipt,json({format:'mote-usdc-receipt-installed-v1',intentHash:hashJson(intent),address:intent.address,installed:true}));options.hook?.('installed');
    const check=readReceiptSigner({...options,expectedAddress:intent.address});assert(check.address===intent.address,'RECEIPT_READBACK');return {address:intent.address,binding:store.binding,installed:true};
  }finally{bytes?.fill(0);store.io.close();}
}
export function readReceiptSigner(options) {
  const store=open(options);let bytes;
  try {
    const intent=JSON.parse(read(store,names.intent,4096)),receipt=JSON.parse(read(store,names.receipt,4096));
    assert(Object.keys(intent).sort().join(',')==='address,binding,format,purpose'&&intent.format==='mote-usdc-receipt-signer-v1'&&intent.binding===store.binding&&intent.purpose==='offers-and-receipts-only-unfunded'&&address(intent.address)===address(options.expectedAddress),'RECEIPT_BINDING');
    assert(Object.keys(receipt).sort().join(',')==='address,format,installed,intentHash'&&receipt.format==='mote-usdc-receipt-installed-v1'&&receipt.intentHash===hashJson(intent)&&receipt.address===intent.address&&receipt.installed===true,'RECEIPT_INSTALLATION');
    bytes=read(store,names.key,32);assert(bytes.length===32&&(!store.fixture||bytes.equals(fixtureKey)),'RECEIPT_KEY');
    const wallet=new Wallet(hexlify(bytes));assert(address(wallet.address)===intent.address,'RECEIPT_ADDRESS');
    // No transaction/signTypedData/connect/privateKey surface is returned.
    return Object.freeze({address:intent.address,signMessage:message=>wallet.signMessage(message)});
  }finally{bytes?.fill(0);store.io.close();}
}
