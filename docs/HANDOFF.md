# v0.5.0-sepolia.1 handoff

The selected pilot is Ethereum Sepolia, chain 11155111. This change resolves the previous full-fee-cap blocker by using ordinary Ethereum type-2 transactions, whose signed gasLimit and maxFeePerGas cap the total native transaction fee. It preserves all Base refusal, local prototype, identity, journal and recovery guards. No public contract, wallet key or financial transaction has been created by the candidate.

## What changed

- Shared chain, unsigned planner, service, storage, runtime, admin, signer and discovery modules select only the two explicitly registered testnets. Ethereum additionally requires its known canonical genesis. Mainnet, arbitrary chains/endpoints and cross-network state reuse fail closed.
- The Ethereum fee module validates exact transaction fields, reconstructs ECDSA signed transaction hash/sender, verifies historical inclusion/current finality and accounts full gasUsed × effectiveGasPrice including reverts and current execution/state metering. Base's separate component accounting remains unchanged and automatic submission stays blocked.
- The ordinary client uses the Ethereum fee boundary with no override: durable reservation, exact approval intent, finalized approval, fresh identity/expiry/nonce check, exact payment intent, finalized payment and signed result recovery. Original-process polling is bounded; crash/unknown/restart never resubmits. Quotes default to 3600 seconds/max 7200 to accommodate finality; Base defaults remain 120/max 900.
- Runtime accepts an externally provisioned dedicated Ethereum quote/receipt key only for the matching network mode. It never generates a key, broadcasts a transaction or initializes missing order state. Public payer keys stay outside the service.

## Verification

The complete Node 24.22.2 regression log is `sepolia-full-tests-v0.5.txt`. The actual local wallet-path rehearsal is `sepolia-demo-v0.5-evidence.json`: same standard class/fee checks, two authorized signer calls (approval and payment), exact persisted intents before each, one recipient payment, actual native fees accounted, dropped response recovered after journal reopen, repeated identical recovery and pre-signer rejection outside policy. It has no public transaction and runs a Shanghai simulator; current public fork gas behavior is supported by official-source analysis and focused mock tests rather than a public broadcast.

Independent scoped review found and fixed two important operational gaps: ending finality must be re-read before accepting a fee proof, and Ethereum needs bounded original-owner finality waiting plus a longer quote. Tests cover those regressions, actual EVM cross-process budgets, missing hashes, timeouts, expiry after approval, corrupted state, replay and backup reconstruction. This is not a production security audit.

`ethereum-sepolia-observation.json` is an actual bounded read-only public RPC observation. Genesis and finalized/safe/latest tags were checked against the fixed provider; no funds, deployed Mote contract or service readiness were claimed. One RPC remains a trust dependency.

## Deployment and exact remaining setup

Use `ETHEREUM-PILOT.md` and `PILOT-RENDER.md`. The proposed footprint remains one Node 24 service with 512 MB and a 1 GB disk. The existing public free Site needs no paid replacement. `render-pilot.yaml` selects the Ethereum runtime; first-install setup is maintenance-only until separately authorized signer/config/state preparation is complete.

`PUBLIC-SOURCE-ROUTE.md` describes a dedicated public repository or digest-pinned image without granting Render private-repository access. Existing CLI GitHub authentication was invalid; no token refresh, new OAuth or denied Sites transfer was attempted. Public source publication, if completed, must record its exact repository/commit in the delivery report; this file by itself is not proof of publication.

`RESOURCE-VERIFICATION.md` and `scripts/resource-check.mjs` exercise a full 1,000-row/4,000-attempt store, startup, separate-process online backup and quarantined restore. Local functional runs do not qualify Linux resource bounds. The mandatory constrained check requires Node 24.22.2, linux/x64, observed 512 MiB memory, no swap, 0.5 CPU, production-only dependencies and explicit memory/disk/latency thresholds. No Docker engine was available locally. A failed actual-host check must stop activation; it does not authorize a larger paid plan or weaker limits.

Pending public setup consists of the approved source/service destination, separately approved dedicated quote and deployment signer provisioning, test ETH/MOTE allocation, exact no-value deployment transactions, verified chain evidence and explicit new order-state initialization. Callers must supply already authorized funded test wallets and their own pinned policies. No contract address or creator wallet is invented, and no autonomous top-up/faucet service is claimed.

## Boundaries

One shared trusted SQLite authority and nonce gate are required. Full rollback, duplicated independent journals, compromised wallet custody or an adapter that ignores the exact transaction request are unsupported. Unknown sends may retain reservations indefinitely. Restore remains recovery-only. Input/results are explicitly public synthetic data; no private-data authentication is provided.

The pilot admits at most 1,000 cumulative quotes, 20 per payer and 4,000 proof attempts; this is not a million-transaction launch. The earlier million estimate concerned response-body bandwidth alone. No real-value fees, x402/facilitator support, smart-account wallet support, token sale, exchange, bridge, top-up, tip, outside promotion or organic adoption is claimed. See `ECONOMICS.md` for transparent future cost recovery and separate fee/accounting categories.

The portable free MCP adapter is unchanged: official-client-tested local stdio to the existing anonymous HTTP utility, no payment tools, account credentials or hosted-MCP authentication bypass. Historical test/evaluation files are retained with their original version labels; current evidence uses v0.5 names. Previous release archives remain immutable.
