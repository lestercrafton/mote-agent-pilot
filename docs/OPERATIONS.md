# Deployment and recovery

## Existing Render service

Use the existing native Node service with one 512 MiB instance and its 1 GB persistent disk. Run `npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm ci --prefix legacy --omit=dev --ignore-scripts --no-audit --no-fund` to build, and `node scripts/combined-server.mjs` to start. Pin Node 24.22.2 and use `/ready` for the health check.

Keep automatic deploys off because each revision needs a source-binding transition for the existing quote key. Check the active commit, `MOTE_RELEASE_TRANSITION_HASH`, `MOTE_SOURCE_ARTIFACT_HASH`, and the public transition record at `/var/data/mote-usdc/release-transition.json`. Build and verify the release manifest before binding it to the exact commit. Preserve the last working transition and grant for rollback. The receipt signer needs its own grant for the new transition. See [continuous admission](CONTINUOUS-ADMISSION.md) for the grant fields.

Deploy with `MOTE_USDC_ENABLED=false`. Verify `/ready`, the legacy discovery document, the free `/v1/audit` route, and the disabled USDC discovery response. Run the source-bound production preflight with `MOTE_USDC_PREFLIGHT=approved-source-bound-read-only-v1` while USDC is still disabled. It checks the receipt signer, CDP support for Base, and a finalized chain anchor.

Set `MOTE_LEGACY_SEPOLIA_DISABLED=true` to keep free JSON validation and the independently configured Base mainnet service available while Ethereum Sepolia history is unavailable. In this mode the legacy quote, order, recovery, and dispenser routes return 503. Existing Sepolia records stay on the disk. Check `legacySepolia` and `usdc` separately in `/ready`. Only restore the Sepolia routes once the pinned deployment and dispenser history pass their existing verification.

## Mainnet activation

Once the operator approves the commercial terms and provider allowance, use `productionDraft` from `src/production-draft.mjs` with the confirmed payee, the installed receipt signer, the approved start time, provider allowance, and state limit. Select `payerSignatureProfile: "deployed-erc1271-v1"` for deployed smart accounts. Save the resulting settings in `/var/data/mote-usdc/production/config.json` as an owner-only file and pin the returned `settingsHash` in `MOTE_USDC_SETTINGS_HASH`. Reuse `production/receipt.key` and the existing `cdp.json` on the same disk.

If there is no existing production journal or interrupted initialization, run `npm run initialize:production` once while USDC is disabled, with `MOTE_USDC_INITIALIZE=approved-new-empty-production-journal-v1`. A surviving journal or partial state requires reconciliation. After successful initialization, set `MOTE_USDC_ACTIVATION=base-usdc-receive-beta-v1` and `MOTE_USDC_ENABLED=true` for the approved activation. Startup checks the release, journal binding, facilitator support, finalized RPC anchor, and backup health. Confirm that `/ready` reports `usdc.newAdmissionAllowed: true` and that discovery advertises Base, native USDC, the intended recipient, and the configured profile.

For the first approved payment, verify the finalized transfer and signed result. Repeat the original body and authorization to confirm identical recovery and a single settlement. If admission must pause after activation, use `MOTE_USDC_RECOVERY_ONLY=true` so existing signed requests can recover. If rolling back to a previous deploy, first confirm its source binding and compatibility with all retained financial state.

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
