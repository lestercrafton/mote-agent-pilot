import { Interface, TypedDataEncoder, verifyTypedData } from 'ethers';
import { assert, address, hash32, NETWORKS, validatePaymentEnvelope, authDomain, AUTH_TYPES, bindDomain, BIND_TYPES } from './protocol.mjs';

// Deployed accounts only. A 6492 deployment envelope is deliberately outside this
// adapter: no factory calls, deployment, delegation or signature extraction.
const MAGIC = '0x1626ba7e' + '00'.repeat(28);
const SUFFIX6492 = '6492'.repeat(16);
export const MAX_SIGNATURE_BYTES = 4096;
export const ERC1271 = new Interface(['function isValidSignature(bytes32 hash,bytes signature) view returns (bytes4)']);
const quantity = x => { assert(typeof x === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(x), 'RPC_QUANTITY'); return BigInt(x); };
export function opaqueSignature(signature) {
  assert(typeof signature === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(signature) && signature.length <= 2+2*MAX_SIGNATURE_BYTES, 'SIGNATURE_FORMAT');
  assert(!signature.toLowerCase().endsWith(SUFFIX6492), 'UNDEPLOYED_SIGNATURE_UNSUPPORTED');
  return signature;
}

// The supplied RPC must be read-only and bounded (rpcReader). Every check uses a
// single finalized EIP-1898 block-hash snapshot. State failure never falls back to
// EOA recovery for a code-bearing account, nor to latest/pending state.
export class DeployedSignatureVerifier {
  constructor({network,rpc}) { assert(NETWORKS[network] && typeof rpc === 'function', 'SIGNATURE_VERIFIER_CONFIG'); this.network=network; this.rpc=rpc; }
  async verifyMany(requests) {
    const snapshot=structuredClone(requests);
    assert(Array.isArray(snapshot) && snapshot.length>=1 && snapshot.length<=2, 'SIGNATURE_CHECK_LIMIT');
    for(const r of snapshot) { address(r.payer); opaqueSignature(r.signature); assert(BigInt(r.typedData.domain.chainId)===BigInt(NETWORKS[this.network].chainId),'SIGNATURE_CHAIN'); TypedDataEncoder.hash(r.typedData.domain,r.typedData.types,r.typedData.message); }
    assert(quantity(await this.rpc('eth_chainId',[]))===BigInt(NETWORKS[this.network].chainId),'CHAIN_MISMATCH');
    const f=await this.rpc('eth_getBlockByNumber',['finalized',false]);
    assert(f && hash32(f.hash),'FINALITY_UNAVAILABLE'); quantity(f.number); quantity(f.timestamp);
    const ref={blockHash:f.hash,requireCanonical:true}, codes=new Map();
    for(const r of snapshot) {
      const payer=address(r.payer), t=r.typedData;
      if(!codes.has(payer)) { const code=await this.rpc('eth_getCode',[payer,ref]); assert(typeof code==='string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(code) && code.length<=131074,'ACCOUNT_CODE'); codes.set(payer,code); }
      if(codes.get(payer)==='0x') {
        assert(/^0x[0-9a-fA-F]{130}$/.test(r.signature),'EOA_ONLY');
        assert(address(verifyTypedData(t.domain,t.types,t.message,r.signature))===payer,'PAYMENT_SIGNATURE');
      } else {
        const hash=TypedDataEncoder.hash(t.domain,t.types,t.message);
        const result=await this.rpc('eth_call',[{to:payer,data:ERC1271.encodeFunctionData('isValidSignature',[hash,r.signature]),gas:'0x7a120'},ref]);
        assert(typeof result==='string' && result.toLowerCase()===MAGIC,'CONTRACT_SIGNATURE_INVALID');
      }
    }
    const again=await this.rpc('eth_getBlockByNumber',[f.number,false]);
    assert(again?.number===f.number && again?.hash===f.hash,'FINALITY_CHANGED');
    return Object.freeze({network:this.network,blockNumber:f.number,blockHash:f.hash});
  }
}

// This opt-in validator preserves all existing amount, request, offer, identity,
// resource, time and replay fields; only the cryptographic signature method differs.
export function deployedPaymentValidator(verifier) {
  return async(c,input,payment,now,options) => {
    input=structuredClone(input);payment=structuredClone(payment);
    assert(verifier.network===c.network,'SIGNATURE_CHAIN');
    const {value,authorization,binding,authorizationSignature,bindingSignature}=validatePaymentEnvelope(c,input,payment,now,options);
    const signatureEvidence=await verifier.verifyMany([
      {payer:value.payer,typedData:{domain:authDomain(c),types:AUTH_TYPES,message:authorization},signature:authorizationSignature},
      {payer:value.payer,typedData:{domain:bindDomain(c),types:BIND_TYPES,message:binding},signature:bindingSignature},
    ]);
    return {...value,signatureEvidence};
  };
}
