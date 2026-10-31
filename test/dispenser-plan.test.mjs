import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, getCreateAddress } from 'ethers';
import { createDispenserPlan, validateDispenserPlan } from '../src/dispenser-plan.mjs';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const input = { chainId:11155111, token:'0x0000000000000000000000000000000000000011', tokenRuntimeHash:'0x'+'11'.repeat(32), deployer:'0x0000000000000000000000000000000000000022', nonce:'2', claimAmount:'10000000', distributionCap:'10000000000' };
test('unsigned dispenser add-on pins reserve, constructor and deterministic creation/funding without permission', () => {
  const p = createDispenserPlan(input);
  assert.deepEqual(validateDispenserPlan(p), p);
  assert.equal(p.contract.predictedAddress, getCreateAddress({from:input.deployer,nonce:2}));
  assert.equal(p.contract.maxClaims, '1000');
  assert.equal(p.genesisHash,'0x25a5cc106eea7138acab33231d7160d69cb777ee0c2c553fcddf5138993e6dd9');
  assert.equal(p.transactions.length, 2);
  assert.equal(p.transactions[0].to, null);
  assert.equal(p.transactions[1].nonce, '3');
  const parsed = new Interface(['function transfer(address,uint256) returns(bool)']).parseTransaction(p.transactions[1]);
  assert.equal(parsed.args[0], p.contract.predictedAddress);
  assert.equal(parsed.args[1], 10_000_000_000n);
  for(const k of ['authorization','broadcastReady','publicDeployment','tokenEvidenceVerified','feesIncluded']) assert.equal(p[k],false);
  assert.equal(p.limits.supplyMinted,'0');
});
test('preparation CLI writes only a new unsigned plan and rejects duplicates and overwrite', () => {
  const dir=mkdtempSync(join(tmpdir(),'mote-dispenser-plan-'));
  try {
    const config=join(dir,'public.json'),out=join(dir,'plan.json');
    writeFileSync(config,JSON.stringify(input));
    const run=()=>spawnSync(process.execPath,['scripts/prepare-dispenser.mjs','--config',config,'--out',out],{encoding:'utf8'});
    const first=run();assert.equal(first.status,0,first.stderr);
    const bytes=readFileSync(out,'utf8');assert.equal(JSON.parse(bytes).authorization,false);
    assert.equal(run().status,1);assert.equal(readFileSync(out,'utf8'),bytes);
    writeFileSync(config,'{"chainId":11155111,"chainId":1}');assert.equal(run().status,1);
    assert.equal(readFileSync(out,'utf8'),bytes);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('dispenser plan rejects chain, caps, identities, unknown fields and unsafe nonce', () => {
  for(const changes of [{chainId:1},{claimAmount:'0'},{claimAmount:'10000001'},{distributionCap:'10000000001'},{distributionCap:'10000001'},{token:'0x'+'0'.repeat(40)},{tokenRuntimeHash:'0x'+'0'.repeat(64)},{tokenRuntimeHash:'0x'+'AA'.repeat(32)},{nonce:'9007199254740991'},{nonce:'02'},{extra:true}]) assert.throws(()=>createDispenserPlan({...input,...changes}));
});
test('dispenser plans reject modified calldata, cap, token pin, authorization and hash', () => {
  const p=createDispenserPlan(input);
  for(const mutate of [x=>x.transactions[1].data+='00',x=>x.contract.distributionCap='20000000000',x=>x.expectedTokenRuntimeHash='0x'+'22'.repeat(32),x=>x.authorization=true,x=>x.planHash='0x'+'ff'.repeat(32)]) {
    const copy=structuredClone(p);mutate(copy);assert.throws(()=>validateDispenserPlan(copy));
  }
});
