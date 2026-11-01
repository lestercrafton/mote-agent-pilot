import {constants,openSync,closeSync,fstatSync,lstatSync,statSync,statfsSync,realpathSync,readlinkSync,fsyncSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

const fail=()=>{const e=new Error('QUOTE_FILE_CHANGED');e.code=e.message;throw e;};
const check=v=>{if(!v)fail();};
const stamp=s=>[s.dev,s.ino,s.uid,s.gid,s.mode].join(':');
/** Linux operations resolve children through a held directory descriptor.
 * Non-Linux fallback is ONLY for public scalar fixtures in a private temp tree;
 * it does not qualify Linux custody. The caller still enforces authorization,
 * exact destination, parent policy, file names and no-overwrite semantics. */
export function openQuoteDirectory(path,{expected,fixture=false,lookupPath=path}={}){
 check(resolve(path)===path&&expected?.isDirectory()&&!expected.isSymbolicLink());
 if(process.platform!=='linux')check(fixture&&path.startsWith(realpathSync(tmpdir())+'/'));
 const fd=openSync(lookupPath,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
 let closed=false;
 try{
  const initial=fstatSync(fd);check(stamp(initial)===stamp(expected));
  let anchor=path;
  if(process.platform==='linux'){
   const proc=lstatSync('/proc');check(proc.isDirectory()&&!proc.isSymbolicLink()&&proc.uid===0&&(proc.mode&0o022)===0&&statfsSync('/proc').type===0x9fa0);
   check(readlinkSync('/proc/self')===String(process.pid));anchor=`/proc/self/fd/${fd}`;
   check(stamp(statSync(anchor))===stamp(initial));
  }
  const verify=()=>{check(!closed);const current=fstatSync(fd);check(stamp(current)===stamp(initial)&&current.nlink>0);if(process.platform!=='linux')check(stamp(lstatSync(path))===stamp(initial));};
  return Object.freeze({
   nativeAnchored:process.platform==='linux',
   verify,
   child(name){verify();check(typeof name==='string'&&/^[A-Za-z0-9_.-]{1,80}$/.test(name)&&name!=='.'&&name!=='..');return join(anchor,name);},
   location(){verify();return anchor;},
   sync(){verify();fsyncSync(fd);},
   close(){if(!closed){closed=true;closeSync(fd);}},
  });
 }catch(e){if(!closed)closeSync(fd);throw e;}
}
