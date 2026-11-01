import {writeFileSync} from 'node:fs';
import {provisionReceiptSigner} from '../src/receipt-storage.mjs';
const [root,phase,marker]=process.argv.slice(2);
provisionReceiptSigner({fixture:true,root,hook:p=>{if(p===phase){writeFileSync(marker,p,{flag:'wx',mode:0o600});process.kill(process.pid,'SIGSTOP');}}});
