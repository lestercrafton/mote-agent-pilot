import { startCombinedFromEnvironment } from '../src/startup.mjs';
process.umask(0o077);
try {
  const app=await startCombinedFromEnvironment(process.env);
  console.log(JSON.stringify({status:'listening',usdcEnabled:!!app.usdc,testOnly:!app.usdc||app.usdc.c.network!=='eip155:8453',productionReady:false}));
  for(const s of ['SIGINT','SIGTERM'])process.once(s,()=>app.close().catch(()=>{process.exitCode=1;}));
}catch{console.error('{"error":"COMBINED_STARTUP_FAILED"}');process.exitCode=1;}
