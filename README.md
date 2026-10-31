# Mote v0.7.2-custody.2 — bounded testnet launch revision

This revision incorporates the reviewed discovery metadata correction into the v0.7.2 custody candidate. Manifest, OpenAPI and health now use the package version and conservative `testnet-prototype` wording. Existing readiness remains explicit; metadata alone never establishes public deployment, spending permission or production readiness. The fixed token contracts, eight-transaction manifest, fee caps, custody transport and payment journals are unchanged.

This source has not itself performed a public launch. The root operator has specific external approval for the existing Mote GitHub/Render destination and the bounded Ethereum Sepolia setup described in [the exact proposal](docs/SIGNER-PROPOSAL-v0.7.2.md) and [transaction manifest](docs/SIGNER-EIGHT-TRANSACTIONS.json). Source flags and this README are not credentials or proof of authorization. Actual provisioning, hosted key transfer, faucet use and transactions must satisfy all original identity, no-overwrite, fee, finality and uncertainty guards.

Use Node 24.22.2. `npm ci --ignore-scripts`, `npm test`, `npm run demo:onboarding` and `npm run demo` use only public local fixtures. Tests never activate real native custody. The companion `mote-launch-control-v0722` remains a separate operator-side module; it pins this source manifest, retains the original selected native helper, and permits only the fixed 4200-base-unit job. Do not recreate its session or payer after an uncertain outcome.

See [release notes](docs/RELEASE-v0.7.2.2.md), [current handoff](docs/HANDOFF.md), and [prior candidate details](docs/V0.7.2.1-README.md). No mainnet or real-money transaction, token valuation, peg, redemption, outside adoption or production-security claim is made.
