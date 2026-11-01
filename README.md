# Mote v0.7.4-recovery.2 — inactive R1 A–B candidate

This separate candidate contains the bounded Ethereum Sepolia historical-state retry and the reviewed Render custody compatibility corrections. It includes the separately approved recovery controller, receipt adoption, fixed expiry and restricted operator/payer interfaces. It has not been published, deployed, or used to import a key or submit a public transaction.

Read [the R1 A implementation and remaining gates](docs/RECOVERY-R1-A.md) and [the R1 B recovery controller](docs/RECOVERY-R1-B.md). Source files do not grant signing authority. Optional fallback F is disabled; the original complete historical verifier, contracts, fixed supply, fee caps and original runtime journals are unchanged. Old release documents and `PARENT-SOURCE-MANIFEST.json` are historical provenance, not this candidate's release status.

Use Node 24.22.2. `npm ci --ignore-scripts`, `npm test`, `npm run demo`, and `npm run demo:onboarding` run public local fixtures. On Linux, the new directory tests exercise real descriptor-anchored operations; on macOS two Linux-only cases are explicitly skipped. The production import is Linux-only and never uses the Mac fixture fallback.

Required before release: successful Linux native qualification, the exact actual-host read-only probe, the combined source binding and verified deployment identity. No claim of production security, token value, organic adoption, mainnet availability or completed public payment is made.
