import {getBytes,verifyMessage} from 'ethers';
import {assert,address,hash32,authHash,equal,BINDING,NETWORKS} from './protocol.mjs';
import {hashJson} from './core/json.mjs';
export const ADMISSION='mote-deployed-signature-admission';
function fields(c,payment){
 const info=payment.extensions?.[BINDING]?.info,a=payment.payload?.authorization,offer=info?.offer,id=payment.extensions?.['payment-identifier']?.info?.id;
 const message={origin:c.origin,method:c.method,path:c.path,requestHash:offer.body.requestHash,offerHash:hashJson(offer.body),paymentId:id,authorizationHash:authHash(c,a)};
 return {format:'mote-deployed-admission-v1',configHash:c.identity,network:c.network,payer:address(a.from),requestFingerprint:hashJson({message,accepted:payment.accepted}),authorizationHash:message.authorizationHash,authorizationSignatureHash:hashJson(payment.payload.signature),bindingSignatureHash:hashJson(info.signature)};
}
export async function attestAdmission(c,payment,value,signer,checkedAt){
 const e=value.signatureEvidence;
 assert(e?.network===c.network && address(signer.address)===c.offerSigner,'ADMISSION_EVIDENCE');
 const body={...fields(c,payment),checkedAt,blockNumber:e.blockNumber,blockHash:e.blockHash};
 assert(body.requestFingerprint===value.fingerprint&&body.payer===value.payer,'ADMISSION_EVIDENCE');
 const certificate={body,signature:await signer.signMessage(getBytes(hashJson(body)))};
 const out=structuredClone(payment);out.extensions[ADMISSION]=certificate;
 validateAdmission(c,out);return out;
}
// A durable server attestation proves prior validation, not current authority.
// Used only to audit stored records / retrieve the same record read-only. New
// payments always pass full current chain verification and facilitator checks.
export function validateAdmission(c,payment){
 const cert=payment.extensions?.[ADMISSION],b=cert?.body;
 assert(cert&&Object.keys(cert).sort().join(',')==='body,signature'&&b,'ADMISSION_EVIDENCE');
 assert(Number.isSafeInteger(b.checkedAt)&&/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(b.blockNumber)&&hash32(b.blockHash),'ADMISSION_EVIDENCE');
 const offer=payment.extensions[BINDING].info.offer.body,a=payment.payload.authorization;
 assert(b.checkedAt>=offer.issuedAt&&b.checkedAt<offer.expiresAt&&BigInt(b.checkedAt)<BigInt(a.validBefore),'ADMISSION_TIME');
 const expected={...fields(c,payment),checkedAt:b.checkedAt,blockNumber:b.blockNumber,blockHash:b.blockHash};
 assert(equal(b,expected)&&address(verifyMessage(getBytes(hashJson(b)),cert.signature))===c.offerSigner,'ADMISSION_SIGNATURE');
 return b;
}
