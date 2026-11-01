import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { arch, platform, tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HDNodeWallet, id } from 'ethers';
import { canonicalStringify, hashJson, hashText, prepareAudit } from '../src/json.mjs';
import { QUOTE_TYPES, quoteDomain } from '../src/testnet-chain.mjs';
import { getTestnetNetwork } from '../src/testnet-networks.mjs';
import { encodeTestnetStoreRow, initializeTestnetStore, TestnetStore, TESTNET_STORE_LIMITS } from '../src/testnet-store.mjs';
import { createTestnetService } from '../src/testnet-service.mjs';
import { startTestnetHttp } from '../src/testnet-http.mjs';

// Controlled offline resource rehearsal only. Public fixture key in memory;
// synthetic proof adapter; loopback HTTP. No public RPC or transaction methods.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MIB = 1024 * 1024;
const NOW = 2_000_000_000;
const THRESHOLDS = Object.freeze({ processPeakRssBytes: 384*MIB, cgroupPeakBytes: 448*MIB, diskBytes: 850*MIB,
  startupMs: 30_000, backupMs: 60_000, restoreMs: 90_000, readyP95Ms: 250, freeP95Ms: 1000, recoveryP95Ms: 2000 });
const fixedRead = name => { try { return readFileSync(`/sys/fs/cgroup/${name}`, 'utf8').trim(); } catch { return null; } };
const integer = value => value !== null && /^\d+$/.test(value) ? Number(value) : null;
const pairs = value => value ? Object.fromEntries(value.split('\n').map(line => { const [key,value] = line.split(/\s+/); return [key,Number(value)]; })) : null;
const MEMORY_FIELDS = ['anon','file','kernel','file_dirty','file_writeback','shmem','slab','pagetables'];
// Only numeric status fields are retained. Never read process commands,
// environments or descriptors. Linux PIDs are sampled, not stable identities.
function cgroupProcesses() {
  const contents=fixedRead('cgroup.procs');
  if(contents===null)return null;
  const pids=[...new Set(contents.split(/\s+/).filter(value=>/^[1-9]\d*$/.test(value)).map(Number))].sort((a,b)=>a-b);
  const processes=pids.slice(0,256).map(pid=>{
    let rssBytes=null;
    try{const match=readFileSync(`/proc/${pid}/status`,'utf8').match(/^VmRSS:\s+(\d+)\s+kB$/m);if(match)rssBytes=Number(match[1])*1024;}catch{}
    return {pid,rssBytes};
  });
  return {observedCount:pids.length,truncated:pids.length>256,processes,
    readableRssSumBytes:processes.reduce((sum,item)=>sum+(item.rssBytes??0),0),unavailableCount:processes.filter(item=>item.rssBytes===null).length};
}
function memorySnapshot(phase,started) {
  const stat=pairs(fixedRead('memory.stat'));
  return {atMs:performance.now()-started,phase,parentPid:process.pid,parent:process.memoryUsage(),
    cgroupBytes:integer(fixedRead('memory.current')),
    memoryStatBytes:stat?Object.fromEntries(MEMORY_FIELDS.map(key=>[key,Number.isSafeInteger(stat[key])?stat[key]:null])):null,
    cgroupProcesses:cgroupProcesses()};
}
function memoryRecorder() {
  const started=performance.now();const processes=new Map();const children=new Map();
  const evidence={schema:'mote-resource-memory-v1',aggregateSampleIntervalMs:10,compositionSampleIntervalMs:100,samples:0,
    phaseSnapshots:{},sampledPeaks:{parent:{},memoryStatBytes:{},cgroupBytes:null,readableProcessRssSumBytes:null,observedProcessCount:null},
    peakCompositions:{cgroup:null,parentRss:null,readableProcessRssSum:null},maintenanceChildren:[],processes:[]};
  function record(phase) {
    const item=memorySnapshot(phase,started);evidence.samples++;
    for(const [key,value] of Object.entries(item.parent))evidence.sampledPeaks.parent[key]=Math.max(evidence.sampledPeaks.parent[key]??0,value);
    if(item.memoryStatBytes)for(const [key,value] of Object.entries(item.memoryStatBytes))if(value!==null)evidence.sampledPeaks.memoryStatBytes[key]=Math.max(evidence.sampledPeaks.memoryStatBytes[key]??0,value);
    if(item.cgroupBytes!==null&&(evidence.sampledPeaks.cgroupBytes===null||item.cgroupBytes>evidence.sampledPeaks.cgroupBytes)){
      evidence.sampledPeaks.cgroupBytes=item.cgroupBytes;evidence.peakCompositions.cgroup=item;
    }
    if(!evidence.peakCompositions.parentRss||item.parent.rss>evidence.peakCompositions.parentRss.parent.rss)evidence.peakCompositions.parentRss=item;
    if(item.cgroupProcesses){
      const group=item.cgroupProcesses;
      evidence.sampledPeaks.observedProcessCount=Math.max(evidence.sampledPeaks.observedProcessCount??0,group.observedCount);
      if(evidence.sampledPeaks.readableProcessRssSumBytes===null||group.readableRssSumBytes>evidence.sampledPeaks.readableProcessRssSumBytes){
        evidence.sampledPeaks.readableProcessRssSumBytes=group.readableRssSumBytes;evidence.peakCompositions.readableProcessRssSum=item;
      }
      for(const {pid,rssBytes} of group.processes){
        // Bound retained telemetry even if an unrelated process churns PIDs.
        if(!processes.has(pid)&&processes.size>=256)continue;
        const seen=processes.get(pid)??{pid,samples:0,maxRssBytes:null};seen.samples++;
        if(rssBytes!==null)seen.maxRssBytes=Math.max(seen.maxRssBytes??0,rssBytes);processes.set(pid,seen);
      }
    }
    return item;
  }
  return {record,evidence,
    child(event,phase){
      if(event.type==='spawn')children.set(event.pid,{operation:event.operation,pid:event.pid,startedMs:performance.now()-started,start:record(phase)});
      else if(children.has(event.pid)){const child=children.get(event.pid);child.endedMs=performance.now()-started;child.exitCode=event.code;child.signal=event.signal;child.end=record(phase);}
    },
    finish(phase){
      evidence.final=record(phase);
      evidence.maintenanceChildren=[...children.values()];
      evidence.processes=[...processes.values()].map(item=>({...item,role:item.pid===process.pid?'qualification-parent':children.has(item.pid)?`maintenance-${children.get(item.pid).operation}`:'other-cgroup-process'}));
      evidence.notes=['Composition snapshots are sampled and non-atomic; they may miss the exact kernel peak.','Per-process RSS includes shared mappings and must not be subtracted from cgroup totals as an exact cache estimate.','Process status is limited to 256 PIDs per sample; unreadable or exited PIDs have null RSS.','Other cgroup processes may include the separately running maintenance HTTP server.'];
      return evidence;
    }};
}
function fixturePayload(profile) {
  if(profile==='repeated')return 'a'.repeat(64_000);
  let payload='';for(let counter=0;payload.length<64_000;counter++)payload+=createHash('sha256').update(`mote-resource-payload-v1:${counter}`).digest('base64url');
  return payload.slice(0,64_000);
}
export function resourceEnvironment() {
  const cpu = fixedRead('cpu.max')?.split(/\s+/);
  return { node:process.version, platform:platform(), architecture:arch(),
    memoryMaxBytes:integer(fixedRead('memory.max')), swapMaxBytes:integer(fixedRead('memory.swap.max')),
    cpuQuotaCores:cpu && cpu[0]!=='max' ? Number(cpu[0])/Number(cpu[1]) : null,
    memoryEvents:pairs(fixedRead('memory.events')), cpuStat:pairs(fixedRead('cpu.stat')),
    developmentPackagesPresent:['ganache','solc','@modelcontextprotocol/client'].filter(name=>existsSync(join(ROOT,'node_modules',name))) };
}
const constrained = env => env.node==='v24.22.2' && env.platform==='linux' && env.architecture==='x64'
  && env.memoryMaxBytes===512*MIB && env.swapMaxBytes===0 && env.cpuQuotaCores===0.5 && env.developmentPackagesPresent.length===0;
