import { startCombinedFromEnvironment } from '../src/startup.mjs';

const startupReasons = new Set([
  'RELEASE_TRANSITION_FILE', 'RELEASE_TRANSITION_HASH', 'RELEASE_TRANSITION',
  'RELEASE_ENVIRONMENT', 'RELEASE_HASH', 'RELEASE_MANIFEST', 'RELEASE_FILE',
  'RELEASE_FIELDS', 'QUOTE_FILE_STARTUP_FAILED', 'USDC_ENABLE_FLAG',
  'USDC_SETTINGS_BINDING', 'PRODUCTION_SETTINGS_BINDING', 'PROVIDER_UNAVAILABLE',
  'PROVIDER_UNSUPPORTED', 'ENOENT', 'EACCES',
]);

process.umask(0o077);
try {
  const app=await startCombinedFromEnvironment(process.env);
  console.log(JSON.stringify({status:'listening',usdcEnabled:!!app.usdc,testOnly:!app.usdc||app.usdc.c.network!=='eip155:8453',productionReady:false}));
  for(const s of ['SIGINT','SIGTERM'])process.once(s,()=>app.close().catch(()=>{process.exitCode=1;}));
} catch (error) {
  const reason = startupReasons.has(error?.code) ? error.code : undefined;
  console.error(JSON.stringify({ error: 'COMBINED_STARTUP_FAILED', reason }));
  process.exitCode = 1;
}
