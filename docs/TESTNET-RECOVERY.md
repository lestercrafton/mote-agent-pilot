# Paid testnet storage recovery and hosting preparation

This code prepares a public-synthetic-data testnet service. No Render subscription, persistent signing key, public-chain transaction or public token deployment was created by this work. The existing local prototype and free public utility remain separate.

## Backup contract

`scripts/testnet-maintenance.mjs` accepts only the exact `TestnetStore` paid-order schema and an independently supplied public deployment identity. It rejects host-only databases, payer budget journals, unrelated tables, executable schema additions, malformed stored results and inconsistent proof records. It copies no key file or live process-lock database.

Use SQLite's [online backup mechanism](https://sqlite.org/backup.html), not a filesystem copy of a live database/WAL pair. The tool establishes one read transaction, validates the schema and committed rows, then snapshots that same WAL view. Orders committed after the snapshot are intentionally absent. A source authority/recovery-mode change or source replacement aborts publication.

```sh
node scripts/testnet-maintenance.mjs backup \
  /var/data/orders.sqlite \
  /var/data/orders-backup-001.sqlite \
  expected-public-identity.json
```

The expected identity comes from the independently reviewed deployment configuration, never from the backup being checked. Its exact fields are `origin`, `chainId`, `genesisHash`, `token`, `router`, `recipient`, `quoteSigner`, `checkpoint` and `configHash`. The checkpoint binds a block number and hash; the normalizer permits a null genesis hash only alongside the required pinned checkpoint. A supplied identity is not proof that contracts were deployed.

The completed output is a closed standalone SQLite file plus `SOURCE.manifest.json`. The manifest contains SHA-256, byte length, normalized public identity and its digest, schema version, recovery flag and row counts. It is written last as the completion marker. Files use mode 0600. No prior destination, lock, manifest or SQLite recovery sidecar is overwritten. A crash may leave an incomplete new output; preserve it for inspection and choose another new destination, rather than treating it as a completed backup.

The 512 MiB source/snapshot bound is a maintenance limit, not an allocation. Before copying, the tool checks for the snapshot's page size plus 64 MiB of available headroom. This is a point-in-time capacity check, not a filesystem reservation. Concurrent writes can still exhaust disk space. Failures do not delete old backups, reset orders, resize storage or provision another disk.

SHA-256 detects accidental changes; it does not authenticate an attacker-controlled backup and manifest. A valid old snapshot with the same identity cannot prove it is the latest state. Restoration therefore always enters durable quarantine.

## Restore into recovery-only mode

Choose a new filename in a trusted, canonical parent directory, separate from the active database paths. For Render use a new sibling under `/var/data`, because the runtime permits order databases only directly under that mounted path. Then:

```sh
node scripts/testnet-maintenance.mjs restore \
  /var/data/orders-backup-001.sqlite \
  /var/data/orders-restored-001.sqlite \
  expected-public-identity.json
```

The parent directory must already exist. Source snapshot and manifest must be present, exact-hash-matching, closed and free of WAL/SHM/journal sidecars. Restore rechecks schema, identity, row commitments and integrity; it then sets `meta.recovery_required=1` inside the newly staged database before publishing anything.

The explicit `initializeRestoredTestnetLock` helper validates that quarantine flag and identity before creating a fresh `orders-restored-001.sqlite.lock.sqlite`. It cannot replace a lock or clear quarantine. The main database, new lock and completion manifest are published with create-if-absent semantics. Partial state fails closed.

The result reports `mode:"recovery-only"`, `activationAuthorized:false` and `newQuotes:false`. Normal `TestnetStore` startup rejects a restored database. The server must additionally be started with the explicit `MOTE_RECOVERY_ONLY=true` setting to permit recovery. That setting never removes the on-disk gate. The store blocks all new drafts and signed offers even when its caller requests them. Neither this tool nor the helper offers an activation or gate-clearing command.

Keep the old files and deployment identity. Select the new database path only through the reviewed runtime configuration, with the same independently pinned origin, chain, router, recipient and quote signer. Runtime readiness in recovery mode means recovery is available; it must advertise `newQuotesAllowed:false`. It does not certify that all historical obligations are known or reconciled.

## What recovery can establish

