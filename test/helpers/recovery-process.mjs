import {readFileSync} from 'node:fs';
import {JsonRpcProvider} from 'ethers';
import {createLoopbackRecoveryBootstrapRunner} from '../../src/bootstrap-runner.mjs';
Date.now=()=>Date.parse('2026-10-31T22:00:00Z');
const {endpoint,phase,...options}=JSON.parse(readFileSync(process.argv[2]));
const p=new JsonRpcProvider(endpoint,11155111,{cacheTimeout:-1});
const reader={endpoint,readOnly:true,send:(m,a)=>p.send(m,a)};
const runner=await createLoopbackRecoveryBootstrapRunner({...options,reader,hooks:{[phase](){process.kill(process.pid,'SIGKILL');}}});
await runner.adoptNext();throw Error('expected fixture kill');
