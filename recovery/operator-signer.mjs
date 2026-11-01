import {Transaction} from 'ethers';
import {assertRecoveryTime} from '../src/recovery-r1-policy.mjs';
const fail=()=>{throw Object.assign(Error('R1_OPERATOR_INTENT_REFUSED'),{code:'R1_OPERATOR_INTENT_REFUSED'});};
function encoding(tx){
 if(!tx||Object.keys(tx).sort().join()!=='accessList,chainId,data,gasLimit,maxFeePerGas,maxPriorityFeePerGas,nonce,to,type,value'||tx.type!==2||String(tx.chainId)!=='11155111'||!Array.isArray(tx.accessList)||tx.accessList.length)fail();
 return Transaction.from({...tx,nonce:Number(tx.nonce),gasLimit:BigInt(tx.gasLimit),value:BigInt(tx.value),maxFeePerGas:BigInt(tx.maxFeePerGas),maxPriorityFeePerGas:BigInt(tx.maxPriorityFeePerGas)}).unsignedSerialized;
}
/** The legacy native policy validates a full five-intent plan. Never expose
 * that signer: this wrapper narrows it to the remaining immutable encodings. */
export async function openRecoveryOperatorSigner({nativeOptions,allowedTransactions,openSigner}){
 if(!Array.isArray(allowedTransactions)||allowedTransactions.length!==5||typeof openSigner!=='function'||nativeOptions?.role!=='bootstrap')fail();
 const intents=structuredClone(allowedTransactions);
 for(let i=0;i<5;i++){if(String(intents[i].nonce)!==String(i))fail();encoding(intents[i]);}
 const allowed=new Set(intents.slice(2).map(encoding));
 assertRecoveryTime();
 const native=await openSigner({...nativeOptions,allowedTransactions:intents});
 if(typeof native?.getAddress!=='function'||typeof native?.signTransaction!=='function')fail();
 const getAddress=native.getAddress.bind(native),sign=native.signTransaction.bind(native);
 return Object.freeze({getAddress,async signTransaction(request){
  assertRecoveryTime();const copied=structuredClone(request),expected=encoding(copied);
  if(!allowed.has(expected))fail();
  // Snapshot before awaits; caller mutation cannot change the validated intent.
  Object.freeze(copied.accessList);Object.freeze(copied);
  const raw=await sign(copied);assertRecoveryTime();
  if(Transaction.from(raw).unsignedSerialized!==expected)fail();
  return raw;
 }});
}
