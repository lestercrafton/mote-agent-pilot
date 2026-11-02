// Local in-process EVM only. GANACHE_MODULE points at an existing pinned 7.9.2
// installation. Never connects to a public RPC or signs for a real account.
import {readFileSync} from 'node:fs';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';import {AbiCoder,Interface,keccak256} from 'ethers';
import {PUBLIC_FIXTURE_PAYER,PUBLIC_FIXTURE_OPERATOR} from '../test/fixtures.mjs';
import {CONTRACT,wrapTyped} from '../test/contract-fixtures.mjs';
import {DeployedSignatureVerifier,ERC1271} from '../src/contract-signatures.mjs';
const require=createRequire(import.meta.url);assert(process.env.GANACHE_MODULE,'Existing GANACHE_MODULE required');
const ganache=require(process.env.GANACHE_MODULE);const fixture=JSON.parse(readFileSync(new URL('../test/contract-fixtures/coinbase-runtime.json',import.meta.url)));
assert.equal(keccak256(fixture.code),fixture.codeHash);
const p=ganache.provider({chain:{chainId:8453,hardfork:'shanghai'},wallet:{accounts:[{secretKey:PUBLIC_FIXTURE_PAYER.privateKey,balance:'0x3635c9adc5dea00000'}]},logging:{quiet:true}});
let checks=0;
try{
 await p.request({method:'evm_setAccountCode',params:[CONTRACT,fixture.code]});
 const init=new Interface(['function initialize(bytes[] owners)']);
 const data=init.encodeFunctionData('initialize',[[AbiCoder.defaultAbiCoder().encode(['address'],[PUBLIC_FIXTURE_PAYER.address])]]);
 const hash=await p.request({method:'eth_sendTransaction',params:[{from:PUBLIC_FIXTURE_PAYER.address,to:CONTRACT,data,gas:'0x100000'}]});
 assert.equal((await p.request({method:'eth_getTransactionReceipt',params:[hash]})).status,'0x1');checks++;
 // Ganache lacks EIP1898 state tags. This fixture-only adapter resolves a pinned
 // canonical hash to its block number; production uses EIP1898 unchanged.
 const rpc=async(method,params)=>{params=structuredClone(params);if(method==='eth_getBlockByNumber'&&params[0]==='finalized')params[0]='latest';
  if(['eth_call','eth_getCode'].includes(method)&&typeof params[1]==='object'){
   assert.equal(params[1].requireCanonical,true);const b=await p.request({method:'eth_getBlockByHash',params:[params[1].blockHash,false]});assert(b);const n=await p.request({method:'eth_getBlockByNumber',params:[b.number,false]});assert.equal(n.hash,b.hash);params[1]=b.number;
  }return p.request({method,params});};
 const verifier=new DeployedSignatureVerifier({network:'eip155:8453',rpc});
 const typedData={domain:{name:'Local fixture only — NOT A PAYMENT',version:'1',chainId:8453,verifyingContract:CONTRACT},types:{Check:[{name:'nonce',type:'uint256'}]},message:{nonce:'1'}};
 const sig=await wrapTyped(typedData);assert.equal((sig.length-2)/2,224);checks++;
 await verifier.verifyMany([{payer:CONTRACT,typedData,signature:sig}]);checks++;
 const altered=structuredClone(typedData);altered.message.nonce='2';await assert.rejects(verifier.verifyMany([{payer:CONTRACT,typedData:altered,signature:sig}]));checks++;
 await assert.rejects(verifier.verifyMany([{payer:CONTRACT,typedData,signature:await wrapTyped(typedData,CONTRACT,PUBLIC_FIXTURE_OPERATOR)}]));checks++;
 const [wrapper]=AbiCoder.defaultAbiCoder().decode(['tuple(uint256 ownerIndex,bytes signatureData)'],sig);
 await assert.rejects(verifier.verifyMany([{payer:CONTRACT,typedData,signature:wrapper.signatureData}]));checks++;
 await assert.rejects(verifier.verifyMany([{payer:CONTRACT,typedData,signature:sig.slice(0,-64)}]));checks++;
 console.log(JSON.stringify({status:'PASS',checks,fixture:'actual pinned Coinbase implementation bytecode on in-process synthetic EVM',runtimeHash:fixture.codeHash,wrapperBytes:224,rawSignaturesPrinted:false,publicTransactions:0}));
}finally{await p.disconnect();}
