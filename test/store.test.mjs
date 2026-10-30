import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.mjs';
import { createLocalChain } from '../src/chain.mjs';
import { createService } from '../src/service.mjs';

const capacityError = (error) => error.code === 'CAPACITY' && error.status === 503;

async function withDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), 'mote-store-boundary-'));
  try { return await run(join(directory, 'boundary.sqlite')); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function seedQuotes(db, count) {
  db.prepare(`WITH RECURSIVE fixtures(n) AS (
    SELECT 1 UNION ALL SELECT n+1 FROM fixtures WHERE n < ?
  ) INSERT INTO quotes (id,idem,fingerprint,offer,result)
    SELECT 'seed-quote-'||n, 'seed-key-'||n, 'seed-fingerprint-'||n, '{"fixture":true}', '{}'
    FROM fixtures`).run(count);
}
function seedAttempts(db, count) {
  db.prepare(`WITH RECURSIVE fixtures(n) AS (
    SELECT 1 UNION ALL SELECT n+1 FROM fixtures WHERE n < ?
  ) INSERT INTO attempts (idem,quote,tx)
    SELECT 'seed-attempt-'||n, 'seed-quote-'||n, 'seed-tx-'||n FROM fixtures`).run(count);
}

test('quote capacity rejects new keys while preserving existing idempotent retries and conflicts', async () => withDatabase(async (database) => {
  const store = openStore(database, 'synthetic-store-fixture');
  const inspector = new DatabaseSync(database);
  try {
    seedQuotes(inspector, 4999);
    const offer = { fixture: 'final-slot' };
    assert.deepEqual(store.saveQuote('last-quote', 'last-key', 'last-fingerprint', offer, {}), offer);
    assert.equal(store.count(), 5000);
    assert.throws(() => store.saveQuote('excess-quote', 'excess-key', 'excess-fingerprint', {}, {}), capacityError);
    assert.equal(store.count(), 5000);
    assert.deepEqual(store.saveQuote('unused-id', 'last-key', 'last-fingerprint', { ignored: true }, {}), offer);
    assert.deepEqual(store.saveQuote('unused-seed-id', 'seed-key-1', 'seed-fingerprint-1', {}, {}), { fixture: true });
    assert.throws(() => store.saveQuote('unused-conflict-id', 'last-key', 'changed-fingerprint', {}, {}), (error) => error.code === 'IDEMPOTENCY_CONFLICT');
    assert.equal(store.byKey('excess-key'), undefined);
  } finally { inspector.close(); store.close(); }
}));

test('reconciliation-key capacity preserves prior keys and read recovery instead of growing unbounded', async () => withDatabase(async (database) => {
  const store = openStore(database, 'synthetic-store-fixture');
  const inspector = new DatabaseSync(database);
  try {
    store.saveQuote('receipt-quote', 'receipt-key', 'receipt-fingerprint', { fixture: true }, {});
    const response = { result: { fixture: true }, receipt: { transactionHash: 'receipt-tx' } };
    store.saveResponse('receipt-quote', 'receipt-tx', response);
    seedAttempts(inspector, 19999);
    store.bindAttempt('last-attempt', 'receipt-quote', 'receipt-tx');
    assert.equal(inspector.prepare('SELECT count(*) AS count FROM attempts').get().count, 20000);
    assert.throws(() => store.bindAttempt('excess-attempt', 'receipt-quote', 'receipt-tx'), capacityError);
    assert.doesNotThrow(() => store.bindAttempt('last-attempt', 'receipt-quote', 'receipt-tx'));
    assert.doesNotThrow(() => store.bindAttempt('seed-attempt-1', 'seed-quote-1', 'seed-tx-1'));
    assert.throws(() => store.bindAttempt('last-attempt', 'different-quote', 'receipt-tx'), (error) => error.code === 'IDEMPOTENCY_CONFLICT');
    assert.deepEqual(store.byId('receipt-quote').response, response);
    assert.equal(inspector.prepare('SELECT count(*) AS count FROM attempts').get().count, 20000);
  } finally { inspector.close(); store.close(); }
}));

test('concurrent quote signing cannot exceed the atomic store capacity after all callers pass precheck', async () => withDatabase(async (database) => {
  const chain = await createLocalChain();
  let service;
  let inspector;
  let release;
  let allArrived;
  let arrivals = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const arrived = new Promise((resolve) => { allArrived = resolve; });
  try {
    service = await createService({ chain, database, hooks: {
      beforeQuote: async () => { if (++arrivals === 8) allArrived(); await gate; },
    } });
    inspector = new DatabaseSync(database);
    seedQuotes(inspector, 4999);
    const payer = await chain.payer.getAddress();
    const attempts = Array.from({ length: 8 }, (_, index) => service.quote({ payer, input: { document: index } }, `capacity-race-${index}`));
    await arrived;
    assert.equal(arrivals, 8);
    release();
    const settled = await Promise.allSettled(attempts);
    assert.equal(settled.filter((item) => item.status === 'fulfilled').length, 1);
    const failures = settled.filter((item) => item.status === 'rejected');
    assert.equal(failures.length, 7);
    for (const failure of failures) assert.ok(capacityError(failure.reason));
    assert.equal(inspector.prepare('SELECT count(*) AS count FROM quotes').get().count, 5000);
    const winner = settled.findIndex((item) => item.status === 'fulfilled');
    assert.deepEqual(await service.quote({ payer, input: { document: winner } }, `capacity-race-${winner}`), settled[winner].value);
    assert.equal(await chain.token.balanceOf(payer), 100n * 10n ** 6n);
  } finally {
    release();
    inspector?.close();
    service?.close();
    await chain.close();
  }
}));