const stats = values => { const sorted=[...values].sort((a,b)=>a-b); return {samples:sorted.length,p50:sorted[Math.ceil(sorted.length*.5)-1],p95:sorted[Math.ceil(sorted.length*.95)-1],max:sorted.at(-1)}; };
const sourceHashes=()=>Object.fromEntries([...readdirSync(join(ROOT,'src')).filter(name=>name.endsWith('.mjs')).map(name=>`src/${name}`),'scripts/resource-check.mjs','scripts/testnet-maintenance.mjs','package-lock.json'].sort().map(file=>[file,createHash('sha256').update(readFileSync(join(ROOT,file))).digest('hex')]));
const diskBytes = path => readdirSync(path,{withFileTypes:true}).reduce((sum,item)=>sum+(item.isDirectory()?diskBytes(join(path,item.name)):statSync(join(path,item.name)).size),0);
async function workers(count,concurrency,fn){let next=0;await Promise.all(Array.from({length:concurrency},async()=>{while(next<count)await fn(next++);}));}
async function maintenance(operation,source,destination,identityPath,onChild=()=>{}) {
  return new Promise((done,fail)=>{
    const child=spawn(process.execPath,[join(ROOT,'scripts/testnet-maintenance.mjs'),operation,source,destination,identityPath],{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH??'',NODE_NO_WARNINGS:'1'}});
    child.on('spawn',()=>onChild({type:'spawn',operation,pid:child.pid}));
    let stdout='';let stderr='';let excessive=false;
    const timer=setTimeout(()=>{excessive=true;child.kill('SIGKILL');},120_000);
    child.stdout.on('data',chunk=>{if(stdout.length+chunk.length>65536){excessive=true;child.kill('SIGKILL');}else stdout+=chunk;});
    child.stderr.on('data',chunk=>{if(stderr.length+chunk.length>4096){excessive=true;child.kill('SIGKILL');}else stderr+=chunk;});
    child.on('error',error=>{clearTimeout(timer);fail(error);});
    child.on('close',(code,signal)=>{clearTimeout(timer);onChild({type:'close',operation,pid:child.pid,code,signal});if(code!==0||excessive)return fail(new Error(`Maintenance child failed (${code}); ${stderr.slice(0,1000)}`));try{done(JSON.parse(stdout));}catch(error){fail(error);}});
  });
}

