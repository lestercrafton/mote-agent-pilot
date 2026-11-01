import { readFileSync } from 'node:fs';
import { snapshot } from '../src/maintenance.mjs';
const {point,...options}=JSON.parse(readFileSync(process.argv[2],'utf8'));
await snapshot({...options,hook:async phase=>{if(phase===point){process.send({point});await new Promise(()=>{});}}});
process.exit(2);
