import { DatabaseSync } from 'node:sqlite';
import { MoteError } from './json.mjs';

export function openStore(filename, identity) {
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS quotes (
      id TEXT PRIMARY KEY, idem TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL,
      offer TEXT NOT NULL, result TEXT NOT NULL, response TEXT, tx TEXT UNIQUE
    );
    CREATE TABLE IF NOT EXISTS attempts (idem TEXT PRIMARY KEY, quote TEXT NOT NULL, tx TEXT NOT NULL);
  `);
  const previous = db.prepare('SELECT value FROM meta WHERE key=?').get('chain');
  if (previous && previous.value !== identity) {
    db.close();
    throw new MoteError('CHAIN_IDENTITY_CHANGED', 'This database belongs to another chain instance. Preserve it for inspection; use a fresh database for a reset local chain.', 409);
  }
  db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('chain', identity);
  const decode = (row) => row && ({ ...row, offer: JSON.parse(row.offer), result: JSON.parse(row.result), response: row.response && JSON.parse(row.response) });
  return {
    byId: (id) => decode(db.prepare('SELECT * FROM quotes WHERE id=?').get(id)),
    byKey: (key) => decode(db.prepare('SELECT * FROM quotes WHERE idem=?').get(key)),
    count: () => db.prepare('SELECT count(*) AS n FROM quotes').get().n,
    saveQuote(id, key, fingerprint, offer, result) {
      db.prepare('INSERT OR IGNORE INTO quotes (id,idem,fingerprint,offer,result) SELECT ?,?,?,?,? WHERE (SELECT count(*) FROM quotes) < 5000').run(id, key, fingerprint, JSON.stringify(offer), JSON.stringify(result));
      const row = this.byKey(key);
      if (!row) throw new MoteError('CAPACITY', 'Local demo quote capacity reached.', 503);
      if (row.fingerprint !== fingerprint) throw new MoteError('IDEMPOTENCY_CONFLICT', 'Idempotency key belongs to another request or payer.', 409);
      return row.offer;
    },
    bindAttempt(key, quote, tx) {
      db.prepare('INSERT OR IGNORE INTO attempts SELECT ?,?,? WHERE (SELECT count(*) FROM attempts) < 20000').run(key, quote, tx);
      const previous = db.prepare('SELECT * FROM attempts WHERE idem=?').get(key);
      if (!previous) throw new MoteError('CAPACITY', 'Local demo reconciliation-key capacity reached; existing keys and GET recovery remain available.', 503);
      if (previous.quote !== quote || previous.tx !== tx) throw new MoteError('IDEMPOTENCY_CONFLICT', 'Idempotency key belongs to a different payment proof.', 409);
    },
    saveResponse(id, tx, response) {
      try {
        db.prepare('UPDATE quotes SET tx=?, response=? WHERE id=? AND response IS NULL').run(tx, JSON.stringify(response), id);
      } catch (error) {
        if (error.code?.startsWith('ERR_SQLITE')) throw new MoteError('PAYMENT_REUSED', 'Transaction is already assigned to another order.', 409);
        throw error;
      }
      return this.byId(id).response;
    },
    close() { db.close(); },
  };
}
