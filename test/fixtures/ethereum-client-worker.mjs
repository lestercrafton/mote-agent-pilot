// Loopback-only child. Uses the same real Ethereum client/fee code as production.
import { JsonRpcProvider } from 'ethers';
import { TestnetMoteClient, LOCAL_FIXTURE_ACKNOWLEDGMENT } from '../../src/testnet-client.mjs';
import { TestnetBudgetJournal } from '../../src/testnet-journal.mjs';
import { createTestnetChain } from '../../src/testnet-chain.mjs';
const READ=new Set(['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_call','eth_getTransactionReceipt','eth_getTransactionByHash','eth_getBalance','eth_getTransactionCount']);
process.once('message',async job=>{
  let provider,journal;
  try{
    if(new URL(job.rpcUrl).hostname!=='127.0.0.1')throw new Error('Loopback fixture only');
    provider=new JsonRpcProvider(job.rpcUrl,undefined,{cacheTimeout:-1,batchMaxCount:1});
    const reader={readOnly:true,endpoint:job.rpcUrl,send(method,params){if(!READ.has(method))throw new Error('Read only');return provider.send(method,params);}};
    const chain=await createTestnetChain({config:job.config,expectedConfigHash:job.config.configHash,fixtureReader:reader});
    journal=new TestnetBudgetJournal(job.options);
    const client=TestnetMoteClient.forLocalFixture({acknowledgment:LOCAL_FIXTURE_ACKNOWLEDGMENT,localServiceOrigin:job.localServiceOrigin,baseUrl:job.baseUrl,policy:job.options.policy,chain,reader,journal,finalityWaitMs:0,signer:await provider.getSigner(1)});
    const offer=await client.quote(job.input,job.quoteKey,{publicSynthetic:true});
    const response=await client.execute(offer,job.orderKey);
    process.stdout.write(JSON.stringify({ok:true,offer,response,budget:client.budget}));
  }catch(error){process.stdout.write(JSON.stringify({ok:false,error:{code:error.code,message:error.message},budget:journal?.budget()}));}
  finally{journal?.close();provider?.destroy();process.disconnect();}
});
