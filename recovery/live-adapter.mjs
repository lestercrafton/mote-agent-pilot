import { R1, assertRecoveryTime, recoverySourceCommit, recoverySourceManifest } from '../src/recovery-r1-policy.mjs';
import{randomBytes}from'node:crypto';
import{readFileSync,writeFileSync,openSync,closeSync,fsyncSync}from'node:fs';
import{join}from'node:path';
import{fileURLToPath}from'node:url';
import{Wallet,hexlify,getAddress}from'../node_modules/ethers/lib.esm/index.js';
import{createBootstrapPlan}from'../src/bootstrap-plan.mjs';
import{initializeBootstrapJournal,createRecoveryBootstrapRunner}from'../src/bootstrap-runner.mjs';
import{createEthereumSepoliaReader}from'../src/testnet-rpc.mjs';
import {openKeychainSigner,KEYCHAIN_ACTIVATION} from './keychain-custody.mjs';
import {openRecoveryOperatorSigner} from './operator-signer.mjs';
import{createTestnetPlan,verifyTestnetDeployment}from'../src/testnet-plan.mjs';
import{createVerificationBundle}from'../src/verification-bundle.mjs';
import{createTestnetChainConfig,createTestnetChain}from'../src/testnet-chain.mjs';
import{createDispenserPlan}from'../src/dispenser-plan.mjs';
import{verifyDispenserDeployment,createDispenserConfig,createDispenserChain}from'../src/dispenser-chain.mjs';
import{TestnetBudgetJournal}from'../src/testnet-journal.mjs';
import{TestnetMoteClient,testnetIdentity}from'../src/testnet-client.mjs';
import{ClaimBudgetJournal}from'../src/claim-journal.mjs';
import{ClaimThenPayClient}from'../src/claim-client.mjs';
import{prepareAudit,hashJson}from'../src/json.mjs';
import{ACTIVATION}from'./controller.mjs';
import{verifyLaunchPins,verifyNativePrerequisites}from'./verify-pins.mjs';
import{createExactPayerSigner,broadcastPayerTransaction}from'./payer-signer.mjs';
import{checkPaidHost}from'./check-host.mjs';
import{verifyProvisionedRoles,verifyOriginalRecoveryState}from'./verify-pins.mjs';
import pins from'./pins.json'with{type:'json'};

const KEY='mote-v072-approved-fixed-job';
export const LIVE_SESSION_DIRECTORY=fileURLToPath(new URL('./runtime/ethereum-sepolia-r1-p2',import.meta.url));
const fail=code=>{const e=new Error(code);e.code=code;throw e;};
const check=(v,c='LAUNCH_SCOPE')=>{if(!v)fail(c);};
const address=v=>getAddress(v).toLowerCase();
const exact=(v,keys)=>check(v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join()===keys.slice().sort().join());
function save(path,value){const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}}
function freshEvidence(input,sourceCommit,now){
 exact(input,['serviceId','origin','sourceCommit','sourceManifestSha256','observedAt','mode','quoteKeyConfigured']);
 check(input.serviceId===pins.serviceId&&input.origin===pins.origin&&input.sourceCommit===sourceCommit&&input.sourceManifestSha256===recoverySourceManifest()&&input.mode==='maintenance'&&input.quoteKeyConfigured===false,'LAUNCH_HOST_PIN');
 check(Number.isSafeInteger(input.observedAt)&&input.observedAt<=now&&now-input.observedAt<=900000,'LAUNCH_HOST_EVIDENCE_STALE');
}
function memoryWallet(){
 for(let i=0;i<4;i++){const bytes=randomBytes(32);try{if(bytes.equals(Buffer.from('00'.repeat(31)+'01','hex')))continue;return new Wallet(hexlify(bytes));}catch{}finally{bytes.fill(0);}}
 fail('LAUNCH_PAYER_GENERATION');
}
const core={verifyLaunchPins,verifyNativePrerequisites,verifyProvisionedRoles,verifyOriginalRecoveryState,createEthereumSepoliaReader,openKeychainSigner,createBootstrapPlan,initializeBootstrapJournal,createRecoveryBootstrapRunner,
 createTestnetPlan,verifyTestnetDeployment,createVerificationBundle,createTestnetChainConfig,createTestnetChain,createDispenserPlan,verifyDispenserDeployment,createDispenserConfig,createDispenserChain,
 TestnetBudgetJournal,TestnetMoteClient,testnetIdentity,ClaimBudgetJournal,ClaimThenPayClient,memoryWallet,createExactPayerSigner,broadcastPayerTransaction,checkPaidHost,now:()=>Date.now()};

