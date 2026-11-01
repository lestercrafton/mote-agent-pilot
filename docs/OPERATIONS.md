# Deployment preparation and recovery

This candidate has not been deployed. No new keys, credentials, accounts, billing agreements or off-host destinations were configured. Existing MOTE/Sepolia service and source remain unchanged.

## Proposed existing Render footprint

Use the existing one-instance native Node service and 1GB persistent disk only after approval and qualification. Build: `npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm ci --prefix legacy --omit=dev --ignore-scripts --no-audit --no-fund`. Start: `node scripts/combined-server.mjs`. Node: 24.22.2. Health check: `/ready`. No second port, database subscription or host upgrade is required by the code. Capacity on the 512MB host is unmeasured for this combined candidate; do not reuse previous capacity claims.

Keep actual existing environment/source identity. The legacy quote-key record is pinned to the old deployment commit. A reviewed source-binding transition is required for any new revision; no environment spoof or second key import is implemented here. Existing legacy files under `/var/data` are not migrated by this adapter.

USDC is disabled unless `MOTE_USDC_ENABLED=true` and `MOTE_USDC_ACTIVATION=base-sepolia-beta-v1`. It accepts only Base Sepolia and the exact existing `MOTE_PUBLIC_ORIGIN`. Mainnet configuration is rejected even though library fixtures contain mainnet metadata. A failure during combined startup closes the new listener; it does not manipulate an already running deployment.

The separately approved provisioning step must create an owner-only canonical `/var/data/mote-usdc` directory with these preexisting, single-link, owner-owned 0600 files:

- `config.json`: `{config,limits,rpcUrl,offhost}`. `config` is the complete output of `config()` using an approved public USDC recipient, separate offer/receipt signer address, price/policy epoch, exact origin and `/v1/usdc/audit` path. `limits` is the complete journal limit object with an approved attempt budget/epoch. RPC must be `https://sepolia.base.org`. `offhost` is `{enabled:false,destination:null}` or a proposed nonsecret destination string.
- `orders.sqlite`: explicitly initialized empty v2 journal bound to that config identity and exact limits. Startup never creates it. v0.8.0 databases are not silently migrated. This is server state, never a client spending journal.
- `receipt.key`: separate approved offer/receipt-only signer, never A2/Q/P2/P3 or fixture scalars. This is a hot signer; it cannot transfer USDC by this interface but compromise can forge service offers and receipts.
- `cdp.json`: exactly `{apiKeyId,apiKeySecret}`, scoped to the necessary facilitator API where supported. No CDP wallet secret is read or required. API compromise can consume provider quota/invoice exposure and submit any valid payment capabilities it obtains.

`MOTE_USDC_SETTINGS_HASH` pins `hashJson(config.json contents)`; changed settings fail closed. `MOTE_USDC_RECOVERY_ONLY=true` also blocks new authority. Startup validates public settings before reading secrets, checks provider `/supported` and the configured RPC anchor, and never calls settle. Byte buffers are cleared after loading; JavaScript-managed secret strings cannot be guaranteed erased. File checks assume the service UID and its parent mount are trusted, and do not protect against a malicious owner or host administrator. Native production provisioning/transfer and rotation still require a reviewed secure path and approval; none is supplied or executed by this candidate.

## Backup and quarantined restore

Prepare a nonsecret expected-identity JSON with `{identity: config.identity, config, limits}`. Canonical absolute source/destination paths must have owner-only 0700 parent directories. The tooling rejects links, unsafe files, wrong schema/identity, malformed orders/receipts, client journals and oversized state. No native signing or facilitator call is made.

```
node scripts/maintenance.mjs backup SOURCE.sqlite NEW_BACKUP.sqlite EXPECTED.json
node scripts/maintenance.mjs restore BACKUP.sqlite NEW_RESTORED.sqlite EXPECTED.json
```

Backup reads a consistent SQLite transaction, including committed WAL, and copies through Node's online backup API into an exclusive private staging directory. The staged database is validated and **always marked quarantined**, even for an ordinary backup. Its hash is streamed in 64KiB chunks. Database and manifest are fsynced and published without overwrite; the manifest is the completion marker. Restore requires that marker, the exact hash/config binding, a closed source without WAL/SHM/journal sidecars, and a new destination. Partial files are retained for inspection and never automatically reused or promoted.

Every published snapshot rejects normal writable-authority startup. Opening with `recoveryOnly:true` permits existing signed request/result recovery and read-only chain reconciliation, but never offers, fresh reservations or settlement submission. Quarantine persists across restart. There is deliberately no automatic unquarantine operation. A stale snapshot can be missing recent receipts/unknown submissions; those missing rows must not be recreated as fresh authority. Original caller authorizations and transaction evidence must be retained. This tool does not restore client budgets or signer keys.

The operator must preserve completed snapshot bytes. Opening a snapshot in recovery mode can change SQLite journal mode/bytes; work on a separate restored destination and retain the original snapshot/manifest. Full owner-level rollback, cloned authority, deletion of quarantine metadata and compromised host/backup storage are outside the trust boundary. Hashes detect damage, not a malicious actor rewriting both data and manifest.

Disk watermarks (free >=64MiB, WAL <=32MiB, database <=128MiB) gate new admission and are rechecked after reservation before settle. They are reported in `/ready`. Existing receipt recovery remains available where storage permits; disk failure can still prevent reconciliation writes, leaving reservations unresolved. Combined readiness can be HTTP200 in recovery-only mode, with `newAdmissionAllowed:false`; operators must inspect the JSON rather than infer sales availability from status alone.

Off-host transfer is always disabled. Recording a proposed destination does not configure credentials, encryption, uploads or scheduling. A retained-backup rotation schedule, private encrypted off-host destination, alerts, retention policy and restore drill remain live operational decisions. Repeated manual backups consume the same shared disk; no silent deletion or archival policy is assumed. Render raw disk snapshots are not substituted for SQLite-consistent application backups.

## Linux qualification handoff

An existing permitted Linux runner may execute:

```
npm ci --ignore-scripts --no-audit --no-fund
npm ci --prefix legacy --omit=dev --ignore-scripts --no-audit --no-fund
npm test
npm run demo
```

Or use `Dockerfile.qualification` with Node 24.22.2. It runs only synthetic fixtures and ephemeral loopback/process tests. No Linux/container runtime was available on this Mac; no software or paid service was installed to obtain one. Linux execution, clean install and real-host memory/disk qualification must be reported separately from the recorded Mac tests.
