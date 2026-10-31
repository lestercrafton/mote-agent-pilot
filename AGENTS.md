# Current packaging-only candidate

This is v0.7.0-onboarding.2, isolated from immutable v0.7.0-onboarding.1. Fix reproducible Linux npm installation/platform metadata and prepare a clean container qualification without changing application/contracts/policy behavior. No --force dependency bypass, public publishing/deployment, new credentials/keys, native Keychain calls, faucet claims, paid resources or public transactions. Prior denied Render and Sites actions remain stopped. Preserve previous artifacts.

# Current v0.7 preparation scope

Finish native nonlogging macOS Keychain provisioning/handoff helper, strict bounded testnet bootstrap runner, dispenser public verification/discovery, and automatic policy-controlled claiming before paid work. Public fixtures and mock custody only: NO actual Keychain item creation/read, new real keys, persistent credentials, faucet claims, public signing/broadcasting, hosting mutations or external source publishing. Native helper may compile and run self-tests against fake backends; do not call the real Keychain backend. Keep v0.5 and v0.6 immutable. Render deployment was denied before execution and remains pending exact renewed authorization; do not retry or route around it. Preserve all existing chain/budget/journal/finality/recovery guards; uncertainty must fail closed without automatic repeated payment, replacement or policy expansion. Public transaction test fixtures must use loopback local EVM. Forward these restrictions if delegating.

# Current isolated dispenser candidate

This copy is v0.6.0-faucet.1 and is not published or deployed. Implement a separate pre-funded, keyless, no-value test MOTE dispenser with immutable total distribution and per-address claim limits. Do not change MoteToken supply, current router semantics, v0.5 artifacts or the public source/deployment. Use local fixtures only. No keys, public transactions, faucet claims, credentials, external publishing, hosting mutations or paid resources. The denied Render deployment remains blocked pending parent-supplied new authorization; do not retry or bypass it. Run meaningful replay/exhaustion/reentrancy/unsupported-token tests and a full regression before calling this candidate verified.

# Current candidate scope

Prepare and test Ethereum Sepolia support with an enforceable type-2 transaction gas ceiling, preserving the Base refusal and all existing journal/identity/recovery guards. Reuse shared testnet modules; allow only explicitly pinned networks 84532 and 11155111, never arbitrary chains. No public signing, broadcasting, wallet keys, credentials or access grants. Hosting approval is separate and parent owns setup. Do not touch prior immutable releases or retry the previously denied Sites credential transfer.

# Unlaunched Base Sepolia pilot candidate

Current authorized scope includes implementing and testing a separate public-synthetic Base Sepolia service, finalized settlement verification, durable orders/recovery, public payer policy/journal support, complete fees or fail-closed refusal, and a Render deployment bundle. Use local fixtures/mocks only for transaction tests. No hosting/signup/billing, persistent signing credentials, external testnet broadcasts or real-money transactions until separately authorized. Preserve original local client/journal guards. Never weaken a fee cap or disguise missing public evidence to make a demo pass.

# Mote local prototype

The running token/payment prototype remains local-only. The latest user request authorizes preparation for a no-value public testnet pilot, read-only public-network inspection, unsigned deployment/verification artifacts, local rehearsals, and reviewed free utility/source publication through the existing Site. This does not authorize real-money transactions, paid resources, persistent signing keys, API credentials, or new security access. Do not broadcast public-chain transactions until the exact signer, target, fee policy and authorization are resolved. Never create liquidity, sell tokens, configure tips, or use public fixture accounts on a public chain. Local fixture transaction accounts are public and worthless; quote signing is ephemeral and unfunded. Do not persist private keys. Do not claim x402, public indexing, external adoption, security audit, public settlement, or production readiness without evidence.

Keep existing local client/service/journal chain and origin guards. Base requires separate fee and finality handling; changing chainId alone is unsafe. New testnet modules must not import local fixture accounts into public execution. Public free MCP interoperability may use the anonymous HTTP API but must preserve Sites' existing MCP authentication. Any unresolved deployment, key-custody or hosting requirement must be reported precisely rather than hidden behind a simulated ledger.

Use integer base units for prices; bind payer, request, chain, router, token and recipient. Preserve replay, idempotency, recovery and spending-control tests. Run `npm test` and `npm run demo` before claiming it works. Update README and docs/HANDOFF.md when scope changes. Keep unrelated projects untouched.
