import http from 'node:http';
import { pathToFileURL } from 'node:url';

/** Temporary first-install maintenance endpoint on the same paid instance.
 * No database access, signing, remote fetch, admin HTTP or automatic init. */
export async function startPilotSetup(env,{host='0.0.0.0',port=Number(env.PORT??10000)}={}) {
  if(!['base-sepolia-setup','ethereum-sepolia-setup'].includes(env.MOTE_MODE))throw new Error('Explicit one-time setup mode is required.');
  if(Object.entries(env).some(([key,value])=>value&&/PRIVATE_?KEY|MNEMONIC|SEED_PHRASE|DEPLOYER_KEY|WALLET_KEY|MOTE.*SECRET/i.test(key)))throw new Error('No signing credentials belong in setup mode.');
  if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid port.');
  const server=http.createServer({maxHeaderSize:16384},(req,res)=>{
    const ready=req.method==='GET'&&req.url==='/ready';
    res.writeHead(ready?200:503,{'content-type':'application/json','cache-control':'no-store','connection':'close'});
    res.end(JSON.stringify({mode:'setup-only',testOnly:true,paidServiceReady:false,quoteIssuance:false,adminHttp:false,note:'Initialization occurs only through the separately authorized provider Dashboard Shell.'}));
    req.resume();
  });
  server.requestTimeout=5000;server.headersTimeout=5000;server.maxConnections=32;
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(port,host,ok);});
  return{address:server.address(),async close(){server.closeAllConnections();await new Promise((ok,fail)=>server.close(e=>e?fail(e):ok()));}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    if(!/^\d+$/.test(process.env.PORT??'10000')||Number(process.env.PORT??10000)<1)throw new Error('Invalid port.');
    const app=await startPilotSetup(process.env);
    process.stdout.write('{"mode":"setup-only","paidServiceReady":false}\n');
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>app.close().catch(()=>{process.exitCode=1;}));
  }catch{process.stderr.write('Setup host failed closed. No keys or initialization are performed by this entrypoint.\n');process.exitCode=1;}
}
