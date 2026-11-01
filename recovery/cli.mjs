import{createInterface}from'node:readline';
import{pathToFileURL}from'node:url';
import{createLaunchController,inspectLaunchSession,ACTIVATION}from'./controller.mjs';
import{createLiveAdapter}from'./live-adapter.mjs';
import{verifyLaunchPins,verifyNativePrerequisites}from'./verify-pins.mjs';
import pins from'./pins.json'with{type:'json'};
const error=e=>({error:/^[A-Z][A-Z0-9_]{2,80}$/.test(e?.code??'')?e.code:'LAUNCH_FAILED_CLOSED',noAutomaticRetry:true});
const display=v=>process.stdout.write(JSON.stringify(v)+'\n');
const fail=()=>{throw Object.assign(new Error('LAUNCH_INPUT'),{code:'LAUNCH_INPUT'});};
export async function runLaunchCli(args,input=process.stdin){
 let controller,lines;
 try{
  process.umask(0o077);
  if(args.length===1&&args[0]==='--check'){const source=verifyLaunchPins(),native=verifyNativePrerequisites();display({source,native,nativeExecuted:false,keysGenerated:false});return;}
  if(args.length===2&&args[0]==='--inspect'){verifyLaunchPins();display({state:inspectLaunchSession(args[1]),readOnly:true,keysGenerated:false});return;}
  if(args.length!==1||args[0]!=='--activate-r1-recovery-a-to-e'||process.env.NODE_TEST_CONTEXT||!process.env.TMUX)fail();
  let bytes=0,commands=0,initialized=false,overflow=false;
  input.on('data',b=>{bytes+=b.length;if(bytes>1048576){overflow=true;input.destroy();}});
  lines=createInterface({input,crlfDelay:Infinity});
  for await(const line of lines){
   if(overflow||Buffer.byteLength(line)>8192||++commands>10000)fail();
   let message;try{message=JSON.parse(line);}catch{fail();}
   if(!initialized){
    if(!message||Object.keys(message).sort().join()!=='directory,hostEvidence,operator,quoteSigner,sourceCommit')fail();
    const{directory,...options}=message;
    const adapter=createLiveAdapter({...options,activation:ACTIVATION});
    controller=await createLaunchController({directory,activation:ACTIVATION,descriptor:{sourceCommit:options.sourceCommit,manifestSha256:pins.eightTransactionManifestSha256},adapter});
    initialized=true;display({status:'initialized',state:controller.status(),privateKeyPersisted:false});continue;
   }
   if(!message||Object.keys(message).join()!=='command'||typeof message.command!=='string')fail();
   display(await controller.command(message.command));
  }
  if(overflow)fail();
 }catch(e){display(error(e));process.exitCode=1;}
 finally{lines?.close();try{await controller?.close();}catch{process.exitCode=1;}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await runLaunchCli(process.argv.slice(2));