Retained `pending`, `unverified`, `finalized`, `reorg` and `rejected` labels are copied unchanged. A label or an old receipt is not fresh chain evidence. The service must verify the original signed offer, deterministic result commitment, exact payment and current canonical finalized chain evidence before returning a paid result. Unknown finality remains unknown; an absent receipt, expired offer or elapsed time never authorizes repayment.

A snapshot may predate orders or delivered results. Chain events contain commitments, not enough data to reconstruct arbitrary missing inputs, signed offers or results. Missing rows can only use the reviewed recovery path when the caller supplies the **original complete signed offer, original public synthetic input and original transaction hash**. The service must authenticate both signatures and the exact deployment/domain, reproduce the committed input/result/price, and prove the exact finalized payment before importing a recovered result. It must not create a new quote, change the amount, reapprove or ask for another payment. The maintenance tool itself makes no RPC calls and performs none of that verification.

If those original artifacts are unavailable or checks fail, retain quarantine and report the missing evidence. Do not invent an obligation, assume a payment failed or silently establish a new authority. Reviewing every retained row still does not prove that no post-snapshot rows were lost. Starting a new router would require a separate migration decision, preserved old-state recovery and an explicit account of unresolved obligations; it is not a restore switch or permission to abandon earlier payments.

This recovery design is for the service's order database only. It must never restore or reset a payer's spend journal, wallet nonce authority or budget. Full rollback protection against a malicious filesystem owner, independent duplicate databases, physical power-loss durability and public-chain consensus trust are not established by a checksum or these local tests.

## Backups and privacy

The pilot accepts only explicitly declared public synthetic input, but a declaration cannot detect accidentally submitted private material. Backups include the stored inputs, results, offers and receipts. Keep backup access restricted and never publish them as source artifacts. There are no wallet keys in this schema, and additional secret tables are rejected.

Render disk snapshots are daily and retained for seven days. Render warns against using disk-snapshot restores for custom database recovery. A SQLite-consistent backup on the same disk is still vulnerable to loss of that entire disk. Off-host backup access, destination, retention and cost remain separate setup decisions; this code creates no storage account, credentials, transfer, automatic deletion or scheduled backup. [Render disk and snapshot limits](https://render.com/docs/disks).

## Render pilot configuration

`render-pilot.yaml` prepares one Oregon `0.5c-512mb` Node 24.22.2 web instance, one 1 GB disk at `/var/data`, `/ready`, manual application deploys and no previews or autoscaling. The documented base is $7/month compute plus $0.25/month disk on a $0 Hobby workspace; taxes, bandwidth and build overages can increase it. This is not a hard spending cap. Actual hosting authorization is tracked separately from portable source; it does not authorize repository credentials or quote keys. Blueprint Auto Sync must also be disabled separately in the dashboard. [Pricing](https://render.com/pricing), [Blueprint settings](https://render.com/docs/blueprint-spec), [Blueprint sync](https://render.com/docs/infrastructure-as-code).

The service start command is `node scripts/testnet-server.mjs`. It requires the reviewed `MOTE_CHAIN_CONFIG` public JSON file, independent `MOTE_CONFIG_HASH`, canonical `MOTE_PUBLIC_ORIGIN`, explicitly initialized `MOTE_DATABASE`, and externally provisioned `MOTE_ETHEREUM_SEPOLIA_QUOTE_PRIVATE_KEY` for the selected Ethereum network. A deliberately configured retained Base deployment uses only `MOTE_BASE_SEPOLIA_QUOTE_PRIVATE_KEY`; never supply both or use a cross-network alias. The quote key is dedicated and unfunded; no key value or key-generation directive is included. Never install a deployer/admin key, seed phrase, or transaction-signing wallet in the web process. Host/terms/payment setup and persistent quote-key custody remain separately gated. Follow [PILOT-RENDER.md](PILOT-RENDER.md) for the required first-install maintenance process and same-instance Dashboard Shell initialization.

Only `/var/data` persists. The disk is runtime-only, unavailable to build/pre-deploy commands, and restricts the service to one instance with interrupted deployments. Startup must never initialize missing payment state. Preserve the main database and fresh process gate across ordinary restarts; follow the quarantine flow for actual restores. A 1 GB disk cannot hold unlimited live data and repeated snapshots; the operator must plan headroom and approved backup retention before enabling admission. [Persistent disk constraints](https://render.com/docs/disks).

No part of the Blueprint, backup tooling or readiness response proves a live public token, outside adoption, monetary value, x402 conformance or production readiness.
