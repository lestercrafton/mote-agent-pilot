import test from 'node:test';
import A from 'node:assert/strict';
import { writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBytes, verifyMessage } from 'ethers';
import { validatePayment, BINDING, requirements, config, address, AUTH_TYPES, authDomain, BIND_TYPES, bindDomain, bindingMessage } from '../src/protocol.mjs';
import { hashJson } from '../src/core/json.mjs';
import { Journal } from '../src/journal.mjs';
import { Service } from '../src/service.mjs';
import { authorize, recoverAuthorization } from '../src/client.mjs';
import { fixture, input, PUBLIC_FIXTURE_PAYER, PUBLIC_FIXTURE_OPERATOR, signer, H } from './fixtures.mjs';

const run = (name, fn, options = {}) => test(name, async () => { const f = fixture(options); try { await fn(f); } finally { f.close(); } });
run('official exact SDK -> signed request -> fixture finalized proof -> signed receipt; duplicate is byte-identical', async f => {
  const p = await f.payment(); const result = await f.service.execute(input, p);
  A.equal(result.status, 'complete'); A.equal(result.result.valid, true);
  A.equal(address(verifyMessage(getBytes(hashJson(result.receipt)), result.signature)), f.c.offerSigner);
  A.deepEqual(await f.service.execute(input, p), result);
  A.equal(f.facilitator.settleCalls, 1); A.equal(f.journal.attempts(), 1);
});
run('402 advertises official payment identifier and mandatory custom profile', async f => {
  const offer = await f.service.offer(input);
  A.equal(offer.extensions['payment-identifier'].info.required, true);
  A.equal(offer.extensions[BINDING].info.required, true);
  A.deepEqual(Object.keys(offer.extensions).sort(), [BINDING, 'payment-identifier'].sort());
});
for (const [name, edit] of [
  ['network', p => { p.accepted.network = 'eip155:1'; }], ['asset', p => { p.accepted.asset = PUBLIC_FIXTURE_PAYER.address; }],
  ['amount', p => { p.payload.authorization.value = '999'; }], ['payee', p => { p.payload.authorization.to = PUBLIC_FIXTURE_PAYER.address; }],
  ['nonce', p => { p.payload.authorization.nonce = H(8); }], ['resource', p => { p.resource.url += '/evil'; }],
  ['payment ID', p => { p.extensions['payment-identifier'].info.id = 'replacement-id-0000'; }],
  ['binding omitted', p => { delete p.extensions[BINDING]; }], ['Permit2', p => { p.accepted.extra.assetTransferMethod = 'permit2'; }],
  ['smart wallet signature', p => { p.payload.signature += '00'; }], ['offer', p => { p.extensions[BINDING].info.offer.body.resultHash = H(9); }],
]) run(`reject ${name} mutation before provider call`, async f => { const p = await f.payment(); edit(p); await A.rejects(f.service.execute(input, p)); A.equal(f.facilitator.verifyCalls, 0); A.equal(f.facilitator.settleCalls, 0); });
run('body substitution including embedded instructions is rejected before provider call', async f => {
  const p = await f.payment(); await A.rejects(f.service.execute({ document: 'new task' }, p)); A.equal(f.facilitator.verifyCalls, 0);
});
run('nonce replay under a new signed payment ID conflicts with durable authorization identity', async f => {
  const p = await f.payment(); await f.service.execute(input, p);
  p.extensions['payment-identifier'].info.id = 'different-id-00001';
  const info = p.extensions[BINDING].info;
  info.signature = await PUBLIC_FIXTURE_PAYER.signTypedData(bindDomain(f.c), BIND_TYPES, bindingMessage(f.c, input, info.offer, 'different-id-00001', p.payload.authorization));
  await A.rejects(f.service.execute(input, p), /IDEMPOTENCY_CONFLICT/); A.equal(f.facilitator.settleCalls, 1);
});
run('same ID with a different valid authorization conflicts', async f => {
  const p = await f.payment(); await f.service.execute(input, p);
  p.payload.authorization.nonce = H(123);
  p.payload.signature = await PUBLIC_FIXTURE_PAYER.signTypedData(authDomain(f.c), AUTH_TYPES, p.payload.authorization);
  const info = p.extensions[BINDING].info;
  info.signature = await PUBLIC_FIXTURE_PAYER.signTypedData(bindDomain(f.c), BIND_TYPES, bindingMessage(f.c, input, info.offer, p.extensions['payment-identifier'].info.id, p.payload.authorization));
  await A.rejects(f.service.execute(input, p), /IDEMPOTENCY_CONFLICT/);
});
run('lost facilitator response reconciles AuthorizationUsed without a second settle', async f => {
  f.facilitator.settle = async p => { f.facilitator.settleCalls++; await f.chain.settle(p); throw Error('response dropped'); };
  const p = await f.payment(); A.equal((await f.service.execute(input, p)).status, 'pending');
  const r = await f.service.execute(input, p); A.equal(r.status, 'complete'); A.equal(f.facilitator.settleCalls, 1);
});
run('completed response can be recovered after process restart and authorization expiry', async f => {
  const p = await f.payment(); const result = await f.service.execute(input, p); f.chain.now += 1000;
  const j = new Journal(join(f.dir, 'server.sqlite'), f.c.identity);
  try { const s = new Service({ config: f.c, journal: j, facilitator: { settle() { throw Error('must not settle'); } }, proof: f.proof, receiptSigner: PUBLIC_FIXTURE_OPERATOR, now: () => f.chain.now }); A.deepEqual(await s.execute(input, p), result); } finally { j.close(); }
});
run('concurrent copies produce only one verification/settlement; other copies recover', async f => {
  const p = await f.payment(); const outcomes = await Promise.all(Array.from({ length: 8 }, () => f.service.execute(input, p)));
  A.equal(f.facilitator.verifyCalls, 1); A.equal(f.facilitator.settleCalls, 1); A.equal((await f.service.execute(input, p)).status, 'complete');
  A.ok(outcomes.every(r => ['pending', 'complete'].includes(r.status)));
});
for (const point of ['afterReservation', 'afterSettlement', 'beforeReceiptCommit']) run(`crash at ${point} retains reservation; recovery never resends`, async f => {
  const p = await f.payment(); f.service.hook = async stage => { if (stage === point) throw Error('simulated crash'); };
  await A.rejects(f.service.execute(input, p), /simulated crash/);
  const before = f.facilitator.settleCalls; f.service.hook = async () => {};
  const result = await f.service.execute(input, p);
  A.equal(result.status, point === 'afterReservation' ? 'pending' : 'complete'); A.equal(f.facilitator.settleCalls, before); A.equal(f.journal.attempts(), 1);
});
run('failed settlement retained until finalized expiry plus unused proof; no automatic refund or retry', async f => {
  f.facilitator.settle = async () => { f.facilitator.settleCalls++; return { success: false, network: f.c.network, transaction: '' }; };
  const p = await f.payment(); A.equal((await f.service.execute(input, p)).status, 'pending');
  f.chain.now += 181; A.equal((await f.service.execute(input, p)).status, 'unsettled');
  A.equal(f.journal.pruneUnsettled(f.chain.now), 1); A.equal(f.journal.attempts(), 1);
  await A.rejects(f.service.execute(input, p), /EXPIRED/); A.equal(f.facilitator.settleCalls, 1);
});
run('provider verify rejection consumes bounded verification allowance but no settlement fee slot', async f => {
  f.facilitator.verify = async () => { f.facilitator.verifyCalls++; return { isValid: false }; };
  const p = await f.payment(); await A.rejects(f.service.execute(input, p), /FACILITATOR_REJECTED/);
  A.equal((await f.service.execute(input, p)).status, 'pending'); A.equal(f.facilitator.verifyCalls, 1); A.equal(f.journal.attempts(), 0);
});
run('anonymous quote churn creates no journal records', async f => {
  for (let n = 0; n < 300; n++) { f.chain.now += 1; await f.service.offer(input); }
  A.equal(f.journal.db.prepare('SELECT count(*) AS n FROM orders').get().n, 0);
  A.equal(f.journal.db.prepare('SELECT count(*) AS n FROM verification').get().n, 0);
  A.equal(f.facilitator.verifyCalls, 0);
});
run('operator settlement cap blocks before provider traffic and remains across restart', async f => {
  const p = await f.payment(); await f.service.execute(input, p);
  const p2 = await f.payment('fixture-payment-0002');
  await A.rejects(f.service.execute(input, p2), /FACILITATOR_BUDGET/); A.equal(f.facilitator.verifyCalls, 1);
  const j = new Journal(join(f.dir, 'server.sqlite'), f.c.identity, { maxAttempts: 1 }); A.equal(j.attempts(), 1); j.close();
}, { limits: { maxAttempts: 1 } });
run('unresolved submissions retain pending cap', async f => {
  f.facilitator.settle = async () => { throw Error('unknown'); };
  await f.service.execute(input, await f.payment());
  await A.rejects(f.service.execute(input, await f.payment('fixture-payment-0002')), /PENDING_CAP/);
}, { limits: { maxPending: 1 } });
run('client durable amount cap prevents further signing and recovery never calls signer', async f => {
  const p = await f.payment(); A.deepEqual(recoverAuthorization(f.clientJournal, 'fixture-payment-0001'), p);
  await A.rejects(f.payment('fixture-payment-0002'), /CLIENT_BUDGET/);
}, { clientBudget: '1000' });
run('client uncertain signature intent is retained instead of signing again', async f => {
  const offerResponse = await f.service.offer(input); let calls = 0;
  const args = { config: f.c, input, offerResponse, paymentId: 'uncertain-sign-0001', policy: f.policy, journal: f.clientJournal, signer: { address: PUBLIC_FIXTURE_PAYER.address, async signTypedData() { calls++; throw Error('wallet response lost'); } }, now: f.chain.now };
  await A.rejects(authorize(args), /wallet response lost/); await A.rejects(authorize(args), /CLIENT_SIGNING_UNCERTAIN/); A.equal(calls, 1);
});
run('policy mismatch fails before signing', async f => {
  const offerResponse = await f.service.offer(input); let calls = 0;
  await A.rejects(authorize({ config: f.c, input, offerResponse, paymentId: 'policy-mismatch-0001', policy: { ...f.policy, network: 'eip155:1' }, journal: f.clientJournal, signer: { address: PUBLIC_FIXTURE_PAYER.address, async signTypedData() { calls++; } }, now: f.chain.now }), /CLIENT_JOURNAL_IDENTITY/); A.equal(calls, 0);
});
run('journal mismatched identity and budget fail closed', async f => {
  A.throws(() => new Journal(join(f.dir, 'server.sqlite'), 'wrong'), /JOURNAL_IDENTITY/);
  A.throws(() => new Journal(join(f.dir, 'server.sqlite'), f.c.identity, { maxAttempts: 999 }), /JOURNAL_IDENTITY/);
});
run('unavailable/corrupt/unsafe-mode journal is not recreated', async f => {
  A.throws(() => new Journal(join(f.dir, 'missing.sqlite'), f.c.identity));
  const p = join(f.dir, 'bad.sqlite'); writeFileSync(p, 'corrupt', { mode: 0o600 }); A.throws(() => new Journal(p, f.c.identity)); A.equal(readFileSync(p, 'utf8'), 'corrupt');
  chmodSync(p, 0o644); A.throws(() => new Journal(p, f.c.identity), /JOURNAL_PERMISSIONS/);
});
run('preallocated storage budget blocks an oversized durable order before settlement', async f => {
  const large = { document: 'x'.repeat(20000) }; const p = await f.payment('storage-limit-0001', large);
  await A.rejects(f.service.execute(large, p), /STORAGE_BUDGET/); A.equal(f.facilitator.settleCalls, 0); A.equal(f.journal.attempts(), 0);
}, { limits: { storageBudgetBytes: 32768 } });
run('service rejects a changed receipt signer or journal identity before operation', async f => {
  A.throws(() => new Service({ config:f.c, journal:f.journal, facilitator:f.facilitator, proof:f.proof, receiptSigner:PUBLIC_FIXTURE_PAYER }), /SERVICE_IDENTITY/);
});
run('completed receipt tampering fails closed instead of returning altered results', async f => {
  const p=await f.payment(); await f.service.execute(input,p);
  f.journal.db.prepare("UPDATE orders SET response='{}'").run(); await A.rejects(f.service.execute(input,p), /RECEIPT_CORRUPT/);
});
run('Base mainnet domain/asset configuration works only in a clearly synthetic fixture', async f => {
  const p=await f.payment(); const r=await f.service.execute(input,p); A.equal(r.status,'complete'); A.equal(r.receipt.network,'eip155:8453'); A.equal(p.accepted.extra.name,'USD Coin');
}, { config:{network:'eip155:8453'} });
