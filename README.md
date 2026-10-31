# Mote v0.7.0-onboarding.2 — packaging correction candidate

This unpublished packaging-only revision corrects Ganache's imported optional Darwin dependency metadata for clean Linux npm installs. Application, contract, policy and test sources remain byte-identical to v0.7.0-onboarding.1; the service still advertises that application version. The earlier source archive remains immutable. Fresh macOS installs passed 402 application tests, 29 production-only tests and both local demos. Actual Linux execution remains pending. See [Linux qualification](docs/LINUX-QUALIFICATION.md) and [packaging evidence](docs/portable-verification-v0.7.2.json) for installation checks and unperformed Linux/container gates. The earlier 402-test record below describes v0.7.0-onboarding.1; new clean-install evidence is separate.

## Preserved application v0.7.0-onboarding.1

An agent can discover a verified test-token dispenser, claim test MOTE, obtain an exact quote, pay for JSON preflight, and recover a lost result under a preauthorized durable spending policy. This candidate demonstrates the complete flow on one **local EVM**. It has not been deployed to a public chain. The existing public free utility and reviewed v0.5 source remain unchanged.

The service checks bounded JSON and a documented JSON Schema subset, returns exact-path errors, canonical bytes and a SHA-256 digest. Neither new-token necessity nor outside demand has been established. No token price, redemption, peg, return, public adoption or real-value settlement is claimed.

## Run the local rehearsal

Use Node **24.22.2**. Development dependencies provide the compiler and local EVM:

```sh
npm ci --ignore-scripts
npm test
npm run demo:onboarding
npm run demo
```

`demo:onboarding` uses an already-public test vector on literal loopback. It creates the token, router and dispenser, allocates the exact reserve and bounded fixture gas, then starts the verified HTTP service. A payer starting with zero tokens automatically claims, approves and pays. After a deliberately lost result, reopened journals recover the identical receipt without another transaction. The operator journal also reopens and reconciles without a signer. These eight transactions settle on the local EVM; they are not public Sepolia transactions.

To retain a new nonsecret record, run `node scripts/demo-onboarding.mjs --evidence NEW_FILE.json`. See [verification](docs/onboarding-verification-v0.7.json) and [demo evidence](docs/onboarding-demo-v0.7.json). Prior-version logs are historical evidence only.

## Components

- **Dispenser:** at most 10,000 existing test MOTE, at most 10 per address once. No owner, mint, payout key, reset or withdrawal. Callers need test ETH. Multiple identities can exhaust it; this is not Sybil protection.
- **Discovery:** read-only deployment/funding/claim verification binds signed transactions, complete dispenser runtime and immutables, original token/router configuration and finalized canonical evidence. Optional `/v1/dispenser`, manifest and OpenAPI metadata expose the exact zero-value claim call. Discovery grants no spending permission.
- **Claim and payment:** `ClaimThenPayClient` wraps the existing payment client with a durable outer wallet gate, separate claim fees and combined accounting. Every writer must share the same trusted claim/payment journals. Restart never resets limits or resumes uncertain sends.
- **Bootstrap:** five exact operator transactions bind source, roles, nonces, fees and policy. Fresh execution estimates are mandatory before signing and submission. Unknown transactions are never replaced or resent automatically.
- **Inactive macOS custody:** a compiled native helper, memory-only tests and opaque Node interface support two dedicated testnet Keychain roles. Private pipes carry secret bytes without arguments or logs. Actual Keychain access and the trusted Render secret sink have not been activated or verified.

See [claim client](docs/CLAIM-CLIENT.md), [bootstrap proposal](docs/BOOTSTRAP-PROPOSAL-v0.7.md), [native helper](scripts/keychain/README.md), [contract design](docs/TESTNET-DISPENSER.md) and [handoff](docs/HANDOFF.md). Earlier payment/service documentation is preserved in [v0.5](docs/V0.5-README.md); the contract-only candidate is preserved in [v0.6](docs/V0.6-README.md).

## Boundaries

Ethereum Sepolia 11155111 is the intended no-value pilot. Base still refuses payment when a complete enforceable fee ceiling is unavailable. Mainnet, arbitrary chains, swaps, bridges, sponsorship and automatic top-ups are unsupported. Inputs must be explicitly public synthetic data. This is not x402-conformant; the separate portable MCP bridge accesses the free utility and grants no wallet permission.

The proposed eight-transaction envelope is **0.0445 test ETH**, conservatively including the 0.007 payer allocation, below a separately proposed 0.05 ceiling. Limits do not guarantee success. Local Shanghai execution does not qualify the current public Sepolia fork. Fresh public estimation and finalized verification remain necessary. Failed transaction fees are accounted too.

Unresolved submissions may retain reservations and block indefinitely. Full journal rollback, copied authority, raw-signer use elsewhere, compromised hosts, malicious custody adapters and independently proving RPC consensus are outside this prototype. Known receipt recovery works automatically; completing every interrupted workflow is not guaranteed.

No persistent real keys, native Keychain items, public faucet claims, public signatures/broadcasts or new hosting resources were created for this candidate. Render creation remains pending renewed exact authorization after automatic approval-review rejection. Signer provisioning needs an exact approved destination and reviewed nonlogging handoff. Source flags are not authorization.
