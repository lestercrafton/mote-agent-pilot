import { readFileSync, lstatSync, realpathSync, constants, openSync, fstatSync, closeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseJson } from '../src/json.mjs';
import { validateTestnetChainConfig } from '../src/testnet-chain.mjs';
import { describeFileHandoffDestination, QUOTE_HANDOFF_ACTIVATION } from '../src/quote-key-envelope.mjs';
import { withQuoteFileEnvironment } from '../src/quote-key-file.mjs';
import { startPilotFromEnvironment } from './testnet-server.mjs';

const fail=()=>{const e=new Error('QUOTE_FILE_STARTUP_FAILED');e.code=e.message;throw e;};
// Public config is parsed and pinned before any quote-file access. The existing
// starter still verifies live chain identity before constructing its signer.
export async function startFilePilotFromEnvironment(env){
 let bytes;
 try{
  if(env.MOTE_QUOTE_FILE_ACTIVATION!==QUOTE_HANDOFF_ACTIVATION||env.MOTE_CHAIN_CONFIG!=='/var/data/deployment.json')fail();
  const path=env.MOTE_CHAIN_CONFIG,st=lstatSync(path);
  if(!st.isFile()||st.isSymbolicLink()||realpathSync(path)!==path||st.uid!==process.getuid()||(st.mode&0o777)!==0o600||st.nlink!==1||st.size>131072)fail();
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const opened=fstatSync(fd);if(opened.dev!==st.dev||opened.ino!==st.ino||opened.size!==st.size)fail();bytes=readFileSync(fd);}finally{closeSync(fd);}
  const config=validateTestnetChainConfig(parseJson(bytes.toString('utf8')),env.MOTE_CONFIG_HASH);
  if(config.chainId!==11155111||config.mode!=='ethereum-sepolia')fail();
  const destination=describeFileHandoffDestination({serviceId:env.RENDER_SERVICE_ID,origin:env.MOTE_PUBLIC_ORIGIN,configHash:config.configHash,quoteSigner:config.roles.quoteSigner,sourceCommit:env.RENDER_GIT_COMMIT});
  if(env.MOTE_QUOTE_FILE_DESTINATION_HASH!==destination.destinationHash)fail();
  return await withQuoteFileEnvironment({destination,activation:env.MOTE_QUOTE_FILE_ACTIVATION,env},privateEnvironment=>startPilotFromEnvironment(privateEnvironment));
 }catch{fail();}finally{bytes?.fill(0);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 process.umask(0o077);
 try{const app=await startFilePilotFromEnvironment(process.env);process.stdout.write('{"status":"listening","mode":"ethereum-sepolia-public-synthetic-test","quoteCustody":"approved-file","broadcastsTransactions":false}\n');for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>app.close().catch(()=>{process.exitCode=1;}));}
 catch{process.stderr.write('{"error":"QUOTE_FILE_STARTUP_FAILED"}\n');process.exitCode=1;}
}
