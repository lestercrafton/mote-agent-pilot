import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { computeAddress, hexlify } from 'ethers';
import { QUOTE_HANDOFF_ACTIVATION, QUOTE_HANDOFF_FIXTURE_ACK, QUOTE_KEY_FILE,
  describeFileHandoffDestination, validateFileHandoffDestination, hashFileHandoffChallenge,
  validateFileHandoffChallenge, createReceiverSession, sealQuoteKey } from '../src/quote-key-envelope.mjs';

// Fixed, deliberately public test values. No generation, native custody,
// provider calls or persistent credential files occur in this suite.
const KEY = Buffer.from('00'.repeat(31)+'01','hex');
const NOW = 2_000_000_000_000;
const INPUT = {serviceId:'srv-dbijuvou01pc73d59c30',origin:'https://mote-testnet-pilot.onrender.com',
  configHash:'0x'+'34'.repeat(32),quoteSigner:computeAddress(hexlify(KEY)),sourceCommit:'56'.repeat(20)};
const destination = describeFileHandoffDestination(INPUT);
const keyPair = byte => () => {
  const privateKey = createPrivateKey({ key:Buffer.from('302e020100300506032b656e04220420'+byte.repeat(32),'hex'),format:'der',type:'pkcs8' });
  return {privateKey,publicKey:createPublicKey(privateKey)};
};
const fixture = (byte='11',now=()=>NOW) => ({fixtureAcknowledgement:QUOTE_HANDOFF_FIXTURE_ACK,
  keyPairFactory:keyPair(byte),randomBytesFactory:n=>Buffer.alloc(n,Number.parseInt(byte,16)),now});
function setup(t, patch={}) {
  const options={destination,...fixture(),...patch};
  const receiver=createReceiverSession(options); t.after(()=>receiver.close());
  const sender={...fixture('22'),expectedDestinationHash:destination.destinationHash,expectedChallengeHash:hashFileHandoffChallenge(receiver.challenge)};
  return {receiver,sender,capsule:()=>sealQuoteKey(KEY,receiver.challenge,sender)};
}
const expectCode = (fn,code) => assert.throws(fn,error=>error.code===code && error.message===code && !error.cause);

test('fixed public fixtures round-trip one exact32byte key with only ciphertext exposed',t=>{
  const {receiver,sender,capsule}=setup(t); const sealed=capsule();
  assert.equal(receiver.challenge.destination.quotePath,QUOTE_KEY_FILE);
  assert(Object.isFrozen(receiver.challenge));assert(Object.isFrozen(receiver.challenge.destination));assert(Object.isFrozen(sealed));
  assert.equal(validateFileHandoffChallenge(receiver.challenge,sender).destination.destinationHash,destination.destinationHash);
  assert.equal(sealed.challengeHash,hashFileHandoffChallenge(receiver.challenge));
  assert.deepEqual(Object.keys(sealed).sort(),['challengeHash','ciphertext','nonce','protocol','senderPublicKey','tag']);
  assert(!JSON.stringify(sealed).includes(KEY.toString('hex')));
  assert(!JSON.stringify(sealed).includes(KEY.toString('base64')));
  const opened=receiver.open(sealed);assert.deepEqual(opened,KEY);assert.notEqual(opened,KEY);opened.fill(0);
  expectCode(()=>receiver.open(sealed),'HANDOFF_ALREADY_USED');
  assert.equal(KEY.at(-1),1);
});

test('destination fields pin exact service origin path chain source and configuration',()=>{
  const desc=describeFileHandoffDestination(INPUT); assert.deepEqual(validateFileHandoffDestination(desc),desc);
  for(const patch of [{serviceId:'srv-other00000000'},{origin:'https://evil.example'},{origin:INPUT.origin+'/'},
    {configHash:'0xAB'+'34'.repeat(31)},{sourceCommit:'latest'},{quoteSigner:'0x'+'00'.repeat(20)},{extra:1}]) assert.throws(()=>describeFileHandoffDestination({...INPUT,...patch}));
  for(const patch of [{chainId:1},{provider:'other'},{quotePath:'/tmp/key'},{destinationHash:'00'.repeat(32)},{protocol:'other'},{quoteSigner:INPUT.quoteSigner}]) {
    if(patch.quoteSigner===desc.quoteSigner)continue;
    assert.throws(()=>validateFileHandoffDestination({...desc,...patch}));
  }
});

