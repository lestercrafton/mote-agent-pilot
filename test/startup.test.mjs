import test from 'node:test';
import A from 'node:assert/strict';
import { writeFileSync,chmodSync,symlinkSync,linkSync,unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './fixtures.mjs';
import { config } from '../src/protocol.mjs';
import { hashJson } from '../src/core/json.mjs';
import { validateStartupSettings,privateFile,prepareUsdc } from '../src/startup.mjs';
const origin='https://mote.example';
test('activation binds exact settings, testnet network, public origin, route and fixed RPC before credentials',()=>{
 const f=fixture({config:{origin,path:'/v1/usdc/audit'}});try{
  const settings={config:f.c,limits:f.journal.limits,offhost:{enabled:false,destination:null},rpcUrl:'https://sepolia.base.org'};
  const env={MOTE_USDC_ENABLED:'true',MOTE_USDC_ACTIVATION:'base-sepolia-beta-v1',MOTE_USDC_SETTINGS_HASH:hashJson(settings),MOTE_PUBLIC_ORIGIN:origin};
  A.deepEqual(validateStartupSettings(env,settings),f.c);
  for(const bad of [{...settings,config:config({...f.c,network:'eip155:8453'})},{...settings,config:config({...f.c,path:'/v1/audit'})},{...settings,rpcUrl:'https://other.invalid'},{...settings,offhost:{enabled:true,destination:'pending'}}])A.throws(()=>validateStartupSettings({...env,MOTE_USDC_SETTINGS_HASH:hashJson(bad)},bad));
  A.throws(()=>validateStartupSettings({...env,MOTE_PUBLIC_ORIGIN:'https://changed.example'},settings),/USDC_TESTNET_ONLY/);
  A.throws(()=>validateStartupSettings({...env,MOTE_USDC_SETTINGS_HASH:'wrong'},settings),/USDC_SETTINGS_BINDING/);
  for(const injected of [{create:true},{recoveryOnly:false},{unused:'unknown'}]){const bad={...settings,limits:{...settings.limits,...injected}};A.throws(()=>validateStartupSettings({...env,MOTE_USDC_SETTINGS_HASH:hashJson(bad)},bad),/USDC_LIMIT_FIELDS/);}
 }finally{f.close();}
});
test('private file reader enforces canonical path, single link, owner-only modes and size using nonsecret text',()=>{
 const f=fixture();try{const path=join(f.dir,'synthetic.txt');writeFileSync(path,'public fixture',{mode:0o600});A.equal(privateFile(path,64).toString(),'public fixture');
 A.throws(()=>privateFile(path,2),/PRIVATE_FILE/);chmodSync(path,0o644);A.throws(()=>privateFile(path,64),/PRIVATE_FILE/);chmodSync(path,0o600);
 symlinkSync(path,join(f.dir,'alias'));A.throws(()=>privateFile(join(f.dir,'alias'),64),/PRIVATE_PATH/);
 linkSync(path,join(f.dir,'hard'));A.throws(()=>privateFile(path,64),/PRIVATE_FILE/);unlinkSync(join(f.dir,'hard'));
 }finally{f.close();}
});
test('disabled or wrong activation exits before any private file access',async()=>{
 await A.rejects(prepareUsdc({MOTE_USDC_ENABLED:'false'}),/USDC_ACTIVATION/);
 await A.rejects(prepareUsdc({MOTE_USDC_ENABLED:'true',MOTE_USDC_ACTIVATION:'mainnet'}),/USDC_ACTIVATION/);
});
