// Fixed, public R1 recovery scope. No secret material and no live side effects.
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
export const R1=freeze({
 approvedAt:Date.parse('2026-10-31T21:12:50Z'),
 expiresAt:Date.parse('2026-11-01T21:12:50Z'),
 operationalDeadline:Date.parse('2026-11-01T18:00:00Z'),
 operator:'0x73726b075180bc8e62d271566fb46638cddffdc2',
 quoteSigner:'0x8f57c258feddf0081047af41f44f49b18fd5c5fa',
 originalPayer:'0x42cf06e8fb79762395760ab6b7ecb7ae9b8229fd',
 originalPlanHash:'0x4f67bfe1944168f05f1cf061bbc358455b6fd9f10b47026f1e96c7bc5c537a0b',
 originalPolicyHash:'0xcf7f6669b790ee718423b870429fc0efd9dfb319ebd3f748f82273e0ef469e31',
 combinedCeilingWei:'44500000000000000',
 spentPlusRemainingCeilingsWei:'29156510126383228',
 adopted:[
 {index:0,transactionHash:'0x881c318ba60ad3d560084d0543d8a62f5ab41e69f5764d6e78fab6ccddbe5902',feeWei:'3464422048501908',finalizedAnchor:{blockNumber:'12033655',blockHash:'0xbc9525bee7599b74362f35f75e494a562be6d7f76403ac55c611a5c5e98fd492'}},
 {index:1,transactionHash:'0x081b544d7770df798e49ae76dc8dd3cca282e4f8e0a82d527b35fbf35a3219d4',feeWei:'5192088077881320',finalizedAnchor:{blockNumber:'12033750',blockHash:'0x482c2a86eeacc06414bf049a5781b00fd7af399c4abcee2530999bdde4d4a3cc'}}
 ],
 storedProofFallback:false
});
export function assertRecoveryTime(now=Date.now()){
 if(!Number.isSafeInteger(now)||now<R1.approvedAt||now>=R1.operationalDeadline||now>=R1.expiresAt)
  throw Object.assign(Error('R1_AUTHORIZATION_EXPIRED_OR_NOT_STARTED'),{code:'R1_AUTHORIZATION_EXPIRED_OR_NOT_STARTED'});
}
export function recoverySourceCommit(){
 const s=process.env.MOTE_RECOVERY_SOURCE_COMMIT;
 if(!/^[a-f0-9]{40}$/.test(s??''))throw Object.assign(Error('R1_SOURCE_COMMIT_REQUIRED'),{code:'R1_SOURCE_COMMIT_REQUIRED'});
 return s;
}
export function recoverySourceManifest(){
 const s=process.env.MOTE_RECOVERY_SOURCE_MANIFEST_SHA256;
 if(!/^[a-f0-9]{64}$/.test(s??''))throw Object.assign(Error('R1_SOURCE_MANIFEST_REQUIRED'),{code:'R1_SOURCE_MANIFEST_REQUIRED'});
 return s;
}
