import { pathToFileURL } from 'node:url';
import { parseJson } from '../src/json.mjs';
import { createReceiverSession, QUOTE_HANDOFF_ACTIVATION, QUOTE_HANDOFF_FIXTURE_ACK, validateFileHandoffDestination, hashFileHandoffChallenge } from '../src/quote-key-envelope.mjs';
import { reserveQuoteImport, inspectQuoteImport } from '../src/quote-key-file.mjs';

const fail=()=>{const e=new Error('QUOTE_IMPORT_FAILED_CLOSED');e.code=e.message;throw e;};
// Exactly bounded input; no readline history, shell command execution or error echo.
function lines(input){
 let buffer=Buffer.alloc(0),ended=false,fault=false,pending,seen=0,total=0;const queue=[];
 const finish=()=>{if(!pending)return; if(fault){const p=pending;pending=null;p.reject(new Error('QUOTE_IMPORT_INPUT_REFUSED'));}else if(queue.length){const p=pending;pending=null;p.resolve(queue.shift());}else if(ended){const p=pending;pending=null;p.reject(new Error('QUOTE_IMPORT_INPUT_ENDED'));}};
 const data=chunk=>{chunk=Buffer.from(chunk);total+=chunk.length;if(total>16384){fault=true;buffer.fill(0);buffer=Buffer.alloc(0);finish();return;}buffer=Buffer.concat([buffer,chunk]);let index;
  while((index=buffer.indexOf(10))!==-1){const line=buffer.subarray(0,index);buffer=buffer.subarray(index+1);seen++;if(line.length>8192||seen>2){fault=true;break;}queue.push(line.toString('utf8').replace(/\r$/,''));}if(buffer.length>8192)fault=true;finish();};
 const end=()=>{ended=true;if(buffer.length){seen++;if(seen>2)fault=true;else queue.push(buffer.toString('utf8'));buffer=Buffer.alloc(0);}finish();};const error=()=>{fault=true;finish();};
 input.on('data',data);input.once('end',end);input.on('error',error);
 return {read(timeout){return new Promise((resolve,reject)=>{if(pending)return reject(new Error('QUOTE_IMPORT_INPUT_REFUSED'));const timer=setTimeout(()=>{fault=true;finish();},timeout);pending={resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}};finish();});},abort(){fault=true;finish();},close(){input.removeListener('data',data);input.removeListener('end',end);input.removeListener('error',error);input.pause?.();buffer.fill(0);buffer=Buffer.alloc(0);queue.length=0;if(pending){const p=pending;pending=null;p.reject(new Error('QUOTE_IMPORT_INPUT_CLOSED'));}}};
}
/** Programmatic fixture injection is public-scalar-only in both crypto/storage.
 * CLI accepts no fixture option; the real path remains explicitly gated. */
export async function runQuoteImport({operation,destinationHash,activation,env,input,output,fixture}={}){
 let reader,receiver,reservation,bytes,outputFault=false;
 const outputError=()=>{outputFault=true;reader?.abort();};
 const emit=async value=>{if(outputFault)fail();await new Promise((resolve,reject)=>{try{output.write(JSON.stringify(value)+'\n',error=>error?reject(new Error('QUOTE_IMPORT_OUTPUT_REFUSED')):resolve());}catch{reject(new Error('QUOTE_IMPORT_OUTPUT_REFUSED'));}});if(outputFault)fail();};
 try{
  if(!['receive','inspect'].includes(operation)||activation!==QUOTE_HANDOFF_ACTIVATION||!/^[a-f0-9]{64}$/.test(destinationHash??''))fail();
  if(fixture&&fixture.fixtureAcknowledgement!==QUOTE_HANDOFF_FIXTURE_ACK)fail();
  output.on('error',outputError);reader=lines(input);const destination=validateFileHandoffDestination(parseJson(await reader.read(15000)));if(destination.destinationHash!==destinationHash)fail();
  const storageOptions={destination,activation,env,...(fixture?{fixtureAcknowledgement:fixture.fixtureAcknowledgement,fixtureRoot:fixture.fixtureRoot,fixtureConfiguration:fixture.fixtureConfiguration,onCheckpoint:fixture.onCheckpoint}:{})};
  if(operation==='inspect'){const result=inspectQuoteImport(storageOptions);await emit({status:'inspected',result});return result;}
  reservation=reserveQuoteImport(storageOptions); // Durable before ephemeral receiver authority/challenge.
  receiver=createReceiverSession({destination,...(fixture?{fixtureAcknowledgement:fixture.fixtureAcknowledgement,keyPairFactory:fixture.keyPairFactory,randomBytesFactory:fixture.randomBytesFactory,now:fixture.now}:{activation})});
  reservation.bindChallenge(receiver.challenge);const challengeHash=hashFileHandoffChallenge(receiver.challenge);
  await emit({status:'challenge',challengeHash,challenge:receiver.challenge});
  const capsule=parseJson(await reader.read(120000));bytes=receiver.open(capsule);
  const receipt=reservation.commit(bytes);await emit({status:'installed',receipt});return receipt;
 }catch{fail();}finally{bytes?.fill(0);receiver?.close();reservation?.close();reader?.close();output?.removeListener?.('error',outputError);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 process.umask(0o077);
 try{
  const args=process.argv.slice(2);if(args.length!==3)fail();
  await runQuoteImport({operation:args[0],activation:args[1],destinationHash:args[2],env:process.env,input:process.stdin,output:process.stdout});
 }catch{process.stderr.write('{"error":"QUOTE_IMPORT_FAILED_CLOSED","doNotAutomaticallyRetry":true}\n');process.exitCode=1;}
}