export async function resourceCheck({profile='smoke',payloadProfile='repeated',chainId=11155111,dataRoot=tmpdir(),requireContainer=false}={}) {
  assert(['smoke','full'].includes(profile));assert(['repeated','entropy'].includes(payloadProfile)); const network=getTestnetNetwork(chainId);
  const environment=resourceEnvironment();const sourceBefore=sourceHashes();
  if(requireContainer && !constrained(environment)) return {schema:'mote-resource-check-v1',status:'blocked-environment',profile,environment,acceptancePassed:false,reason:'Requires Node24.22.2 Linux x64, cgroup-v2 512MiB, swap0, CPU0.5 and omitted development dependencies.'};
  const directory=realpathSync(mkdtempSync(join(realpathSync(resolve(dataRoot)),'mote-resource-')));
  const database=join(directory,'orders.sqlite'), snapshot=join(directory,'snapshot.sqlite'), restored=join(directory,'restored.sqlite');
  const rows=profile==='full'?TESTNET_STORE_LIMITS.quotes:3;
  const signer=HDNodeWallet.fromPhrase('test test test test test test test test test test test junk',undefined,"m/44'/60'/0'/0/3");
  const identity={origin:'https://resource-fixture.example.invalid',chainId,genesisHash:network.genesisHash,
    token:`0x${'11'.repeat(20)}`,router:`0x${'22'.repeat(20)}`,recipient:`0x${'33'.repeat(20)}`,quoteSigner:signer.address.toLowerCase(),
    checkpoint:{blockNumber:'1',blockHash:id('resource-check-checkpoint')},configHash:id(`resource-fixture-${chainId}`)};
  const identityPath=join(directory,'identity.json');writeFileSync(identityPath,JSON.stringify(identity),{flag:'wx',mode:0o600});
  const input={document:{payload:fixturePayload(payloadProfile)},schema:{type:'object',required:['payload'],properties:{payload:{type:'string',maxLength:64_000}},additionalProperties:false}};
  const prepared=prepareAudit(input); const domain=quoteDomain(chainId,identity.router);
  const phases={}; let first; let service; let transport; let timer; let compositionTimer; let seed;
  const telemetry=memoryRecorder();let activePhase='setup';
  let sampledRss=process.memoryUsage().rss; let sampledCgroup=integer(fixedRead('memory.current'));
  const sample=()=>{sampledRss=Math.max(sampledRss,process.memoryUsage().rss);const value=integer(fixedRead('memory.current'));if(value!==null)sampledCgroup=Math.max(sampledCgroup??0,value);};
  const phase=async(name,fn)=>{const previous=activePhase;activePhase=name;telemetry.evidence.phaseSnapshots[name]={before:telemetry.record(name)};
    const start=performance.now();try{return await fn();}finally{phases[name]=performance.now()-start;sample();telemetry.evidence.phaseSnapshots[name].after=telemetry.record(name);activePhase=previous;}};
  const observeChild=event=>telemetry.child(event,activePhase);
  const proofFor=offer=>({transactionHash:id(`resource-proof-${offer.quote.quoteId}`),transactionNonce:'1',blockNumber:'10',blockHash:id('resource-payment-block'),transactionIndex:'0',logIndex:'1',blockTimestamp:String(NOW),payer:offer.quote.payer,amount:offer.quote.amount,quoteId:offer.quote.quoteId,requestHash:offer.quote.requestHash,token:identity.token,router:identity.router,recipient:identity.recipient,configHash:identity.configHash,finalized:{blockNumber:'11',blockHash:id('resource-finalized-block')}});
  const adapter={identity,async verifyIdentity(){return structuredClone(identity);},async verifyPayment({offer,transactionHash,finalizedAnchor}){const proof=proofFor(offer);assert.equal(transactionHash,proof.transactionHash);if(finalizedAnchor)assert.deepEqual(finalizedAnchor,proof.finalized);return proof;}};
  const open=async(path,recoveryOnly=false)=>{service=await createTestnetService({adapter,quoteSigner:signer,database:path,now:()=>NOW,recoveryOnly});transport=await startTestnetHttp({service,host:'127.0.0.1',port:0});};
  const close=async()=>{await transport?.close();transport=null;service?.close();service=null;};
  const request=async(path,value,expected=200,key='resource-request-key')=>{
    const target=`http://127.0.0.1:${transport.address.port}${path}`;const start=performance.now();
    const response=await fetch(target,{method:value===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(120_000),headers:{'content-type':'application/json','idempotency-key':key},...(value===undefined?{}:{body:JSON.stringify(value)})});
    const body=await response.json();assert.equal(response.status,expected,JSON.stringify(body));sample();return {body,ms:performance.now()-start};
  };
  try {
    telemetry.evidence.initial=telemetry.record(activePhase);timer=setInterval(sample,10);compositionTimer=setInterval(()=>telemetry.record(activePhase),100); initializeTestnetStore({path:database,identity});
    await phase('seedMs',async()=>{
      seed=new DatabaseSync(database);seed.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
      const put=seed.prepare('INSERT INTO quotes VALUES (?,?,?,?,?,?,?)');const attempt=seed.prepare('INSERT INTO attempts VALUES (?,?,?,?)');
      for(let index=0;index<rows;index++) {
        const payer=`0x${id(`resource-payer-${Math.floor(index/20)}`).slice(-40)}`;
        const quote={quoteId:id(`resource-quote-${index}`),requestHash:prepared.requestHash,payer,amount:prepared.amount,deadline:String(NOW+120)};
        const draft={protocol:network.protocol,quote,domain,chainId,token:identity.token,router:identity.router,recipient:identity.recipient,quoteSigner:identity.quoteSigner,decimals:6,asset:'MOTE',service:'json.audit',resultHash:prepared.resultHash,expiresAt:new Date((NOW+120)*1000).toISOString(),inputBytes:prepared.inputBytes,origin:identity.origin,configHash:identity.configHash,finality:'finalized',testOnly:true,publicSynthetic:true,localOnly:false};
        const envelope={...draft,signature:await signer.signTypedData(domain,QUOTE_TYPES,quote)};
        const offer={...envelope,offerSignature:await signer.signMessage(canonicalStringify(envelope))};
        const proof=proofFor(offer);
        const receipt={protocol:network.protocol,quoteId:quote.quoteId,requestHash:quote.requestHash,resultHash:prepared.resultHash,payer,amount:quote.amount,asset:'MOTE',chainId,token:identity.token,router:identity.router,recipient:identity.recipient,quoteSigner:identity.quoteSigner,origin:identity.origin,configHash:identity.configHash,transactionHash:proof.transactionHash,blockNumber:proof.blockNumber,blockHash:proof.blockHash,transactionIndex:proof.transactionIndex,logIndex:proof.logIndex,settledAt:new Date(NOW*1000).toISOString(),finalized:proof.finalized,finality:'finalized',testOnly:true,publicSynthetic:true,localOnly:false};
        const response={result:prepared.result,receipt,receiptSignature:await signer.signMessage(canonicalStringify(receipt)),receiptSigner:identity.quoteSigner};
        const row={id:quote.quoteId,key:`resource-quote-${index}`,fingerprint:hashJson({payer,requestHash:prepared.requestHash,publicSynthetic:true}),payer,input,result:prepared.result,draft,offer,response,transactionHash:proof.transactionHash};
        const data=encodeTestnetStoreRow(row,identity);assert(Buffer.byteLength(data)<=524288);put.run(row.id,row.key,row.fingerprint,payer,data,hashText(data),row.transactionHash);
        for(let n=0;n<4;n++)attempt.run(`resource-attempt-${index}-${n}`,row.id,row.transactionHash,'finalized');
        if(index===0)first={offer,response};if(index%25===0){sample();await new Promise(setImmediate);}
      }
      seed.exec('COMMIT;');seed.close();seed=null;
    });
    await phase('startupMs',()=>open(database));
    assert.equal((await request('/ready')).body.ready,true);
    assert.deepEqual((await request(`/v1/orders/${first.offer.quote.quoteId}`)).body,first.response);
    const durations={ready:[],free:[],recovery:[]};
    await phase('workloadMs',()=>workers(profile==='full'?120:12,4,async index=>{
      const kind=['ready','free','recovery'][index%3];
      const response=kind==='ready'?await request('/ready'):kind==='free'?await request('/v1/audit',input):await request(`/v1/orders/${first.offer.quote.quoteId}`);
      durations[kind].push(response.ms);
      if(kind==='free')assert.equal(response.body.result.valid,true);
      if(kind==='recovery')assert.deepEqual(response.body,first.response);
    }));
    if(profile==='full') {const capacity=await request('/v1/quotes',{payer:`0x${'55'.repeat(20)}`,input:{document:1},publicSynthetic:true},503,'resource-over-capacity');assert.equal(capacity.body.error.code,'CAPACITY');}
    const duringBackup=[];let backingUp=true;
    const backup=phase('backupMs',()=>maintenance('backup',database,snapshot,identityPath,observeChild)).finally(()=>{backingUp=false;});
    // Actual operator maintenance runs as a second Node process on the same
    // instance. The container cgroup accounts for both, unlike parent RSS.
    const probe=(async()=>{while(backingUp){duringBackup.push((await request('/ready')).ms);await new Promise(resolve=>setTimeout(resolve,25));}})();
    const maintenanceResults=await Promise.allSettled([backup,probe]);
    for(const result of maintenanceResults)if(result.status==='rejected')throw result.reason;
    assert.deepEqual((await request(`/v1/orders/${first.offer.quote.quoteId}`)).body,first.response);
    await close();
    const restoredInfo=await phase('restoreMs',()=>maintenance('restore',snapshot,restored,identityPath,observeChild));
    assert.equal(restoredInfo.mode,'recovery-only');
    assert.throws(()=>new TestnetStore({path:restored,identity}),{code:'STORE_RECOVERY_REQUIRED'});
    await phase('recoveryStartupMs',()=>open(restored,true));
    assert.deepEqual((await request(`/v1/orders/${first.offer.quote.quoteId}`)).body,first.response);
    assert.equal((await request('/ready')).body.newQuotesAllowed,false);
    await request('/v1/quotes',{payer:first.offer.quote.payer,input:{document:1},publicSynthetic:true},503,'resource-quarantine-quote');
    const latencies={...Object.fromEntries(Object.entries(durations).map(([key,values])=>[key,stats(values)])),readyDuringBackup:stats(duringBackup)};
    const memoryTelemetry=telemetry.finish('complete');sample();
    const usage={sampledProcessRssBytes:sampledRss,processPeakRssBytes:process.resourceUsage().maxRSS*1024,sampledCgroupBytes:sampledCgroup,cgroupPeakBytes:integer(fixedRead('memory.peak')),diskBytes:diskBytes(directory)};
    const finalEnv=resourceEnvironment();
    const sourceAfter=sourceHashes();const sourceChanges=Object.keys(sourceBefore).filter(file=>sourceBefore[file]!==sourceAfter[file]);
    const checks={sourceStable:sourceChanges.length===0,rss:usage.processPeakRssBytes<=THRESHOLDS.processPeakRssBytes,cgroup:usage.cgroupPeakBytes!==null&&usage.cgroupPeakBytes<=THRESHOLDS.cgroupPeakBytes,
      disk:usage.diskBytes<=THRESHOLDS.diskBytes,startup:phases.startupMs<=THRESHOLDS.startupMs&&phases.recoveryStartupMs<=THRESHOLDS.startupMs,
      backup:phases.backupMs<=THRESHOLDS.backupMs,restore:phases.restoreMs<=THRESHOLDS.restoreMs,
      ready:latencies.ready.p95<=THRESHOLDS.readyP95Ms&&latencies.readyDuringBackup.p95<=THRESHOLDS.readyP95Ms,free:latencies.free.p95<=THRESHOLDS.freeP95Ms,recovery:latencies.recovery.p95<=THRESHOLDS.recoveryP95Ms,
      noOom:environment.memoryEvents!==null&&['oom','oom_kill','max'].every(key=>finalEnv.memoryEvents?.[key]===environment.memoryEvents[key])};
    const eligible=profile==='full'&&constrained(environment);
    return {schema:'mote-resource-check-v1',status:eligible?(Object.values(checks).every(Boolean)?'passed-constrained-fixture':'failed-thresholds'):'local-functional-only',profile,chainId,
      functionalChecksPassed:true,acceptanceEligible:eligible,acceptancePassed:eligible&&Object.values(checks).every(Boolean),environment,finalEnvironment:finalEnv,
      workload:{rows,attempts:rows*4,inputBytes:prepared.inputBytes,payloadProfile,payloadAlgorithm:payloadProfile==='entropy'?'deterministic-sha256-base64url-v1':'repeated-a',concurrency:4,proofs:'synthetic adapter, no chain settlement',http:'loopback only, no TLS',serverAndDriverShareProcess:true,maintenanceInSeparateProcess:true},
      phases,latencies,usage,memoryTelemetry,thresholds:THRESHOLDS,checks,publicRpcCalls:0,transactionsSubmitted:0,persistentKeysCreated:0,hostedStartupVerified:false,
      sourceHashes:sourceBefore,sourceChangedDuringRun:sourceChanges,
      limitations:['Synthetic proof adapter excludes real RPC latency/finality.','Fixture rehearsal does not invoke the externally provisioned production signer startup.','Linux cgroup limits qualify only when directly observed, not inferred from process RSS.','Process RSS covers the parent only; cgroup peak must include the separate maintenance child.','A near-body-limit string is not every adversarial supported schema or JSON shape.']};
  } finally {clearInterval(timer);clearInterval(compositionTimer);seed?.close();await close();rmSync(directory,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=process.argv.slice(2);const options={};let output;
  try{
    for(let i=0;i<args.length;i++){
      const arg=args[i];if(arg==='--require-container'){assert(!options.requireContainer);options.requireContainer=true;continue;}
      assert(['--profile','--payload-profile','--chain','--data-root','--evidence'].includes(arg)&&args[i+1]);const value=args[++i];
      const key={'--profile':'profile','--payload-profile':'payloadProfile','--chain':'chainId','--data-root':'dataRoot','--evidence':'output'}[arg];
      if(key==='output'){assert(!output);output=value;}else{assert(options[key]===undefined);options[key]=key==='chainId'?Number(value):value;}
    }
    const evidence=await resourceCheck(options);if(output)writeFileSync(output,JSON.stringify(evidence,null,2)+'\n',{flag:'wx',mode:0o600});
    process.stdout.write(JSON.stringify(evidence,null,2)+'\n');if(evidence.status==='blocked-environment'||evidence.status==='failed-thresholds')process.exitCode=2;
  }catch(error){process.stderr.write(JSON.stringify({status:'failed-local-resource-check',code:error.code??'CHECK_FAILED',message:error.message})+'\n');process.exitCode=1;}
}
