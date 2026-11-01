# Mote USDC v0.8.5 production preparation

**Local candidate; real payments disabled. Independent review and new Linux/native qualification pending.**

See [the production preparation report](docs/PRODUCTION-PREPARATION.md) for exact changes, test evidence, proposed price/caps, source-binding transition, persistent-signer procedure and one bounded approval bundle. This report supersedes the historical v0.8.1 operations/verification notes retained under docs/.

The user-confirmed recipient is in a private local overlay, excluded from this source archive. No credentials or live state are included. All 86 vendored legacy files and strict payment/proof state machines retain their recorded provenance.

Use Node24.22.2. After installing the pinned root and legacy dependencies, `npm test` runs synthetic fixtures; `npm run demo` shows one settlement and identical recovery. `Dockerfile.qualification` supplies a root-owned-procfs Linux runner; it is not evidence that the container was executed. The recorded Mac tests used available Node24.22.1. Do not weaken native custody guards in an incompatible sandbox.

Startup defaults to disabled USDC. The existing testnet signer remains source-bound: a new deployment requires the explicit transition described in the report. Merely setting a mainnet network or receiving address does not activate payments. No automatic key generation or journal initialization occurs at startup.
