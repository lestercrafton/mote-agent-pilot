import {config} from './protocol.mjs';
import {hashJson} from './core/json.mjs';
import {PROPOSED_LIMITS,PRODUCTION_ACTIVATION,validateProductionSettings} from './production-policy.mjs';
import {RELEASE_ORIGIN} from './release-binding.mjs';
// Nonsecret assembly only. No file creation, network, wallet generation or activation.
export function productionDraft({payTo,receiptSigner,notBefore,notAfter}) {
  const operation={notBefore,notAfter,providerSettlementUnitUsd:'0.001',providerAuthorizationUsd:'1.00',purpose:'bounded-receive-beta'};
  const settings={config:config({origin:RELEASE_ORIGIN,path:'/v1/usdc/audit',network:'eip155:8453',payTo,offerSigner:receiptSigner,amount:'10000',policyEpoch:'base-usdc-beta:'+hashJson(operation)}),limits:PROPOSED_LIMITS,rpcUrl:'https://mainnet.base.org',offhost:{enabled:false,destination:null},operation,backup:{intervalSeconds:3600,maxAgeSeconds:7200,maxSnapshots:26,maxTotalBytes:256*1024*1024}};
  const settingsHash=hashJson(settings);
  validateProductionSettings({MOTE_USDC_ENABLED:'true',MOTE_USDC_ACTIVATION:PRODUCTION_ACTIVATION,MOTE_USDC_SETTINGS_HASH:settingsHash,MOTE_PUBLIC_ORIGIN:RELEASE_ORIGIN},settings);
  return {enabled:false,activationAuthorized:false,settingsHash,settings};
}