export function createLiveAdapter(options){return build(options,core,false);}
// Public fixtures/mocks only; no CLI switch exists and production refuses this.
export function createMockLiveAdapter(options,dependencies){
 check(process.env.NODE_TEST_CONTEXT&&dependencies?.acknowledgement==='PUBLIC_FIXTURES_ONLY_NO_NATIVE_OR_NETWORK','LAUNCH_MOCK_DENIED');
 const{acknowledgement,...overrides}=dependencies;
 check(Object.keys(overrides).sort().join()===Object.keys(core).sort().join(),'LAUNCH_MOCK_INCOMPLETE');
 for(const k of Object.keys(core))check(overrides[k]!==core[k]&&(['TestnetBudgetJournal','ClaimBudgetJournal'].includes(k)?typeof overrides[k]?.initialize==='function':typeof overrides[k]==='function'),'LAUNCH_MOCK_INCOMPLETE');
 // No fallback to core: every effectful capability must be explicit fixture code.
 return build(options,Object.freeze({...overrides}),true);
}
function build(options,d,mock){
 exact(options,['activation','sourceCommit','operator','quoteSigner','hostEvidence']);
 const o=structuredClone(options);check(o.activation===ACTIVATION&&o.sourceCommit===recoverySourceCommit(),'LAUNCH_ACTIVATION_REQUIRED');
 o.operator=address(o.operator);o.quoteSigner=address(o.quoteSigner);check(o.operator!==o.quoteSigner);check(mock||(o.operator===R1.operator&&o.quoteSigner===R1.quoteSigner),'R1_ROLE_PIN');
 let initialized=false,closed=false,runner,payer,reader,plan,config,dispenserConfig,chain,dispenserChain,paymentJournal,claimJournal,client,jobAttempted=false;
 let originalInput,root;
 const custody=role=>({role,chainId:11155111,activation:KEYCHAIN_ACTIVATION,helperPath:fileURLToPath(new URL('../../mote-fresh-custody-candidate-v073/helper',import.meta.url)),expectedHelperSha256:pins.helperSha256});
 const active=()=>check(initialized&&!closed,'LAUNCH_ADAPTER_STATE');
 const summarize=result=>{
  if(result?.status&&result.noTransactionsSubmittedDuringRecovery===true){check(['claim_finalized_no_payment','cancelled_before_submission'].includes(result.status),'LAUNCH_RECOVERY_RESULT');return{status:result.status,noTransactionsSubmitted:true};}
  const r=result?.receipt,v=result?.result;check(r?.amount==='4200'&&r.requestHash===pins.requestHash&&r.resultHash===pins.resultHash&&v?.valid===true&&v.canonicalJson==='{"arguments":{"a":2,"b":3},"tool":"sum"}','LAUNCH_RESULT');
  return{quoteId:r.quoteId,transactionHash:r.transactionHash,amount:r.amount,requestHash:r.requestHash,resultHash:r.resultHash,valid:v.valid,canonicalJson:v.canonicalJson};
 };
 return Object.freeze({
  async initialize(directory){
   check(!initialized&&!closed,'LAUNCH_ADAPTER_STATE');assertRecoveryTime(d.now());check(mock||!process.env.NODE_TEST_CONTEXT,'LAUNCH_NATIVE_FORBIDDEN_IN_TEST');
   check(mock||directory===LIVE_SESSION_DIRECTORY,'LAUNCH_FIXED_SESSION_DIRECTORY');
   d.verifyLaunchPins();d.verifyNativePrerequisites();d.verifyOriginalRecoveryState();d.verifyProvisionedRoles({operator:o.operator,quoteSigner:o.quoteSigner});freshEvidence(o.hostEvidence,o.sourceCommit,d.now());
   // All metadata/source/native preconditions above precede custody and entropy.
   root=directory;reader=d.createEthereumSepoliaReader();check(reader.readOnly===true&&reader.endpoint===pins.rpc,'LAUNCH_READER');
   const quote=await d.openKeychainSigner(custody('quote-backup'));check(address(await quote.getAddress())===o.quoteSigner,'LAUNCH_QUOTE_ROLE');
   const [id,genesis]=await Promise.all([reader.send('eth_chainId',[]),reader.send('eth_getBlockByNumber',['0x0',false])]);check(BigInt(id)===11155111n&&genesis?.hash===pins.genesisHash,'LAUNCH_CHAIN');
   for(const a of [o.operator,o.quoteSigner]){check(await reader.send('eth_getCode',[a,'latest'])==='0x','LAUNCH_ROLE_CODE');for(const tag of ['pending','latest'])check(BigInt(await reader.send('eth_getTransactionCount',[a,tag]))===(a===o.operator?2n:0n),'LAUNCH_ROLE_NONCE');}
   check(BigInt(await reader.send('eth_getBalance',[o.quoteSigner,'latest']))===0n,'LAUNCH_QUOTE_FUNDED');
   for(const tag of ['pending','latest'])check(BigInt(await reader.send('eth_getTransactionCount',[R1.originalPayer,tag]))===0n,'R1_OLD_PAYER_USED');
   check(await reader.send('eth_getCode',[R1.originalPayer,'latest'])==='0x'&&BigInt(await reader.send('eth_getBalance',[R1.originalPayer,'latest']))===0n,'R1_OLD_PAYER_USED');
   assertRecoveryTime(d.now());payer=d.memoryWallet();const p=address(payer.address);check(p!==o.operator&&p!==o.quoteSigner&&p!==R1.originalPayer,'LAUNCH_ROLE_CONFLICT');
   save(join(root,'payer-public.json'),{schema:'mote-ephemeral-payer-public-v1',address:p,keyPersisted:false,automaticReplacementAllowed:false});
   check(await reader.send('eth_getCode',[p,'latest'])==='0x'&&BigInt(await reader.send('eth_getBalance',[p,'latest']))===0n,'LAUNCH_PAYER_FRESH');for(const tag of ['pending','latest'])check(BigInt(await reader.send('eth_getTransactionCount',[p,tag]))===0n,'LAUNCH_PAYER_FRESH');
   plan=d.createBootstrapPlan({chainId:11155111,operator:o.operator,merchant:o.operator,quoteSigner:o.quoteSigner,payer:p,operatorNonce:'0',payerNativeWei:'7000000000000000'});
   check(plan.policy.combinedMaximumWei===pins.allocationPlusFeesWei&&plan.transactions.length===5&&plan.roles.operator===o.operator&&plan.roles.merchant===o.operator&&plan.roles.quoteSigner===o.quoteSigner&&plan.roles.payer===p,'LAUNCH_EXACT_PLAN');
   const permissions={schema:'mote-bootstrap-authorization-v1',enabled:true,planHash:plan.planHash,policyHash:plan.policyHash,chainId:11155111,operator:o.operator,maximumTotalNativeWei:plan.policy.maxTotalNativeWei,expiresAt:Math.floor(R1.expiresAt/1000)};
   save(join(root,'bootstrap-plan.json'),plan);save(join(root,'bootstrap-authorization.json'),permissions);
   const allowedTransactions=plan.transactions.map(({transaction:{from,...tx}})=>tx);
   const signer=await openRecoveryOperatorSigner({nativeOptions:custody('bootstrap'),allowedTransactions,openSigner:d.openKeychainSigner});check(address(await signer.getAddress())===o.operator,'LAUNCH_OPERATOR_ROLE');
   d.initializeBootstrapJournal({path:join(root,'bootstrap.sqlite'),plan});
   runner=await d.createRecoveryBootstrapRunner({path:join(root,'bootstrap.sqlite'),plan,authorization:permissions,signer});
   originalInput=JSON.parse(readFileSync(new URL('../docs/SIGNER-EIGHT-TRANSACTIONS.json',import.meta.url),'utf8')).publicSyntheticJob.input;
   const prepared=prepareAudit(originalInput);check(prepared.requestHash===pins.requestHash&&prepared.resultHash===pins.resultHash&&String(prepared.amount)==='4200','LAUNCH_FIXED_INPUT');
   initialized=true;return{operator:o.operator,quoteSigner:o.quoteSigner,payer:p,planHash:plan.planHash};
  },
  async bootstrapAdopt(){active();return runner.adoptNext();},
  async bootstrapNext(){active();assertRecoveryTime(d.now());return runner.advance();},
  async bootstrapReconcile(){active();return runner.reconcile();},
  bootstrapStatus(){active();return runner.status();},
  async prepareConfiguration(){
   active();check(!config&&!dispenserConfig,'LAUNCH_CONFIGURATION_EXISTS');const status=await runner.reconcile();check(status.complete,'LAUNCH_BOOTSTRAP_INCOMPLETE');
   const deploymentPlan=d.createTestnetPlan({chainId:11155111,deployer:o.operator,initialHolder:o.operator,merchant:o.operator,quoteSigner:o.quoteSigner,nonce:'0'});
   const evidence=await d.verifyTestnetDeployment({plan:deploymentPlan,provider:reader,transactionHashes:{token:status.steps[0].transactionHash,payments:status.steps[1].transactionHash}});
   config=d.createTestnetChainConfig({plan:deploymentPlan,evidence,verificationBundle:d.createVerificationBundle(),origin:pins.origin,genesisHash:pins.genesisHash,mode:'ethereum-sepolia'});
   chain=await d.createTestnetChain({config,expectedConfigHash:config.configHash});
   const dispenserPlan=d.createDispenserPlan({chainId:11155111,token:config.deployments.token.address,tokenRuntimeHash:config.deployments.token.runtimeCodeHash,deployer:o.operator,nonce:'2',claimAmount:'10000000',distributionCap:'10000000000'});
   const dispenserEvidence=await d.verifyDispenserDeployment({baseConfig:config,expectedBaseConfigHash:config.configHash,plan:dispenserPlan,transactionHashes:{deployment:status.steps[2].transactionHash,funding:status.steps[3].transactionHash}});
   dispenserConfig=d.createDispenserConfig({baseConfig:config,plan:dispenserPlan,evidence:dispenserEvidence});
   dispenserChain=await d.createDispenserChain({config:dispenserConfig,expectedConfigHash:dispenserConfig.configHash,baseConfig:config,expectedBaseConfigHash:config.configHash});
   save(join(root,'deployment.json'),config);save(join(root,'dispenser.json'),dispenserConfig);
   save(join(root,'public-config-pins.json'),{serviceId:pins.serviceId,origin:pins.origin,sourceCommit:o.sourceCommit,configHash:config.configHash,dispenserConfigHash:dispenserConfig.configHash});
   return{configHash:config.configHash,dispenserConfigHash:dispenserConfig.configHash};
  },
  async executeFixedJob(){
   active();assertRecoveryTime(d.now());check(config&&dispenserConfig&&!jobAttempted,'LAUNCH_PAYER_ALREADY_ATTEMPTED');jobAttempted=true;
   await d.checkPaidHost({identity:chain.identity,dispenserIdentity:dispenserChain.identity});
   check(await reader.send('eth_getCode',[payer.address,'latest'])==='0x','LAUNCH_PAYER_FRESH');for(const tag of ['pending','latest'])check(BigInt(await reader.send('eth_getTransactionCount',[payer.address,tag]))===0n,'LAUNCH_PAYER_NONCE');
   const policy={enabled:true,chainId:11155111,payer:address(payer.address),token:chain.identity.token,router:chain.identity.router,recipient:o.operator,quoteSigner:o.quoteSigner,serviceOrigin:pins.origin,publicSynthetic:true,configHash:config.configHash,deploymentAnchorHash:hashJson(config.deployments),maxSingleSpend:'4200',maxTotalSpend:'4200',maxGasPerTransactionWei:'1000000000000000',maxGasTotalWei:'2000000000000000',maxFeePerGas:'2000000000',maxPriorityFeePerGas:'1000000000'};
   const claimPolicy={enabled:true,chainId:11155111,payer:policy.payer,serviceOrigin:pins.origin,baseConfigHash:config.configHash,dispenserConfigHash:dispenserConfig.configHash,dispenser:dispenserChain.identity.dispenser,claimGasLimit:'500000',maxFeePerGas:'2000000000',maxPriorityFeePerGas:'1000000000',maxClaimGasWei:'1000000000000000',maxPaymentGasWei:'2000000000000000',maxTotalGasWei:'3000000000000000'};
   paymentJournal=d.TestnetBudgetJournal.initialize({path:join(root,'payer-payment.sqlite'),policyId:'mote-v072-single-payment',policy,chainIdentity:d.testnetIdentity(chain)});
   claimJournal=d.ClaimBudgetJournal.initialize({path:join(root,'payer-claim.sqlite'),policyId:'mote-v072-single-claim',policy:claimPolicy,paymentJournal,dispenserIdentity:dispenserChain.identity});
   const signer=d.createExactPayerSigner({wallet:payer,roles:{operator:o.operator,payer:policy.payer,quoteSigner:o.quoteSigner},contracts:{token:policy.token,router:policy.router,dispenser:claimPolicy.dispenser},broadcast:d.broadcastPayerTransaction});
   const paymentClient=new d.TestnetMoteClient({baseUrl:pins.origin,signer,reader,chain,policy,journal:paymentJournal,finalityWaitMs:1800000,finalityPollMs:15000});
   const quote=paymentClient.quote.bind(paymentClient);paymentClient.quote=async(...args)=>{const offer=await quote(...args);signer.bindOffer(offer);return offer;};
   client=new d.ClaimThenPayClient({journal:claimJournal,paymentClient,dispenserChain,signer,finalityWaitMs:1800000,finalityPollMs:15000});
   return summarize(await client.claimThenExecute(originalInput,{operationKey:KEY,publicSynthetic:true}));
  },
  async checkHost(){active();check(config&&dispenserConfig,'LAUNCH_CONFIGURATION_REQUIRED');return d.checkPaidHost({identity:chain.identity,dispenserIdentity:dispenserChain.identity});},
  async recoverFixedJob(){active();check(client,'LAUNCH_NO_ORIGINAL_JOB');return summarize(await client.recover(KEY,{originalInput,publicSynthetic:true}));},
  async close(){if(closed)return;closed=true;claimJournal?.close();paymentJournal?.close();runner?.close();client=null;payer=null;},
 });
}
