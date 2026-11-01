import { DatabaseSync } from 'node:sqlite';
import { hashJson } from './core/json.mjs';
import { assert } from './protocol.mjs';
export const JOURNAL_FORMAT = 'mote-usdc-journal-v2';
export const SCHEMA_SQL = `
CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE orders(authKey TEXT PRIMARY KEY,payer TEXT NOT NULL,paymentId TEXT NOT NULL,fingerprint TEXT NOT NULL,status TEXT NOT NULL,expiresAt INTEGER NOT NULL,created INTEGER NOT NULL,payment TEXT NOT NULL,result TEXT NOT NULL,resultHash TEXT NOT NULL,txHash TEXT,response TEXT,reservedBytes INTEGER NOT NULL,UNIQUE(payer,paymentId));
CREATE TABLE usage(epoch TEXT PRIMARY KEY,attempts INTEGER NOT NULL);
CREATE TABLE clients(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,amount TEXT NOT NULL,state TEXT NOT NULL,payment TEXT);
CREATE TABLE verification(authKey TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,payer TEXT NOT NULL,expiresAt INTEGER NOT NULL,leaseUntil INTEGER NOT NULL);
CREATE TABLE verify_usage(singleton INTEGER PRIMARY KEY,window INTEGER NOT NULL,attempts INTEGER NOT NULL);
`;
const schema = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
const reference = new DatabaseSync(':memory:'); reference.exec(SCHEMA_SQL);
export const SCHEMA_HASH = hashJson(schema(reference)); reference.close();
export function verifySchema(db) { assert(hashJson(schema(db)) === SCHEMA_HASH, 'JOURNAL_SCHEMA'); }
