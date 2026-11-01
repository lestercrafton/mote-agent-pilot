// Read-only qualification; no keys, credentials, RPC, custody or mutation.
import {readFileSync,lstatSync} from 'node:fs';
import {verifyRenderPrivateGroupMount} from '../src/render-mount-policy.mjs';
const summary={readOnly:true,secretAccess:false,attempts:0,passed:0,procLinkCounts:[]};
try{
 if(process.platform!=='linux'||process.env.RENDER!=='true'||process.env.RENDER_SERVICE_ID!=='srv-dbijuvou01pc73d59c30')throw Error('WRONG_HOST');
 summary.groupsLine=readFileSync('/proc/self/status','utf8').split('\n').find(x=>x.startsWith('Groups:'));
 summary.procMountOptions=readFileSync('/proc/self/mountinfo','utf8').split('\n').filter(line=>line.split(' ')[4]==='/proc');
 for(let n=0;n<50;n++){
  summary.attempts++;const result=verifyRenderPrivateGroupMount();summary.passed++;
  summary.procLinkCounts.push(lstatSync('/proc',{bigint:true}).nlink.toString());
  summary.mount={path:result.path,uid:result.uid,gid:result.gid,mode:result.mode.toString(8),dev:result.dev.toString(),ino:result.ino.toString()};
  if(n<49)await new Promise(resolve=>setTimeout(resolve,100));
 }
 summary.readyForNextReview=true;
}catch(e){summary.readyForNextReview=false;summary.error=/^[A-Z_]+$/.test(e?.code??e?.message??'')?(e.code??e.message):'READ_ONLY_PROBE_FAILED';process.exitCode=1;}
process.stdout.write(JSON.stringify(summary)+'\n');
