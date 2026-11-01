# v0.8.1 integration.1 verification

Recorded November 1, 2026. Local candidate only; no publication/deployment or live CDP payment.

- Full candidate suite: **110 passed, 0 failed, 0 skipped**, macOS arm64, Node24.22.2. Exact TAP: `test-results.tap`. Includes existing payment/replay/concurrency/lost-response/process-kill checks and new attribution/combined/startup/maintenance checks.
- Demo: complete deterministic result, **one synthetic settle call**, byte-identical recovered response. `demo-result.json` explicitly identifies synthetic settlement. No public chain was used.
- Independent focused review: **40 passing tests** across 34 attribution/maintenance tests, 3 combined loopback tests and 3 startup tests. Initial reviewer loopback EPERM was a sandbox restriction; the approved loopback-only rerun passed. No remaining blocking finding within that review scope. This is not an external security audit.
- Findings corrected: all published snapshots are quarantined; combined server actually enforces32 connections and advertises/tests12,000-byte payment headers under the retained16KiB total limit; startup rejects non-limit options and explicitly forbids creation of a missing journal.
- All86 legacy files match `LEGACY-PROVENANCE.json`. The reviewed legacy bootstrap verifier, custody checks, utility and testnet protocol were not edited. Existing legacy broad suite was not rerun unnecessarily.
- Test coverage includes malformed/noncanonical/duplicate/oversized attribution; exact signed transfer with official attribution encoding; unchanged free utility/testnet request semantics; path-bound USDC offer/authorization; combined header boundary; disabled startup without credential reads; mainnet/route/origin/RPC/offhost/settings mismatch; owner/mode/link/size restrictions; committed-WAL snapshot; concurrent writer; wrong identity/schema/receipt; stale snapshot; direct-backup-open rejection; repeated recovery-only restart; no-overwrite; actual SIGKILL after copy and between database/manifest publication; sidecar/manifest mismatch; storage pressure before settlement retaining intent; disabled off-host transfer.

Review final startup source SHA256: `21b600ae59cc92c85aa75e33745ba9277da49b2a23d044acb527ad391b985866`.

## Unverified boundaries

Linux/clean installation and actual512MB host capacity remain pending. No local container runtime was available; a read-only connected Vercel project search for Mote returned no projects. No sandbox, project, account, software installation or paid resource was created. `Dockerfile.qualification` and exact native commands are supplied for an existing permitted Linux runner.

CDP's real transaction/suffix shape, finalized proof compatibility, account-specific scopes/billing/terms, and interrupted real-provider delivery remain untested. Existing Render configuration was inspected read-only earlier in this task: native Node build, existing1GB persistent `/var/data`, one512MB service, `/ready` health path. This candidate has not replaced it. Its existing source-bound Q record requires an approved migration/rebind before a changed commit can start; no bypass was added.

No secrets, credentials, wallet identities, accounts, billing agreement, source rebind, off-host destination, public transactions or new subscriptions were created. Existing payer controllers were not inspected or altered; the prior denied process read was not retried.
