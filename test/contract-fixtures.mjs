import {AbiCoder,TypedDataEncoder,verifyTypedData,Signature,Transaction} from 'ethers';
import {FixtureChain,PUBLIC_FIXTURE_PAYER,PUBLIC_FIXTURE_OPERATOR,H} from './fixtures.mjs';
import {ERC1271} from '../src/contract-signatures.mjs';
import {authorizationCalldata,USDC_ABI} from '../src/chain-proof.mjs';
import {NETWORKS} from '../src/protocol.mjs';
export const CONTRACT='0x000000000000000000000000000000000000bEEF';
const abi=AbiCoder.defaultAbiCoder();
export const WRAPPER=['tuple(uint256 ownerIndex,bytes signatureData)'];
export const REPLAY_TYPES={CoinbaseSmartWalletMessage:[{name:'hash',type:'bytes32'}]};
export const replayDomain=(chainId,payer)=>({name:'Coinbase Smart Wallet',version:'1',chainId,verifyingContract:payer});
export async function wrapTyped(t,payer=CONTRACT,owner=PUBLIC_FIXTURE_PAYER){
 const inner=await owner.signTypedData(replayDomain(t.domain.chainId,payer),REPLAY_TYPES,{hash:TypedDataEncoder.hash(t.domain,t.types,t.message)});
 return abi.encode(WRAPPER,[[0n,inner]]);
}
export function checkWrapped(hash,sig,payer,chainId){
 try {const [v]=abi.decode(WRAPPER,sig);return v.ownerIndex===0n&&abi.encode(WRAPPER,[[v.ownerIndex,v.signatureData]])===sig&&verifyTypedData(replayDomain(chainId,payer),REPLAY_TYPES,{hash},v.signatureData)===PUBLIC_FIXTURE_PAYER.address;}catch{return false;}
}
export class ContractFixtureChain extends FixtureChain {
 constructor(c,now){super(c,now);this.revoked=false;this.signatureCalls=[];this.contractOverride=null;}
 baseRpc=this.rpc;
 rpc=async(method,params)=>{
  if(this.contractOverride){const x=await this.contractOverride(method,params);if(x!==undefined)return x;}
  if(method==='eth_getCode'){if(params[1].blockHash!==H(this.finalized)||params[1].requireCanonical!==true)throw Error('fixture unpinned');return params[0].toLowerCase()===CONTRACT.toLowerCase()?'0xef0100'+'11'.repeat(20):'0x';}
  if(method==='eth_call'&&params[0].data.startsWith('0x1626ba7e')){
   this.signatureCalls.push(structuredClone(params));if(params[1].blockHash!==H(this.finalized)||params[1].requireCanonical!==true)throw Error('fixture unpinned');
   const [hash,sig]=ERC1271.decodeFunctionData('isValidSignature',params[0].data);
   const valid=!this.revoked&&checkWrapped(hash,sig,params[0].to,NETWORKS[this.c.network].chainId);
   return ERC1271.encodeFunctionResult('isValidSignature',[valid?'0x1626ba7e':'0xffffffff']);
  }
  return this.baseRpc(method,params);
 };
 async settle(payment,suffix=''){
  // Fixture transaction generation only. Synthetic chain, public fixture signer.
  const a=payment.payload.authorization;if(this.used.has(a.nonce))throw Error('fixture replay');this.used.add(a.nonce);
  const index=this.transfers.size;
  const raw=await PUBLIC_FIXTURE_OPERATOR.signTransaction({type:2,chainId:NETWORKS[this.c.network].chainId,nonce:index,to:this.c.asset,value:0n,gasLimit:150000n,maxFeePerGas:1000000000n,maxPriorityFeePerGas:1000000n,accessList:[],data:authorizationCalldata(payment,{allowContractSignatures:true,encoding:this.encoding})+suffix});
  const s=Transaction.from(raw),hash=s.hash,block='0x50';
  const tx={hash,blockNumber:block,blockHash:H(80),to:this.c.asset,from:s.from,value:'0x0',input:s.data,type:'0x2',chainId:`0x${s.chainId.toString(16)}`,nonce:`0x${index.toString(16)}`,gas:`0x${s.gasLimit.toString(16)}`,maxFeePerGas:`0x${s.maxFeePerGas.toString(16)}`,maxPriorityFeePerGas:`0x${s.maxPriorityFeePerGas.toString(16)}`,accessList:[],r:s.signature.r,s:s.signature.s,yParity:`0x${s.signature.yParity.toString(16)}`,transactionIndex:`0x${index.toString(16)}`};
  const logs=[USDC_ABI.encodeEventLog(USDC_ABI.getEvent('AuthorizationUsed'),[a.from,a.nonce]),USDC_ABI.encodeEventLog(USDC_ABI.getEvent('Transfer'),[a.from,a.to,a.value])].map((l,i)=>({...l,address:this.c.asset,transactionHash:hash,removed:false,blockNumber:block,blockHash:H(80),transactionIndex:tx.transactionIndex,logIndex:`0x${(index*2+i).toString(16)}`}));
  const receipt={transactionHash:hash,blockNumber:block,blockHash:H(80),to:this.c.asset,from:s.from,type:'0x2',transactionIndex:tx.transactionIndex,status:'0x1',logs};
  this.transfers.set(hash,{tx,receipt,payment});return hash;
 }
}
