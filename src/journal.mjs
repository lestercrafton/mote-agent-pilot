import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync, lstatSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { assert, fail, uint } from './protocol.mjs';
import { hashJson } from './core/json.mjs';
import { SCHEMA_SQL, JOURNAL_FORMAT, verifySchema } from './journal-schema.mjs';
import { diskStatus, requireDisk } from './disk.mjs';
import { validateProviderBudget, providerReservation, belowCountLimit } from './provider-budget.mjs';

// One trusted local journal; cloned/rolled-back files or signers used elsewhere are outside this boundary.
export class Journal {
  constructor(path, identity, { create = false, recoveryOnly = false, maxPending = 32, perPayer = 4, maxRecords = 10000, maxAttempts = 100, budgetEpoch = 'fixture', clientBudget = '1000000', verifyPerMinute = 120, maxVerifications = 128, storageBudgetBytes = 64 * 1024 * 1024, providerBudget } = {}) {
    for (const n of [maxPending, perPayer, verifyPerMinute, maxVerifications]) assert(Number.isSafeInteger(n) && n > 0 && n <= 100000, 'JOURNAL_LIMITS');
    if (providerBudget !== undefined) validateProviderBudget(providerBudget);
    for (const n of [maxRecords, maxAttempts]) assert((n === null && providerBudget !== undefined) || (Number.isSafeInteger(n) && n > 0 && n <= 100000), 'JOURNAL_LIMITS');
    assert(uint(clientBudget) && BigInt(clientBudget) > 0n && typeof budgetEpoch === 'string' && budgetEpoch.length > 0, 'JOURNAL_LIMITS');
    assert(Number.isSafeInteger(storageBudgetBytes) && storageBudgetBytes >= 32768 && storageBudgetBytes <= 256 * 1024 * 1024, 'JOURNAL_LIMITS');
    const parent = lstatSync(dirname(path));
    assert(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid() && (parent.mode & 0o077) === 0, 'JOURNAL_DIRECTORY');
    if (create) { const fd = openSync(path, 'wx', 0o600); closeSync(fd); }
    const st = lstatSync(path);
    assert(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.uid === process.getuid() && (st.mode & 0o077) === 0, 'JOURNAL_PERMISSIONS');
    this.path = path; this.stat = st; this.identity = hashJson(identity);
    this.db = new DatabaseSync(path);
    this.limits = { maxPending, perPayer, maxRecords, maxAttempts, budgetEpoch, clientBudget, verifyPerMinute, maxVerifications, storageBudgetBytes, ...(providerBudget === undefined ? {} : {providerBudget:structuredClone(providerBudget)}) };
    Object.freeze(this.limits.providerBudget); Object.freeze(this.limits);
    try {
      this.db.exec('PRAGMA busy_timeout=1000; PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;');
      assert(this.db.prepare('PRAGMA quick_check').get().quick_check === 'ok', 'JOURNAL_CORRUPT');
      if (create) this.db.exec(SCHEMA_SQL);
      verifySchema(this.db);
      const bound = hashJson({ identity, limits: this.limits });
      if (create) for(const [key,value] of Object.entries({identity:bound,format:JOURNAL_FORMAT,quarantine:'0',role:typeof identity==='string'?'server':'client',identityInput:JSON.stringify(identity),limits:JSON.stringify(this.limits)})) this.db.prepare('INSERT INTO metadata VALUES (?,?)').run(key,value);
      assert(this.db.prepare("SELECT value FROM metadata WHERE key='identity'").get()?.value === bound, 'JOURNAL_IDENTITY');
      assert(this.db.prepare("SELECT value FROM metadata WHERE key='format'").get()?.value===JOURNAL_FORMAT,'JOURNAL_FORMAT');
      const q=this.db.prepare("SELECT value FROM metadata WHERE key='quarantine'").get()?.value;
      assert(q==='0'||q==='1','JOURNAL_QUARANTINE'); assert(q==='0'||recoveryOnly===true,'RESTORE_REQUIRES_RECOVERY_ONLY');
      // Validate identity/quarantine before changing journal mode or snapshot bytes.
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=256;');
      this.recoveryOnly=recoveryOnly===true;
    } catch (e) { this.db.close(); throw e; }
  }
  assertNewAuthority() {
    this.check(); assert(!this.recoveryOnly && this.db.prepare("SELECT value FROM metadata WHERE key='quarantine'").get()?.value==='0','JOURNAL_QUARANTINED'); requireDisk(this.path);
  }
  readiness() { this.check(); const storage=diskStatus(this.path); const quarantined=this.recoveryOnly||this.db.prepare("SELECT value FROM metadata WHERE key='quarantine'").get()?.value!=='0'; return { recoveryAvailable:true,newAdmissionAllowed:!quarantined&&storage.newAdmissionAllowed,quarantined,storage }; }
  check() {
    const st = lstatSync(this.path); const parent = lstatSync(dirname(this.path));
    assert(st.isFile() && !st.isSymbolicLink() && st.ino === this.stat.ino && st.dev === this.stat.dev && st.nlink === 1 && st.uid === process.getuid() && (st.mode & 0o077) === 0 && parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid() && (parent.mode & 0o077) === 0, 'JOURNAL_REPLACED');
  }
  atomic(fn) {
    this.check();
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  get(payer, id) { this.check(); return this.db.prepare('SELECT * FROM orders WHERE payer=? AND paymentId=?').get(payer, id); }
  byKey(key) { this.check(); return this.db.prepare('SELECT * FROM orders WHERE authKey=?').get(key); }
  find(v) {
    const row = this.get(v.payer, v.id) ?? this.byKey(v.authKey);
    if (row) assert(row.authKey === v.authKey && row.paymentId === v.id && row.fingerprint === v.fingerprint, 'IDEMPOTENCY_CONFLICT');
    return row;
  }
  admitVerification(v, now) {
    return this.atomic(() => {
      this.assertNewAuthority();
      this.db.prepare('DELETE FROM verification WHERE expiresAt <= ?').run(now);
      const old = this.db.prepare('SELECT * FROM verification WHERE authKey=?').get(v.authKey);
      if (old) { assert(old.fingerprint === v.fingerprint, 'IDEMPOTENCY_CONFLICT'); if (old.leaseUntil > now) return false; }
      const count = (sql, ...args) => this.db.prepare(sql).get(...args).n;
      assert(belowCountLimit(count('SELECT count(*) AS n FROM orders'), this.limits.maxRecords), 'ARCHIVE_REQUIRED');
      assert(count("SELECT count(*) AS n FROM orders WHERE status='unknown'") < this.limits.maxPending, 'PENDING_CAP');
      assert(count("SELECT count(*) AS n FROM orders WHERE status='unknown' AND payer=?", v.payer) < this.limits.perPayer, 'PAYER_PENDING_CAP');
      this.assertProviderAdmission();
      assert(old || count('SELECT count(*) AS n FROM verification') < this.limits.maxVerifications, 'VERIFY_CAP');
      assert(old || count('SELECT count(*) AS n FROM verification WHERE payer=?', v.payer) < this.limits.perPayer, 'PAYER_VERIFY_CAP');
      const window = Math.floor(now / 60);
      const usage = this.db.prepare('SELECT * FROM verify_usage WHERE singleton=1').get();
      assert(!usage || window >= usage.window, 'CLOCK_ROLLBACK');
      const attempts = usage?.window === window ? usage.attempts : 0;
      assert(attempts < this.limits.verifyPerMinute, 'VERIFY_RATE');
      this.db.prepare('INSERT INTO verify_usage VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET window=excluded.window,attempts=excluded.attempts').run(window, attempts + 1);
      this.db.prepare('INSERT INTO verification VALUES (?,?,?,?,?) ON CONFLICT(authKey) DO UPDATE SET leaseUntil=excluded.leaseUntil').run(v.authKey, v.fingerprint, v.payer, v.expiresAt, now + 30);
      return true;
    });
  }
  reserve(v, payment, now) {
    return this.atomic(() => {
      const existing = this.find(v);
      if (existing) return { row: existing, owner: false };
      this.assertNewAuthority();
      const count = (sql, ...args) => this.db.prepare(sql).get(...args).n;
      assert(belowCountLimit(count('SELECT count(*) AS n FROM orders'), this.limits.maxRecords), 'ARCHIVE_REQUIRED');
      assert(count("SELECT count(*) AS n FROM orders WHERE status='unknown'") < this.limits.maxPending, 'PENDING_CAP');
      assert(count("SELECT count(*) AS n FROM orders WHERE status='unknown' AND payer=?", v.payer) < this.limits.perPayer, 'PAYER_PENDING_CAP');
      const epoch = this.limits.budgetEpoch;
      const used = this.attempts();
      this.assertProviderAdmission();
      const reservedBytes = Buffer.byteLength(JSON.stringify(payment)) + 2 * Buffer.byteLength(JSON.stringify(v.result)) + 16384;
      const heldBytes = this.db.prepare('SELECT coalesce(sum(reservedBytes),0) AS bytes FROM orders').get().bytes;
      assert(Number.isSafeInteger(heldBytes) && heldBytes >= 0 && heldBytes + reservedBytes <= this.limits.storageBudgetBytes, 'STORAGE_BUDGET');
      this.db.prepare('INSERT INTO usage VALUES (?,1) ON CONFLICT(epoch) DO UPDATE SET attempts=attempts+1').run(epoch);
      // UNKNOWN is committed BEFORE any external settlement call. A crash here deliberately holds funds/capacity.
      this.db.prepare('INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(v.authKey, v.payer, v.id, v.fingerprint, 'unknown', v.expiresAt, now, JSON.stringify(payment), JSON.stringify(v.result), v.resultHash, null, null, reservedBytes);
      return { row: this.byKey(v.authKey), owner: true };
    });
  }
  noteHash(key, txHash) {
    return this.atomic(() => {
      const row = this.byKey(key); assert(row && row.status === 'unknown', 'STATE');
      assert(!row.txHash || row.txHash === txHash, 'HASH_CONFLICT');
      this.db.prepare('UPDATE orders SET txHash=? WHERE authKey=?').run(txHash, key);
    });
  }
  complete(key, response) {
    return this.atomic(() => {
      const row = this.byKey(key); assert(row && row.status !== 'unsettled', 'STATE');
      if (row.status === 'complete') return JSON.parse(row.response);
      assert(hashJson(JSON.parse(row.result)) === row.resultHash, 'RESULT_CORRUPT');
      assert(Buffer.byteLength(row.payment) + Buffer.byteLength(row.result) + Buffer.byteLength(JSON.stringify(response)) <= row.reservedBytes, 'STORAGE_BUDGET');
      this.db.prepare("UPDATE orders SET status='complete',response=? WHERE authKey=?").run(JSON.stringify(response), key);
      return response;
    });
  }
  provenUnsettled(key) { this.db.prepare("UPDATE orders SET status='unsettled' WHERE authKey=? AND status='unknown'").run(key); }
  attempts() { this.check(); const n = this.db.prepare('SELECT attempts FROM usage WHERE epoch=?').get(this.limits.budgetEpoch)?.attempts ?? 0; assert(Number.isSafeInteger(n) && n >= 0 && (this.limits.maxAttempts === null || n <= this.limits.maxAttempts) && n >= this.db.prepare('SELECT count(*) AS n FROM orders').get().n, 'USAGE_CORRUPT'); providerReservation(this.limits,n); return n; }
  providerStatus() { const n=this.attempts(); return providerReservation(this.limits,n); }
  assertProviderAdmission() { const n=this.attempts(); assert(belowCountLimit(n,this.limits.maxAttempts) && (providerReservation(this.limits,n)?.canReserve ?? true),'FACILITATOR_BUDGET'); }
  // Only proven-unsettled records can be purged, after signed authorizations are expired.
  // Completed paid receipts stay until an explicit accounting/archive policy is approved.
  pruneUnsettled(now) { return this.db.prepare("DELETE FROM orders WHERE status='unsettled' AND expiresAt < ?").run(now).changes; }
  clientReserve(id, fingerprint, amount) {
    return this.atomic(() => {
      const old = this.clientGet(id);
      if (old) { assert(old.fingerprint === fingerprint && old.amount === amount, 'CLIENT_CONFLICT'); return old; }
      this.assertNewAuthority();
      let held = 0n;
      for (const r of this.db.prepare('SELECT amount,state FROM clients').all()) { assert(uint(r.amount) && BigInt(r.amount) > 0n && ['signing', 'signed'].includes(r.state), 'CLIENT_JOURNAL_CORRUPT'); held += BigInt(r.amount); }
      assert(held + BigInt(amount) <= BigInt(this.limits.clientBudget), 'CLIENT_BUDGET');
      assert(belowCountLimit(this.db.prepare('SELECT count(*) AS n FROM clients').get().n, this.limits.maxRecords), 'CLIENT_RECORD_CAP');
      this.db.prepare("INSERT INTO clients VALUES (?,?,?,'signing',NULL)").run(id, fingerprint, amount);
      return null;
    });
  }
  clientGet(id) { this.check(); return this.db.prepare('SELECT * FROM clients WHERE id=?').get(id); }
  clientSave(id, payment) { this.check(); assert(this.db.prepare("UPDATE clients SET state='signed',payment=? WHERE id=? AND state='signing'").run(JSON.stringify(payment), id).changes === 1, 'CLIENT_STATE'); }
  close() { this.db.close(); }
}
