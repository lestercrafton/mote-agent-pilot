# Mote R1 combined release qualification

Version 0.7.4-recovery.2, prepared October 31, 2026. This records preparation, not completed recovery or live paid settlement.

- Frozen-source full Node 24.22.2 Mac regression: 578 total, 576 passed, zero failed, two Linux-only skips, 199.145 seconds; all 193 tracked executable/config source files unchanged during the run.
- Actual existing Render Linux host: 117/117 focused tests, no skips, 13.004 seconds. All 74 materialized source files matched expected SHA-256 values. Isolated public fixtures only; no service files, keys or configuration changed. Both skipped Mac native cases ran here.
- Actual host custody checker: 50/50 passes. Proc link counts varied 721–723 while stable identity checks passed. No key access. This is an observation of current provider state, not protection from malicious root or future changes.
- Independent focused security review: two findings corrected and verified with 20/20 tests. No remaining blocking finding in that scope.
- Final local chain demo and onboarding payment demo both exit 0. These are clearly labeled local fixture transactions.
- Original full historical verifier is unchanged, SHA-256 00fb2d7a97d95e8a6bca7310309e9afdfcfe9f658568b0fcfa43b8e8713628ba. A prior strict read-only recheck verified both existing finalized public transactions through the original endpoint. Adoption will repeat the full checks.
- tmux 3.8 and caffeinate persistence fixture passed; no live P2 yet.

Next authorized sequence: one source commit and manifest, manual deployment to the same service, source/maintenance verification, one persistent memory P2, strict adoption of the two known hashes, then the six unchanged remaining intents and one approved encrypted Q import. Unknown outcomes halt. F remains disabled. Earlier operational cutoff: November 1, 2026 18:00 UTC. No faucet, mainnet, real money, new identity or hosting increase.

The archive excludes live journals, native helper binaries, keys, credentials and node_modules. Mac launch deliberately requires the preserved local sources, original records and original provisioned Keychain roles. Public hosting remains maintenance-only until separately verified activation. No organic adoption is established by these tests.
