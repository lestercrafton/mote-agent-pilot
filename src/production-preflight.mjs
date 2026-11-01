import {config,assert,address} from './protocol.mjs';
import {RELEASE_ORIGIN} from './release-binding.mjs';
// Preview is intentionally not a paid configuration: no journal, time window,
// offer, signature, verify or settlement. It cannot consume/reset an economic cap.
export function preflightConfig(draft) {
  assert(draft&&Object.keys(draft).sort().join(',')==='enabled,offerSigner,payTo'&&draft.enabled===false,'PREFLIGHT_DRAFT');
  assert(address(draft.payTo)!==address(draft.offerSigner),'PREFLIGHT_SIGNER');
  return config({origin:RELEASE_ORIGIN,path:'/v1/usdc/audit',network:'eip155:8453',payTo:draft.payTo,offerSigner:draft.offerSigner,amount:'10000',policyEpoch:'preflight-no-payment-authority'});
}
export async function checkProductionDependencies({c,receiptSigner,facilitator,proof}) {
  assert(c.policyEpoch==='preflight-no-payment-authority'&&c.network==='eip155:8453'&&address(receiptSigner.address)===c.offerSigner,'PREFLIGHT_IDENTITY');
  await facilitator.supported(c);await proof.anchor();
  return {preflight:true,previewOnly:true,network:c.network,newPayments:false,journalCreated:false};
}