test('both destination and independently authenticated challenge pins are mandatory before encryption',t=>{
  const {receiver,sender}=setup(t);let calls=0;
  for(const patch of [{expectedDestinationHash:undefined},{expectedChallengeHash:undefined},{expectedDestinationHash:'00'.repeat(32)},{expectedChallengeHash:'00'.repeat(32)}]){
    assert.throws(()=>sealQuoteKey(KEY,receiver.challenge,{...sender,...patch,keyPairFactory:()=>{calls++;return keyPair('22')();}}));
  }
  const changed=structuredClone(receiver.challenge);changed.sessionId='aa'.repeat(32);
  expectCode(()=>sealQuoteKey(KEY,changed,sender),'HANDOFF_CHALLENGE_PIN_MISMATCH');
  assert.equal(calls,0);
});

test('default and mixed activation paths cannot generate transport authority under test',()=>{
  expectCode(()=>createReceiverSession({destination}),'HANDOFF_ACTIVATION_REQUIRED');
  expectCode(()=>createReceiverSession({destination,activation:QUOTE_HANDOFF_ACTIVATION}),'HANDOFF_NATIVE_FORBIDDEN_IN_TEST');
  expectCode(()=>createReceiverSession({destination,...fixture(),activation:QUOTE_HANDOFF_ACTIVATION}),'HANDOFF_FIXTURE_REQUIRED');
  expectCode(()=>createReceiverSession({destination,keyPairFactory:keyPair('11')}),'HANDOFF_FIXTURE_REQUIRED');
  const other=describeFileHandoffDestination({...INPUT,quoteSigner:'0x'+'12'.repeat(20)});
  expectCode(()=>createReceiverSession({destination:other,...fixture()}),'HANDOFF_FIXTURE_SIGNER_REQUIRED');
});

test('fixture encryption refuses nonpublic key material, wrong lengths and invalid keys',t=>{
  const {receiver,sender}=setup(t);
  expectCode(()=>sealQuoteKey(Buffer.alloc(31),receiver.challenge,sender),'HANDOFF_KEY_LENGTH');
  expectCode(()=>sealQuoteKey(Buffer.alloc(32,2),receiver.challenge,sender),'HANDOFF_FIXTURE_KEY_REQUIRED');
  expectCode(()=>sealQuoteKey('0x'+KEY.toString('hex'),receiver.challenge,sender),'HANDOFF_KEY_LENGTH');
});

test('expiry and unsafe clock values fail closed before crypto or acceptance',t=>{
  for(const ttlSeconds of [0,121,1.2,Infinity])expectCode(()=>createReceiverSession({destination,...fixture(),ttlSeconds}),'HANDOFF_EXPIRY');
  expectCode(()=>createReceiverSession({destination,...fixture('11',()=>NaN)}),'HANDOFF_CLOCK');
  let time=NOW;const {receiver,sender}=setup(t,{now:()=>time,ttlSeconds:1});const sealed=sealQuoteKey(KEY,receiver.challenge,{...sender,now:()=>time});
  time=NOW+1000;expectCode(()=>receiver.open(sealed),'HANDOFF_EXPIRED');expectCode(()=>receiver.open(sealed),'HANDOFF_ALREADY_USED');
  for(const current of [NOW-1,NOW+120000])expectCode(()=>sealQuoteKey(KEY,receiver.challenge,{...sender,now:()=>current}),'HANDOFF_EXPIRED');
});

test('every malformed capsule attempt consumes receiver even if authentication never begins',t=>{
  for(const changed of [null,{},[],{extra:'not a capsule'}]){
    const {receiver,capsule}=setup(t);const valid=capsule();assert.throws(()=>receiver.open(changed));
    expectCode(()=>receiver.open(valid),'HANDOFF_ALREADY_USED');
  }
});

test('tag ciphertext nonce sender and challenge tampering cannot return plaintext',t=>{
  for(const field of ['tag','ciphertext','nonce','senderPublicKey','challengeHash']){
    const {receiver,capsule}=setup(t);const sealed={...capsule()};
    if(field==='challengeHash')sealed[field]='00'.repeat(32);
    else {const bytes=Buffer.from(sealed[field],'base64');bytes[bytes.length-1]^=1;sealed[field]=bytes.toString('base64');}
    assert.throws(()=>receiver.open(sealed));expectCode(()=>receiver.open(sealed),'HANDOFF_ALREADY_USED');
  }
});

