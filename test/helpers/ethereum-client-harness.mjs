// Actual local EVM + loopback RPC/HTTP. No public network, real balances, or
// persistent credentials. The production Ethereum fee/client code runs intact.
import ganache from 'ganache';
import { Contract, HDNodeWallet, JsonRpcProvider } from 'ethers';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileContracts } from '../../scripts/compile.mjs';
import { createTestnetPlan, verifyTestnetDeployment } from '../../src/testnet-plan.mjs';
import { createVerificationBundle } from '../../src/verification-bundle.mjs';
import { createTestnetChainConfig, createTestnetChain } from '../../src/testnet-chain.mjs';
import { createTestnetService } from '../../src/testnet-service.mjs';
import { initializeTestnetStore } from '../../src/testnet-store.mjs';
import { startTestnetHttp } from '../../src/testnet-http.mjs';
import { hashJson } from '../../src/json.mjs';
import { TestnetMoteClient, testnetIdentity, LOCAL_FIXTURE_ACKNOWLEDGMENT } from '../../src/testnet-client.mjs';
import { TestnetBudgetJournal } from '../../src/testnet-journal.mjs';

const PUBLIC_FIXTURE = 'test test test test test test test test test test test junk';
const READ = new Set(['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_call','eth_getTransactionReceipt','eth_getTransactionByHash','eth_getBalance','eth_getTransactionCount']);
export async function createEthereumClientHarness() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'mote-ethereum-client-')));
  const server = ganache.server({ chain:{ chainId:11155111, networkId:11155111, hardfork:'shanghai' }, wallet:{ mnemonic:PUBLIC_FIXTURE, totalAccounts:5 }, logging:{quiet:true}, miner:{timestampIncrement:1} });
  let provider, service, http;
  const journals=[];
  try {
    await server.listen(0,'127.0.0.1');
    const rpcUrl=`http://127.0.0.1:${server.address().port}`;
    provider=new JsonRpcProvider(rpcUrl,undefined,{cacheTimeout:-1,batchMaxCount:1});provider.pollingInterval=20;
    const deployer=await provider.getSigner(0),payer=await provider.getSigner(1),merchant=await provider.getSigner(2);
    const quoteSigner=HDNodeWallet.fromPhrase(PUBLIC_FIXTURE,undefined,"m/44'/60'/0'/0/3");
    const reader={endpoint:rpcUrl,readOnly:true,async send(method,params=[]){if(!READ.has(method))throw new Error('Fixture reader forbids writes');return provider.send(method,params);}};
    const plan=createTestnetPlan({chainId:11155111,deployer:await deployer.getAddress(),initialHolder:await payer.getAddress(),merchant:await merchant.getAddress(),quoteSigner:quoteSigner.address,nonce:'0'});
    const hashes={};
    for(const [index,key]of ['token','payments'].entries()){
      const tx=await deployer.sendTransaction({chainId:11155111,nonce:index,value:0n,data:plan.transactions[index].data});await tx.wait();hashes[key]=tx.hash;
    }
    const evidence=await verifyTestnetDeployment({plan,provider:reader,transactionHashes:hashes});
    const baseUrl='https://fixture.example.invalid';
    const config=createTestnetChainConfig({plan,evidence,verificationBundle:createVerificationBundle(),genesisHash:(await reader.send('eth_getBlockByNumber',['0x0',false])).hash,origin:baseUrl,mode:'local-fixture'});
    const chain=await createTestnetChain({config,expectedConfigHash:config.configHash,fixtureReader:reader});
    const db=join(directory,'service.sqlite');initializeTestnetStore({path:db,identity:chain.identity});
    service=await createTestnetService({adapter:chain,quoteSigner,database:db,ttlSeconds:600});
    http=await startTestnetHttp({service,host:'127.0.0.1',port:0});
    const localServiceOrigin=`http://127.0.0.1:${http.address.port}`;
    const policy={enabled:true,chainId:11155111,payer:(await payer.getAddress()).toLowerCase(),token:chain.identity.token,router:chain.identity.router,recipient:chain.identity.recipient,quoteSigner:chain.identity.quoteSigner,serviceOrigin:baseUrl,publicSynthetic:true,configHash:config.configHash,deploymentAnchorHash:hashJson(config.deployments),maxSingleSpend:'10000',maxTotalSpend:'50000',maxGasPerTransactionWei:'1000000000000000',maxGasTotalWei:'10000000000000000',maxFeePerGas:'2000000000',maxPriorityFeePerGas:'1000000000'};
    const artifacts=compileContracts({writeArtifacts:false}),token=new Contract(policy.token,artifacts.MoteToken.abi,provider),payments=new Contract(policy.router,artifacts.MotePayments.abi,provider);
    let sequence=0;
    return {directory,rpcUrl,baseUrl,localServiceOrigin,reader,provider,payer,chain,config,policy,token,payments,service,
      makeClient(overrides={},signer=payer){
        const options={path:join(directory,`budget-${++sequence}.sqlite`),policyId:`ethereum-fixture-${sequence}`,policy:{...policy,...overrides},chainIdentity:testnetIdentity(chain)};
        const journal=TestnetBudgetJournal.initialize(options);journals.push(journal);
        const clientOptions={acknowledgment:LOCAL_FIXTURE_ACKNOWLEDGMENT,localServiceOrigin,baseUrl,reader,chain,policy:options.policy,journal,signer,finalityWaitMs:0};
        return {client:TestnetMoteClient.forLocalFixture(clientOptions),journal,options,clientOptions,reopen(){const j=new TestnetBudgetJournal(options);journals.push(j);return j;}};
      },
      async close(){for(const j of journals)try{j.close();}catch{}await http?.close();service?.close();provider?.destroy();await server.close();rmSync(directory,{recursive:true,force:true});}
    };
  }catch(error){await http?.close().catch(()=>{});service?.close();provider?.destroy();await server.close().catch(()=>{});rmSync(directory,{recursive:true,force:true});throw error;}
}

export function startEthereumWorker(job) {
  const child=fork(fileURLToPath(new URL('../fixtures/ethereum-client-worker.mjs',import.meta.url)),[],{stdio:['ignore','pipe','pipe','ipc']});
  let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
  const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>{try{resolve({code,stdout,stderr,result:JSON.parse(stdout)});}catch(e){reject(new Error(`Worker output invalid: ${stdout} ${stderr}`,{cause:e}));}});});
  child.send(job);return{child,done};
}
