import {provisionReceiptSigner} from '../src/receipt-storage.mjs';
process.umask(0o077);
try{process.stdout.write(JSON.stringify(provisionReceiptSigner({env:process.env}))+'\n');}
catch{process.stderr.write('{"error":"RECEIPT_PROVISION_STOPPED_RECONCILE_BEFORE_RETRY"}\n');process.exitCode=1;}
