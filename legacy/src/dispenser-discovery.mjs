import { Interface, getAddress } from 'ethers';

const CLAIM = new Interface(['function claim()']);
const HASH = /^0x[0-9a-f]{64}$/;
const UINT = /^(0|[1-9]\d*)$/;
const sameAddress = (a,b) => { try { return getAddress(a)===getAddress(b); } catch { return false; } };
const check = (ok) => { if(!ok) throw Object.assign(new Error('Dispenser identity differs from the verified service deployment.'),{code:'DISPENSER_IDENTITY_MISMATCH'}); };

/** Derive disclosure only from an already verified adapter identity. Never a spend grant. */
export function dispenserMetadata(base, identity) {
  check(base?.chainId===11155111 && identity?.chainId===11155111 && identity.origin===base.origin
    && identity.baseConfigHash===base.configHash && HASH.test(identity.dispenserConfigHash??'')
    && HASH.test(identity.runtimeCodeHash??'') && HASH.test(identity.genesisHash??'')
    && identity.genesisHash===base.genesisHash);
  for(const key of ['token','router','recipient','quoteSigner']) check(sameAddress(base[key],identity[key]));
  check(sameAddress(identity.dispenser,identity.dispenser) && identity.dispenser!=='0x'+'0'.repeat(40));
  check(UINT.test(identity.claimAmount??'') && UINT.test(identity.distributionCap??'')
    && identity.claimAmount.length<=16 && identity.distributionCap.length<=16);
  const amount=BigInt(identity.claimAmount),cap=BigInt(identity.distributionCap);
  check(amount>0n && amount<=10_000_000n && cap>=amount && cap<=10_000_000_000n && cap%amount===0n
    && identity.maxClaims===(cap/amount).toString() && identity.claimsPerAddress===1 && identity.testOnly===true && identity.sybilResistance===false);
  for(const key of ['deployment','funding']) check(HASH.test(identity[key]?.transactionHash??'') && HASH.test(identity[key]?.blockHash??''));
  return {
    schema:'mote-test-dispenser-discovery-v1', testOnly:true, assetValueClaim:false,
    chainId:11155111, origin:base.origin, token:identity.token, dispenser:identity.dispenser,
    decimals:6, claimAmount:identity.claimAmount, distributionCap:identity.distributionCap,
    maxClaims:identity.maxClaims, claimsPerAddress:1, sybilResistance:false,
    callerPaysTestEthGas:true, serverSubmitsClaim:false, noTopupService:true,
    source:'pre-funded fixed token supply; no minting', excessFundingWithdrawable:false,
    transaction:{type:2,chainId:11155111,to:identity.dispenser,value:'0',data:CLAIM.encodeFunctionData('claim')},
    authorization:{discoveryGrantsSpending:false,callerPolicyRequired:true,exactChainAndDestinationRequired:true,feeReservationRequired:true},
    verification:{baseConfigHash:identity.baseConfigHash,dispenserConfigHash:identity.dispenserConfigHash,
      genesisHash:identity.genesisHash,runtimeCodeHash:identity.runtimeCodeHash,
      deployment:structuredClone(identity.deployment),funding:structuredClone(identity.funding),checkpoint:structuredClone(identity.checkpoint)},
    limitations:['One actor can exhaust the reserve using multiple addresses.','Metadata and hashes do not independently establish RPC consensus or wallet permission.','Reverify canonical deployment and current claim eligibility before signing.','Unknown submissions must be reconciled without resubmitting or silently using another wallet.'],
  };
}