test('all-zero and low-order X25519 peers fail without plaintext or provider diagnostics',t=>{
  for(const raw of ['00'.repeat(32),'01'+'00'.repeat(31)]){
    const lowOrderPublic=Buffer.from('302a300506032b656e032100'+raw,'hex').toString('base64');
    const {receiver,sender,capsule}=setup(t);
    const challenge={...receiver.challenge,receiverPublicKey:lowOrderPublic};
    expectCode(()=>sealQuoteKey(KEY,challenge,{...sender,expectedChallengeHash:hashFileHandoffChallenge(challenge)}),'HANDOFF_DH_FAILED');
    const sealed={...capsule(),senderPublicKey:lowOrderPublic};
    expectCode(()=>receiver.open(sealed),'HANDOFF_DH_FAILED');
  }
});

test('strict base64, key type, exact fieldsets and accessors are rejected',t=>{
  const {receiver,sender,capsule}=setup(t);
  for(const patch of [{sessionId:'abc'},{extra:true},{protocol:'other'},{expiresAt:NOW+120001},{receiverPublicKey:'A'.repeat(60)}]) assert.throws(()=>sealQuoteKey(KEY,{...receiver.challenge,...patch},sender));
  const wrongKey=Buffer.from('302a300506032b6570032100'+'11'.repeat(32),'hex').toString('base64');
  expectCode(()=>hashFileHandoffChallenge({...receiver.challenge,receiverPublicKey:wrongKey}),'HANDOFF_KEY_TYPE');
  let read=false;const malicious={...INPUT};Object.defineProperty(malicious,'quoteSigner',{get(){read=true;throw Error('PRIVATE_GETTER');},enumerable:true});
  expectCode(()=>describeFileHandoffDestination(malicious),'HANDOFF_FIELDS');assert.equal(read,false);
  const withSymbol={...sender,[Symbol('hidden')]:1};expectCode(()=>sealQuoteKey(KEY,receiver.challenge,withSymbol),'HANDOFF_FIELDS');
  assert.throws(()=>receiver.open({...capsule(),extra:true}));
});

test('noncanonical and oversized capsule base64 cannot reach decryption',t=>{
  for(const [field,change] of [['nonce',s=>s+'\n'],['tag',s=>s.slice(0,-1)],['ciphertext',s=>s+'AAAA'],['senderPublicKey',s=>s+'=']]){
    const {receiver,capsule}=setup(t);const sealed=capsule();
    expectCode(()=>receiver.open({...sealed,[field]:change(sealed[field])}),'HANDOFF_ENCODING');
  }
});

test('caller mutation cannot alter a created session or its frozen destination',t=>{
  const mutable=structuredClone(destination);const options={destination:mutable,...fixture()};
  const receiver=createReceiverSession(options);t.after(()=>receiver.close());
  mutable.configHash='0x'+'aa'.repeat(32);options.now=()=>0;options.keyPairFactory=()=>{throw Error('MUTATED');};
  assert.equal(receiver.challenge.destination.configHash,destination.configHash);
  const capsule=sealQuoteKey(KEY,receiver.challenge,{...fixture('22'),expectedDestinationHash:destination.destinationHash,expectedChallengeHash:hashFileHandoffChallenge(receiver.challenge)});
  const result=receiver.open(capsule);assert.deepEqual(result,KEY);result.fill(0);
});

test('key factory failures are redacted and mismatched pairs cannot be accepted',()=>{
  expectCode(()=>createReceiverSession({destination,...fixture(),keyPairFactory:()=>{throw Error('SECRET_FACTORY_DATA');}}),'HANDOFF_INVALID');
  expectCode(()=>createReceiverSession({destination,...fixture(),randomBytesFactory:()=>Buffer.alloc(1)}),'HANDOFF_RANDOM_LENGTH');
  expectCode(()=>createReceiverSession({destination,...fixture(),keyPairFactory:()=>({privateKey:keyPair('11')().privateKey,publicKey:keyPair('22')().publicKey})}),'HANDOFF_KEY_PAIR');
});

test('close discards receiver authority without requiring a capsule',t=>{
  const {receiver,capsule}=setup(t);const sealed=capsule();receiver.close();receiver.close();
  expectCode(()=>receiver.open(sealed),'HANDOFF_ALREADY_USED');
});

test('the session also expires automatically while an idle receiver is waiting',async t=>{
  const {receiver,capsule}=setup(t,{ttlSeconds:1});const sealed=capsule();
  await new Promise(resolve=>setTimeout(resolve,1100));
  expectCode(()=>receiver.open(sealed),'HANDOFF_ALREADY_USED');
});
