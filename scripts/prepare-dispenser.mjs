import { readFile, writeFile, stat } from 'node:fs/promises';
import { parseJson } from '../src/json.mjs';
import { createDispenserPlan } from '../src/dispenser-plan.mjs';

const args=process.argv.slice(2);
try {
  if(args.length!==4 || args[0]!=='--config' || args[2]!=='--out' || !args[1] || !args[3]) throw new Error('Usage: node scripts/prepare-dispenser.mjs --config PUBLIC_ROLES.json --out NEW_PLAN.json');
  const info=await stat(args[1]);
  if(!info.isFile() || info.size>4096) throw new Error('Public role configuration exceeds 4096 bytes');
  const plan=createDispenserPlan(parseJson(await readFile(args[1],'utf8')));
  await writeFile(args[3], JSON.stringify(plan,null,2)+'\n', {flag:'wx',mode:0o600});
  process.stdout.write(JSON.stringify({status:'unsigned-preparation',authorization:false,publicDeployment:false,planHash:plan.planHash})+'\n');
} catch(error) {
  process.stderr.write(JSON.stringify({error:'DISPENSER_PREPARATION_FAILED',message:error.message})+'\n');
  process.exitCode=1;
}
