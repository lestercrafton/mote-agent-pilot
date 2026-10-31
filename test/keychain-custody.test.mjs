import test from 'node:test';
import assert from 'node:assert/strict';
import { Transaction, getBytes } from 'ethers';
import { readFile } from 'node:fs/promises';
import { createFixtureCustody, openKeychainSigner, provisionFreshKeychainRole, describeQuoteHandoff, handoffQuoteToRender, KEYCHAIN_ACTIVATION, KEYCHAIN_SERVICES } from '../src/keychain-custody.mjs';

const ACK = 'PUBLIC_FIXTURE_BYTES_ONLY_NO_KEYCHAIN';
const recipient = `0x${'22'.repeat(20)}`;
const creation = { type: 2, chainId: 11155111, nonce: '0', to: null, data: '0x60006000f3', value: '0', gasLimit: '100000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000', accessList: [] };
const allocation = { ...creation, nonce: '4', to: recipient, data: '0x', value: '7000000000000000', gasLimit: '21000' };
const intents = [creation, {...creation,nonce:'1'}, {...creation,nonce:'2'}, {...creation,nonce:'3',to:recipient,data:'0xa9059cbb'}, allocation];
const options = { acknowledgement: ACK, allowedTransactions: intents };

test('fixture custody explicitly uses public bytes and never provisions or falls back to native storage', async t => {
  assert.throws(() => createFixtureCustody(), /ACK_REQUIRED/);
  const backend = createFixtureCustody(options); t.after(() => backend.destroy());
  assert.equal(backend.fixtureOnly, true);
  await assert.rejects(backend.openSigner().getAddress(), /ITEM_MISSING/);
  const publicResult = backend.provision();
  assert.equal(publicResult.service, KEYCHAIN_SERVICES.bootstrap);
  assert.equal(publicResult.address, '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
  assert.equal(JSON.stringify(publicResult).includes('private'), false);
  assert.throws(() => backend.provision(), /ALREADY_EXISTS/);
  backend.destroy(); await assert.rejects(backend.openSigner().getAddress(), /ITEM_MISSING/);
});

test('opaque bootstrap signer signs exact prebound type2 creation and one bounded allocation only', async t => {
  const backend = createFixtureCustody(options); t.after(() => backend.destroy()); backend.provision();
  const signer = backend.openSigner();
  assert.equal(signer.privateKey, undefined); assert.equal(signer.sendTransaction, undefined); assert.equal(signer.signMessage, undefined);
  for (const intent of [creation, allocation]) {
    const signed = Transaction.from(await signer.signTransaction(intent));
    assert.equal(signed.from, await signer.getAddress());
    assert.equal(signed.chainId, 11155111n); assert.equal(signed.type, 2);
    assert.equal(signed.unsignedSerialized, Transaction.from({ ...intent, nonce: Number(intent.nonce) }).unsignedSerialized);
  }
});

test('out-of-plan transactions fail before reading custody, including fee/type/chain/destination/calldata changes', async t => {
  const backend = createFixtureCustody(options); t.after(() => backend.destroy()); backend.provision();
  const signer = backend.openSigner();
  for (const patch of [{chainId:1},{chainId:84532},{type:0},{nonce:'5'},{data:'0x1234'},{to:recipient},{gasLimit:'100001'},{maxFeePerGas:'2000000001'},{maxPriorityFeePerGas:'1000000001'},{value:'1'},{accessList:[{address:recipient,storageKeys:[]}]},{gasPrice:'1'},{from:recipient}]) {
    await assert.rejects(signer.signTransaction({...creation,...patch}), /TRANSACTION_NOT_AUTHORIZED/);
  }
  assert.equal(backend.readCount, 0);
});

test('policy refuses missing or ambiguous intents, wrong role/network and overbroad access', () => {
  for (const patch of [{acknowledgement:'automatic'},{role:'deployer'},{role:'payer'},{chainId:1},{chainId:84532},{access:'all-applications'},{allowedTransactions:[]},{allowedTransactions:[creation,creation]},{allowedTransactions:Array(6).fill(creation)},{allowedTransactions:undefined}]) {
    assert.throws(() => createFixtureCustody({...options,...patch}));
  }
  assert.throws(() => createFixtureCustody({...options,allowedTransactions:intents.map((tx,i)=>({...tx,gasLimit:i===0?'5000001':tx.gasLimit}))}), /PLAN_SHAPE_INVALID/);
  assert.throws(() => createFixtureCustody({...options,allowedTransactions:intents.map((tx,i)=>({...tx,gasLimit:i===1?'7000001':tx.gasLimit}))}), /PLAN_SHAPE_INVALID/);
  assert.throws(() => createFixtureCustody({...options,allowedTransactions:[allocation,{...allocation,nonce:'2'}]}));
  assert.throws(() => createFixtureCustody({...options,allowedTransactions:[{...allocation,value:'7000000000000001'}]}));
});

test('quote-backup role exposes only address inspection and cannot acquire a transaction signer', async t => {
  assert.throws(() => createFixtureCustody({...options,role:'quote-backup'}), /ROLE_CANNOT_SIGN/);
  const backend = createFixtureCustody({acknowledgement:ACK,role:'quote-backup'}); t.after(() => backend.destroy()); backend.provision();
  const signer = backend.openSigner();
  assert.equal(signer.service, KEYCHAIN_SERVICES['quote-backup']);
  assert.equal(signer.signTransaction, undefined); assert.equal(signer.privateKey, undefined);
  assert.equal(await signer.getAddress(), '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
});

test('native backend has no default activation and is forbidden from the test harness before helper/file access', async () => {
  const base = {role:'bootstrap',chainId:11155111,allowedTransactions:intents};
  await assert.rejects(openKeychainSigner(base), /NATIVE_ACTIVATION_REQUIRED/);
  await assert.rejects(openKeychainSigner({...base,activation:KEYCHAIN_ACTIVATION}), /NATIVE_FORBIDDEN_IN_TEST|MACOS_REQUIRED/);
  await assert.rejects(provisionFreshKeychainRole({role:'quote-backup',chainId:11155111}), /NATIVE_ACTIVATION_REQUIRED/);
  await assert.rejects(provisionFreshKeychainRole({role:'quote-backup',chainId:11155111,activation:KEYCHAIN_ACTIVATION}), /NATIVE_FORBIDDEN_IN_TEST|MACOS_REQUIRED/);
  await assert.rejects(provisionFreshKeychainRole({role:'payer',chainId:11155111,activation:KEYCHAIN_ACTIVATION}), /WRONG_ROLE_OR_CHAIN/);

});

test('helper interface keeps secrets out of command arguments, environment, stdout and stderr by construction', async () => {
  const swift = await readFile(new URL('../scripts/keychain/mote-keychain.swift', import.meta.url),'utf8');
  const node = await readFile(new URL('../src/keychain-custody.mjs', import.meta.url),'utf8');
  assert(!swift.includes('print('));
  assert.match(swift, /privatePipe\(3\); try privatePipe\(4\)/);
  assert.match(swift, /SecKeychainSetUserInteractionAllowed\(false\)/);
  assert.match(swift, /SecItemAdd/); assert(!swift.includes('SecItemUpdate(')); assert(!swift.includes('SecItemDelete('));
  assert.match(node, /stdio: \['pipe','pipe','pipe','pipe','pipe'\]/);
  assert.match(node, /env: \{ PATH: '\/usr\/bin:\/bin', LANG: 'C' \}/);
  assert(!node.includes('security -w'));
});

const destination = { provider:'render', serviceId:'srv-fixture000000001', origin:'https://mote-fixture.onrender.com', configHash:'0x'+'11'.repeat(32), quoteSigner:'0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf', environmentKey:'MOTE_ETHEREUM_SEPOLIA_QUOTE_PRIVATE_KEY' };
test('quote handoff binds one reviewed Render target and passes public fixture bytes only through private callback', async t => {
  const backend=createFixtureCustody({acknowledgement:ACK,role:'quote-backup'});t.after(()=>backend.destroy());backend.provision();
  const target=describeQuoteHandoff(destination);let captured, count=0;
  const sink={destinationHash:target.destinationHash, async writeSecret(bytes,bound){count++;captured=bytes;assert.equal(bytes.length,32);assert.equal(bytes[31],1);assert.equal(bound.serviceId,destination.serviceId);return {accepted:true,destinationHash:bound.destinationHash};}};
  const result=await backend.handoffQuoteToRender({destination,approvedDestinationHash:target.destinationHash},sink);
  assert.equal(count,1);assert.equal(result.handedOff,true);assert.equal(captured.every(byte=>byte===0),true);
  assert.deepEqual(Object.keys(result).sort(),['address','destinationHash','handedOff']);
});
test('wrong handoff pins, service/origin/key name, sink and signer reject without a secret transfer', async t => {
  const backend=createFixtureCustody({acknowledgement:ACK,role:'quote-backup'});t.after(()=>backend.destroy());backend.provision();
  const target=describeQuoteHandoff(destination);let calls=0;
  const sink={destinationHash:target.destinationHash,async writeSecret(){calls++;return{};}};
  for(const patch of [{serviceId:'srv-other00000001'},{origin:'https://evil.example'},{origin:destination.origin+'/'},{environmentKey:'DEPLOYER_PRIVATE_KEY'},{provider:'other'},{extra:'ignored'}]){
    await assert.rejects(backend.handoffQuoteToRender({destination:{...destination,...patch},approvedDestinationHash:target.destinationHash},sink));
  }
  await assert.rejects(backend.handoffQuoteToRender({destination,approvedDestinationHash:target.destinationHash},{...sink,destinationHash:'wrong'}),/SINK_MISMATCH/);
  assert.equal(backend.readCount,0);assert.equal(calls,0);
  const wrongSigner={...destination,quoteSigner:recipient}, wrongTarget=describeQuoteHandoff(wrongSigner);
  await assert.rejects(backend.handoffQuoteToRender({destination:wrongSigner,approvedDestinationHash:wrongTarget.destinationHash},{...sink,destinationHash:wrongTarget.destinationHash}),/SIGNER_MISMATCH/);
  assert.equal(calls,0);
});
test('handoff exceptions are redacted, retain uncertain outcome and clear callback buffer', async t => {
  const backend=createFixtureCustody({acknowledgement:ACK,role:'quote-backup'});t.after(()=>backend.destroy());backend.provision();
  const target=describeQuoteHandoff(destination);let captured;
  await assert.rejects(backend.handoffQuoteToRender({destination,approvedDestinationHash:target.destinationHash},{destinationHash:target.destinationHash,async writeSecret(bytes){captured=bytes;throw Error('PRIVATE_CALLBACK_DIAGNOSTIC');}}),error=>error.message==='CUSTODY_HANDOFF_OUTCOME_UNKNOWN' && !error.cause);
  assert(captured.every(byte=>byte===0));
  await assert.rejects(handoffQuoteToRender({role:'quote-backup',chainId:11155111,destination,approvedDestinationHash:target.destinationHash},{}),/NATIVE_ACTIVATION_REQUIRED/);
});

test('policy and handoff snapshots survive caller mutation across asynchronous boundaries', async t => {
  const mutableIntents = structuredClone(intents);
  const bootstrap=createFixtureCustody({acknowledgement:ACK,allowedTransactions:mutableIntents});t.after(()=>bootstrap.destroy());bootstrap.provision();
  mutableIntents[0].data='0xbad0';mutableIntents[0].chainId=1;
  assert.equal(Transaction.from(await bootstrap.openSigner().signTransaction(creation)).chainId,11155111n);
  await assert.rejects(bootstrap.openSigner().signTransaction(mutableIntents[0]),/TRANSACTION_NOT_AUTHORIZED/);
  const quote=createFixtureCustody({acknowledgement:ACK,role:'quote-backup'});t.after(()=>quote.destroy());quote.provision();
  const mutableDestination={...destination}, target=describeQuoteHandoff(mutableDestination);let original=0,replaced=0;
  const sink={destinationHash:target.destinationHash,async writeSecret(bytes,bound){original++;assert.equal(bound.origin,destination.origin);return {accepted:true,destinationHash:bound.destinationHash};}};
  const pending=quote.handoffQuoteToRender({destination:mutableDestination,approvedDestinationHash:target.destinationHash},sink);
  mutableDestination.origin='https://other.onrender.com';sink.writeSecret=async()=>{replaced++;return{};};sink.destinationHash='changed';
  assert.equal((await pending).handedOff,true);assert.equal(original,1);assert.equal(replaced,0);
});
