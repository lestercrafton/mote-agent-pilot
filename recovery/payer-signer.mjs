import { assertRecoveryTime } from '../src/recovery-r1-policy.mjs';
import{Interface,Transaction,getAddress,verifyTypedData}from'../node_modules/ethers/lib.esm/index.js';
import{QUOTE_TYPES,quoteDomain}from'../src/testnet-chain.mjs';
import pins from'./pins.json'with{type:'json'};
const token=new Interface(['function approve(address,uint256) returns(bool)']);
const router=new Interface(['function pay((bytes32 quoteId,bytes32 requestHash,address payer,uint256 amount,uint256 deadline),bytes)']);
const fail=()=>{const e=new Error('LAUNCH_PAYER_REFUSED_OR_UNKNOWN');e.code=e.message;throw e;};
const addr=v=>getAddress(v).toLowerCase();
const serial=tx=>Transaction.from({...tx,nonce:Number(tx.nonce),value:BigInt(tx.value),gasLimit:BigInt(tx.gasLimit),maxFeePerGas:BigInt(tx.maxFeePerGas),maxPriorityFeePerGas:BigInt(tx.maxPriorityFeePerGas)}).unsignedSerialized;
/** Trusted private signer is captured in closure; returned methods never expose
 * it. Every stage is consumed BEFORE signing; any uncertainty blocks forever. */
export function createExactPayerSigner({wallet,roles,contracts,broadcast}){
 if(Object.keys(roles??{}).sort().join()!=='operator,payer,quoteSigner'||Object.keys(contracts??{}).sort().join()!=='dispenser,router,token')fail();
 const a=Object.freeze(Object.fromEntries(Object.entries(roles).map(([k,v])=>[k,addr(v)]))),c=Object.freeze(Object.fromEntries(Object.entries(contracts).map(([k,v])=>[k,addr(v)])));
 if(new Set(Object.values(a)).size!==3||typeof wallet?.signTransaction!=='function'||addr(wallet.address)!==a.payer||typeof broadcast!=='function')fail();
 const sign=wallet.signTransaction.bind(wallet);
 let next=0,blocked=false,offer=null;
 return Object.freeze({
  getAddress:async()=>a.payer,
  bindOffer(value){try{
   value=structuredClone(value);
   if(offer||next!==1||blocked||value.quote.amount!=='4200'||value.quote.requestHash!==pins.requestHash||value.resultHash!==pins.resultHash||addr(value.quote.payer)!==a.payer||addr(value.router)!==c.router||addr(value.token)!==c.token||addr(value.recipient)!==a.operator||addr(value.quoteSigner)!==a.quoteSigner||value.origin!==pins.origin||value.chainId!==11155111)fail();
   if(addr(verifyTypedData(quoteDomain(11155111,c.router),QUOTE_TYPES,value.quote,value.signature))!==a.quoteSigner)fail();
   offer=Object.freeze(structuredClone(value));
  }catch{fail();}},
  async sendTransaction(request){
   try{
    assertRecoveryTime();
    if(!request||Object.getPrototypeOf(request)!==Object.prototype||Object.values(Object.getOwnPropertyDescriptors(request)).some(d=>!Object.hasOwn(d,'value')))fail();
    request=structuredClone(request);
    if(blocked||next>2||!request||Object.keys(request).sort().join()!=='chainId,data,from,gasLimit,maxFeePerGas,maxPriorityFeePerGas,nonce,to,type,value')fail();
    const i=next,gas=['500000','250000','500000'][i];
    if(i>0&&!offer)fail();
    if(request.type!==2||String(request.chainId)!=='11155111'||addr(request.from)!==a.payer||String(request.nonce)!==String(i)||String(request.value)!=='0'||String(request.gasLimit)!==gas||String(request.maxFeePerGas)!=='2000000000'||String(request.maxPriorityFeePerGas)!=='1000000000')fail();
    const data=i===0?'0x4e71d92d':i===1?token.encodeFunctionData('approve',[c.router,'4200']):offer?router.encodeFunctionData('pay',[offer.quote,offer.signature]):null;
    if(addr(request.to)!==[c.dispenser,c.token,c.router][i]||request.data!==data)fail();
    const {from,...rest}=request,exact=Object.freeze({...rest,accessList:Object.freeze([])}),expectedEncoding=serial(exact);
    blocked=true; // Includes signer failure, missing hash or lost RPC response.
    assertRecoveryTime();
    const raw=await sign(exact),tx=Transaction.from(raw);
    if(tx.type!==2||tx.from?.toLowerCase()!==a.payer||tx.unsignedSerialized!==expectedEncoding||!tx.hash||tx.serialized!==raw)fail();
    assertRecoveryTime();
    const hash=await broadcast(raw,tx.hash);if(hash!==tx.hash)fail();next++;blocked=false;return{hash};
   }catch{fail();}
  },
 });
}

/** Exactly one fixed-endpoint JSON-RPC submission; no retries/replacements. */
export async function broadcastPayerTransaction(raw,expectedHash){
 try{
  assertRecoveryTime();
  const response=await fetch(pins.rpc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_sendRawTransaction',params:[raw]}),redirect:'error',credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(10000)});
  if(!response.ok||response.redirected||(response.url&&response.url!==pins.rpc&&response.url!==pins.rpc+'/'))fail();
  const reader=response.body?.getReader();if(!reader)fail();let size=0;const chunks=[];
  try{for(;;){const{done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>262144){await reader.cancel();fail();}chunks.push(value);}}finally{reader.releaseLock();}
  const reply=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(Object.keys(reply).sort().join()!=='id,jsonrpc,result'||reply.id!==1||reply.jsonrpc!=='2.0'||reply.result!==expectedHash)fail();return reply.result;
 }catch{fail();}
}
