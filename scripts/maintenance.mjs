import { readFileSync } from 'node:fs';
import { snapshot } from '../src/maintenance.mjs';
process.umask(0o077);
try {
  const [operation,source,destination,expectedFile,...extra]=process.argv.slice(2);
  if(!['backup','restore'].includes(operation)||!source||!destination||!expectedFile||extra.length)throw Error('USAGE');
  const expected=JSON.parse(readFileSync(expectedFile,'utf8'));
  const result=await snapshot({source,destination,expected,restore:operation==='restore'});
  console.log(JSON.stringify(result));
} catch(e) { console.error(JSON.stringify({error:/^[A-Z_]+$/.test(e.code??e.message)?e.code??e.message:'MAINTENANCE_FAILED',preservePartialFiles:true})); process.exitCode=1; }
