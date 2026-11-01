import {assert,address,hash32} from './protocol.mjs';
import {hashJson} from './core/json.mjs';

// A new reviewed source revision can reuse the existing receipt signer only
// under a separately approved, hash-pinned public grant. Original intent/key/
// installation records are never rewritten. This function cannot write or sign.
export function validateReceiptRelease(record,{expectedHash,currentBinding,intent}) {
  assert(record && Object.getPrototypeOf(record)===Object.prototype &&
    Object.keys(record).sort().join(',')==='format,intentHash,receiptSigner,releaseBinding','RECEIPT_RELEASE_FIELDS');
  assert(hash32(expectedHash)&&hashJson(record)===expectedHash,'RECEIPT_RELEASE_HASH');
  assert(record.format==='mote-receipt-release-v1'&&hash32(currentBinding)&&record.releaseBinding===currentBinding,'RECEIPT_RELEASE_BINDING');
  assert(hash32(intent.binding)&&intent.binding!==currentBinding&&record.intentHash===hashJson(intent)&&record.receiptSigner===address(intent.address),'RECEIPT_RELEASE_IDENTITY');
  return record;
}
