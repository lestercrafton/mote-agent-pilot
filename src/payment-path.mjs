import {Service} from './service.mjs';
import {FinalizedProof} from './chain-proof.mjs';
import {DeployedSignatureVerifier,deployedPaymentValidator} from './contract-signatures.mjs';
import {validatePayment} from './protocol.mjs';
export const CONTRACT_PROFILE='deployed-erc1271-v1';
// Explicit config identity / journal identity change. The default remains EOA.
export function paymentPath(config,rpc){
 const enabled=config.payerSignatureProfile===CONTRACT_PROFILE;
 return {proof:new FinalizedProof(config,rpc,{allowContractSignatures:enabled}),
  paymentValidator:enabled?deployedPaymentValidator(new DeployedSignatureVerifier({network:config.network,rpc})):validatePayment,
  admissionEvidence:enabled};
}
export function createPaymentService({rpc,...options}){return new Service({...options,...paymentPath(options.config,rpc)});}
