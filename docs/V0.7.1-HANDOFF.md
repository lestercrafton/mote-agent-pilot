# v0.7.1-resource.1 handoff

See [RESOURCE-CORRECTION.md](RESOURCE-CORRECTION.md) for the storage format, compatibility, test evidence and actual-host acceptance status. Do not claim host capacity until the unchanged constrained full gate passes. Existing service: `srv-dbijuvou01pc73d59c30`, https://mote-testnet-pilot.onrender.com, Mote workspace, Oregon, one 512 MiB / 0.5 CPU instance and 1 GB disk at `/var/data`. Base price is $7.25/month within the authorized $20/month budget; that budget is not a provider-enforced cap. Maintenance start command stays `node scripts/testnet-setup.mjs`; no quote key or live order database is configured.

## Preserved settlement and custody boundaries

Previous source archives remain immutable. The public repository has reviewed v0.7.0-onboarding.2 commit `b55cc04faf2ca83f8dffa66f4f04f857338b2019`; the existing Render service runs that version in maintenance mode. Public testnet settlement is not live.

The local path starts with a payer having zero native gas and MOTE, executes five bounded bootstrap transactions, exposes verified dispenser discovery, then lets the payer claim→approve→pay under a durable policy. A lost result is recovered after journal reopening without signer calls. See `onboarding-verification-v0.7.json`, `onboarding-demo-v0.7.json` and the full regression log. Controlled testing is not organic adoption or a security audit.

The HTTP adapter accepts `MOTE_DISPENSER_CONFIG` and `MOTE_DISPENSER_CONFIG_HASH` together. They are public metadata, not keys. Startup checks the pinned service configuration, canonical deployments and exact dispenser immutable runtime. `/v1/dispenser` re-verifies before returning metadata. No route submits claims or grants authorization. Free audit behavior is preserved. A public pilot must distribute both complete public configuration files and independently pinned hashes to caller policies; discovery alone cannot establish spending authority.

All payer processes use the same two canonical SQLite journals and wrapped signer. Claim fees have a separate 0.001 test-ETH allocation; the payment journal has a 0.002 allocation, combined 0.003. The outer gate spans claim, approval, payment and uncertainty. Lost hashes, ambiguous quote handoff, storage failure, chain reset and identity mismatch fail closed. Recovery sends nothing. A new or copied journal is not recovery.

The operator runner accepts only five exact intents. Separate caller authorization binds plan/policy hashes, operator and expiry. It records intent before signing and signed transaction hash before broadcasting. It does not persist raw signed bytes or automatically rebroadcast. Unknown pre-sign or submission outcomes may block forever. It requires exclusive wallet control and trusted durable storage; original inclusion and finalized checkpoints are reconciled before later steps.

Native custody is documented in `scripts/keychain/README.md`. Only compilation and fake-memory/private-pipe tests ran. Real macOS ACL compatibility, dedicated item creation/read and quote-key transfer remain untested and unapproved. The target-pinned nonlogging callback interface has no configured real Render sink. Review that integration against the real service ID/origin before exposing a key. No new API credential is assumed. The Mac is proposed for bootstrap/recovery custody; routine hosted requests would not depend on it after setup.

Before public action, review the exact proposal, configuration and source hashes, operator nonce, fresh public estimates and custody target. Test the actual 512-MB Linux service and 1-GB disk using the existing resource qualification gate; Mac measurements are not production qualification. Retain SQLite-consistent backups, restored-state recovery quarantine and all fee/finality/journal guards.

