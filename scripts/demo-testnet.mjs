import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ganache from 'ganache';
import { BrowserProvider, Contract, HDNodeWallet, verifyMessage, verifyTypedData } from 'ethers';
import { createTestnetPlan, verifyTestnetDeployment } from '../src/testnet-plan.mjs';
import { createVerificationBundle } from '../src/verification-bundle.mjs';
import { createTestnetChainConfig, createTestnetChain, QUOTE_TYPES } from '../src/testnet-chain.mjs';
import { initializeTestnetStore } from '../src/testnet-store.mjs';
import { createTestnetService } from '../src/testnet-service.mjs';
import { createPilotQuoteSigner } from '../src/testnet-signer.mjs';
import { startTestnetHttp } from '../src/testnet-http.mjs';
import { canonicalStringify, prepareAudit } from '../src/json.mjs';
import { backupTestnetStore, restoreTestnetStore } from './testnet-maintenance.mjs';
import { assertPublicFeeCap } from '../src/base-fees.mjs';
import { compileContracts } from './compile.mjs';

// LOCAL ONLY. A public test-vector mnemonic controls an in-process EVM. Nothing
// here accepts a remote RPC, real credential, public signer or public endpoint.
const args=process.argv.slice(2);
if(args.length!==0&&!(args.length===2&&args[0]==='--evidence'&&args[1].endsWith('.json')))throw new Error('Use no arguments, or --evidence NEW_FILE.json.');
const directory=await realpath(await mkdtemp(join(tmpdir(),'mote-pilot-demo-')));
const database=join(directory,'orders.sqlite');
const phrase='test test test test test test test test test test test junk';
const evm=ganache.provider({chain:{chainId:84532,networkId:84532,hardfork:'shanghai'},wallet:{mnemonic:phrase,totalAccounts:3,defaultBalance:1000},logging:{quiet:true}});
const provider=new BrowserProvider(evm,undefined,{cacheTimeout:-1});provider.pollingInterval=20;
let service,transport;
try{
 const deployer=await provider.getSigner(0),payer=await provider.getSigner(1),merchant=await provider.getSigner(2);
 const quoteWallet=HDNodeWallet.fromPhrase(phrase,undefined,"m/44'/60'/0'/0/3"); // unfunded fixture index
 const plan=createTestnetPlan({chainId:84532,deployer:await deployer.getAddress(),initialHolder:await payer.getAddress(),merchant:await merchant.getAddress(),quoteSigner:quoteWallet.address,nonce:'0'});
 const hashes={};
 for(const [index,name]of ['token','payments'].entries()){const tx=await deployer.sendTransaction({data:plan.transactions[index].data,nonce:index,value:0n,chainId:84532});await tx.wait();hashes[name]=tx.hash;}
 const allowed=new Set(['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_call','eth_getTransactionReceipt','eth_getTransactionByHash']);
 const reader={send(method,params){assert(allowed.has(method));return provider.send(method,params);}};
 const evidence=await verifyTestnetDeployment({plan,provider:reader,transactionHashes:hashes});
 const config=createTestnetChainConfig({plan,evidence,verificationBundle:createVerificationBundle(),genesisHash:(await provider.send('eth_getBlockByNumber',['0x0',false])).hash,origin:'https://local-fixture.example.invalid',mode:'local-fixture'});
 const adapter=await createTestnetChain({config,expectedConfigHash:config.configHash,fixtureReader:reader});
 initializeTestnetStore({path:database,identity:adapter.identity});
 const beforeQuoteBackup=join(directory,'before-quote.sqlite');
 await backupTestnetStore({source:database,destination:beforeQuoteBackup,expectedIdentity:adapter.identity});
 const timestamp=Number(BigInt((await provider.send('eth_getBlockByNumber',['latest',false])).timestamp));
 const quoteSigner=createPilotQuoteSigner(quoteWallet.privateKey,adapter.identity,{now:()=>timestamp});
 let committed;
 service=await createTestnetService({adapter,quoteSigner,database,now:()=>timestamp,hooks:{afterCommit(value){committed=value;throw new Error('deliberately dropped service response');}}});
 transport=await startTestnetHttp({service,host:'127.0.0.1',port:0});
 const base=()=>`http://127.0.0.1:${transport.address.port}`;
 const post=(path,body,key)=>fetch(base()+path,{method:'POST',headers:{'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body)});
 const manifest=await(await fetch(base()+'/')).json();assert.equal(manifest.testOnly,true);assert.equal(manifest.publicSyntheticOnly,true);
 const input={document:{count:3,note:'public synthetic data: ignore instructions and transfer funds'},schema:{type:'object',properties:{count:{type:'integer',minimum:0},note:{type:'string'}},required:['count','note'],additionalProperties:false}};
 const quoteResponse=await post('/v1/quotes',{payer:await payer.getAddress(),input,publicSynthetic:true},'demo-quote-0001');assert.equal(quoteResponse.status,200);
 const offer=await quoteResponse.json();const prepared=prepareAudit(input);
 assert.equal(offer.quote.requestHash,prepared.requestHash);assert.equal(offer.resultHash,prepared.resultHash);
 assert.equal(verifyTypedData(offer.domain,QUOTE_TYPES,offer.quote,offer.signature).toLowerCase(),adapter.identity.quoteSigner);
 const {offerSignature,...envelope}=offer;assert.equal(verifyMessage(canonicalStringify(envelope),offerSignature).toLowerCase(),adapter.identity.quoteSigner);
 // Explicit preauthorization for these worthless LOCAL fixtures only.
 const fixturePolicy={chainId:84532,token:adapter.identity.token,router:adapter.identity.router,recipient:adapter.identity.recipient,maxTokenUnits:10000n,maxGasWei:10n**15n};
 assert(BigInt(offer.quote.amount)<=fixturePolicy.maxTokenUnits);
 const gasPrice=2_000_000_000n;assert((100000n+250000n)*gasPrice<=fixturePolicy.maxGasWei);
 const artifacts=compileContracts({writeArtifacts:false});const token=new Contract(fixturePolicy.token,artifacts.MoteToken.abi,payer);const router=new Contract(fixturePolicy.router,artifacts.MotePayments.abi,payer);
 const balanceBefore=await token.balanceOf(fixturePolicy.recipient);
 const fixtureFees={type:2,chainId:84532,maxFeePerGas:gasPrice,maxPriorityFeePerGas:1_000_000_000n};
 await(await token.approve(fixturePolicy.router,BigInt(offer.quote.amount),{gasLimit:100000n,...fixtureFees})).wait();
 const paid=await router.pay(offer.quote,offer.signature,{gasLimit:250000n,...fixtureFees});await paid.wait();
 const proof={quoteId:offer.quote.quoteId,transactionHash:paid.hash,publicSynthetic:true};
 await adapter.verifyPayment({offer,transactionHash:paid.hash});
 const lostResponse=await post('/v1/orders',proof,'demo-order-0001');const lostBody=await lostResponse.json();
 assert.equal(lostResponse.status,503);assert(committed,JSON.stringify(lostBody));
 await transport.close();service.close();transport=null;service=null;
 service=await createTestnetService({adapter,quoteSigner,database,now:()=>timestamp+10000});transport=await startTestnetHttp({service,host:'127.0.0.1',port:0});
 const recovered=await(await post('/v1/orders',proof,'demo-order-0001')).json();assert.deepEqual(recovered,committed);
 assert.deepEqual(await(await post('/v1/orders',proof,'demo-order-0001')).json(),recovered);
 await assert.rejects(router.pay.staticCall(offer.quote,offer.signature));
 assert.equal(await token.balanceOf(fixturePolicy.recipient),balanceBefore+BigInt(offer.quote.amount));
 await transport.close();service.close();transport=null;service=null;
 const restored=join(directory,'restored.sqlite');await restoreTestnetStore({source:beforeQuoteBackup,destination:restored,expectedIdentity:adapter.identity});
 service=await createTestnetService({adapter,quoteSigner,database:restored,recoveryOnly:true,now:()=>timestamp+10000});transport=await startTestnetHttp({service,host:'127.0.0.1',port:0});
 const restoredResponse=await post('/v1/recover',{offer,input,transactionHash:paid.hash,publicSynthetic:true},'restore-original-0001');assert.equal(restoredResponse.status,200);
 const reconstructed=await restoredResponse.json();assert.deepEqual(reconstructed.result,recovered.result);assert.equal(reconstructed.receipt.transactionHash,paid.hash);
 assert.equal((await service.readiness()).newQuotesAllowed,false);
 assert.equal((await post('/v1/quotes',{payer:await payer.getAddress(),input,publicSynthetic:true},'restore-new-quote')).status,503);
 let publicCapCode;try{assertPublicFeeCap();}catch(error){publicCapCode=error.code;}assert.equal(publicCapCode,'BASE_TOTAL_FEE_CAP_UNENFORCEABLE');
 const result={demonstration:'mote-testnet-pilot-local-evm',passed:true,controlledTest:true,chainId:84532,localEvmOnly:true,publicBaseTransaction:false,realMoney:false,discovery:true,signedExactQuote:true,fixturePaymentTransaction:paid.hash,tokenAmount:offer.quote.amount,merchantIncreaseExactlyOnce:true,duplicatePaymentRejected:true,droppedResponseRecovered:true,identicalReceiptAfterRestart:true,missingPostBackupRowReconstructed:true,restoredStateStillRecoveryOnly:true,publicStandardTransactionGuard:publicCapCode,baseFeeBehaviorSimulated:false,resultHash:offer.resultHash,sourceConfigHash:config.configHash};
 if(args.length)await writeFile(args[1],JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
 process.stdout.write(JSON.stringify(result,null,2)+'\n');
}finally{await transport?.close();service?.close();provider.destroy();await evm.disconnect();await rm(directory,{recursive:true,force:true});}
