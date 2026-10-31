# Exact testnet bootstrap proposal — not executed

This supersedes the earlier six-transaction proposal and v0.6's smaller gas figures. It prepares a no-value Ethereum Sepolia pilot, chain **11155111**. No proposed identity exists yet. No address, Render service ID, approval, faucet result or deployment proof is invented here.

## Roles and custody

1. **A — bootstrap operator, initial holder and merchant.** After specific approval, create a fresh dedicated testnet key in the existing unlocked macOS login Keychain: service `org.mote.ethereum-sepolia.bootstrap.v1`, account `ethereum-sepolia:bootstrap:v1`, restricted to the reviewed pinned native helper. It stays off Render, receives only faucet test ETH, deploys/funds contracts and receives no-value service tokens.
2. **Q — quote and receipt signer.** Create a separate fresh unfunded key after approval. Its backup uses the same existing login Keychain: service `org.mote.ethereum-sepolia.quote.v1`, account `ethereum-sepolia:quote-backup:v1`. The only proposed hosted copy is the exact Render service's `MOTE_ETHEREUM_SEPOLIA_QUOTE_PRIVATE_KEY` secret environment value. Pin the service ID, canonical origin, service configuration hash, Q address and handoff descriptor hash. Q receives no gas or operator authority. The actual nonlogging sink must be reviewed and authorized; none is configured.
3. **P — controlled rehearsal payer.** Use a separately authorized dedicated in-memory test-only signer, distinct from A/Q, for one claim and paid job. It receives at most 0.007 test ETH from A and begins with zero MOTE. No persistent key or off-device backup is proposed for P. Public offers/proofs and durable journals survive; later recovery needs no signing key. Loss before completion may strand unused test assets or retain reservations. Independent agents bring their own valid wallet authority and gas.

These are software/custody restrictions, not cryptographic chain isolation. Never reuse a funded mainnet key. The helper uses exportable Keychain custody, not Secure Enclave signing; private material enters authorized memory. Actual no-UI ACL behavior needs a separately authorized compatibility check, without automatic fallback or broader access.

## Fixed eight-transaction envelope

All transactions use type 2, chain 11155111, empty access lists, **maxFeePerGas 2 gwei**, **maxPriorityFeePerGas 1 gwei**. A's five nonces are consecutive and pinned. Source-derived bytecode, roles, predicted addresses and calldata come from `createBootstrapPlan`. No fee bump, replacement, new wallet, additional allocation or automatic retry is authorized by the plan.

| Step | Signer | Exact action | Gas limit | Maximum fee, test ETH |
|---|---|---|---:|---:|
| 1 | A | Deploy MoteToken; all 1,000,000 test MOTE to A | 5,000,000 | 0.0100 |
| 2 | A | Deploy router bound to token, merchant A and Q | 7,000,000 | 0.0140 |
| 3 | A | Deploy dispenser: 10 MOTE/claim, 10,000 total | 5,000,000 | 0.0100 |
| 4 | A | Transfer exactly 10,000 existing MOTE to dispenser | 250,000 | 0.0005 |
| 5 | A | Transfer at most 0.007 test ETH to P, empty calldata | 250,000 | 0.0005 |
| 6 | P | One zero-value dispenser `claim()` | 500,000 | 0.0010 |
| 7 | P | Approve only the exact signed service price | 250,000 | 0.0005 |
| 8 | P | Pay that original quote and retrieve/recover result | 500,000 | 0.0010 |

Maximum fees sum to **0.0375 test ETH**. Separately counting the payer allocation gives the conservative **0.0445 test-ETH envelope**, below the proposed **0.05 ceiling**. This counts allocated native funds and their later gas use; it is not an expected net loss. P's journals reserve 0.003 test ETH, above its three signed ceilings totaling 0.0025. Remaining funds are not swept, swapped or automatically reused.

The token has no further mint path. A's remaining 990,000 test MOTE has no additional distribution authorization. The dispenser has no withdrawal/admin key; excess funding is locked. Its 1,000 claims are per address, not per agent or person. One actor can exhaust it through multiple funded wallets.

## Network and faucet checks

Sepolia's newer rules increase creation costs. The [Ethereum Foundation schedule](https://blog.ethereum.org/2026/09/17/glamsterdam-testnet-announcement), [pinned Geth configuration](https://github.com/ethereum/go-ethereum/blob/v1.17.7/params/config.go), [state creation accounting](https://eips.ethereum.org/EIPS/eip-8037) and [native transfer event specification](https://eips.ethereum.org/EIPS/eip-7708) inform this profile. Limits do not guarantee success. The runner requires successful fresh `eth_estimateGas` for each exact operator transaction, consistent canonical identity, sufficient balance and unchanged caps before signing and again before submission. Missing/oversized estimates or a base fee above 2 gwei stop it. The local test uses Shanghai and immediate simulated finality; it does not validate current public execution/finality.

The intended public RPC is the pinned Ethereum Sepolia endpoint in `src/testnet-networks.mjs`, with no arbitrary-chain or endpoint fallback. Finalized receipts, signatures, inclusion history, source/runtime/getters and original checkpoints must verify before later steps. RPC evidence remains a trusted-source assumption, not independent consensus validation.

Proposed gas source: [OpenFaucet Ethereum Sepolia](https://openfaucet.org/ethereum-sepolia), listed in [Ethereum's network documentation](https://ethereum.org/developers/docs/networks/#sepolia). Its [description](https://openfaucet.org/about) advertises browser proof of work without an account. Proposed use is one browser session, at most ten minutes, requesting at most 0.05 test ETH for A. Availability, current terms, proof cost and eventual delivery remain unverified. No claim or computation ran. Do not use Render compute, buy test ETH, supply a mainnet balance, create an account/API key or bypass an unexpected challenge. Independent agent gas access is external; Mote does not promise free native gas.

## Execution gates

Render creation remains denied/pending exact renewed authorization. Once the real destination exists, review the exact source, resource qualification, service ID/origin and custody sink. Specific approval must cover A/Q provisioning, P's controlled test signer, their storage/use, bounded faucet computation and the eight public testnet actions. Source flags are not consent.

Native compilation and fake-memory tests are complete; real ACL compatibility is deliberately untested. A failed or timed-out create/handoff may have an uncertain outcome: inspect the exact approved target before retry. Never create replacement authority or broaden ACLs to restore availability. Journals store exact unsigned intents and signed transaction hashes, not private keys or raw signed bytes. Restart reconciles; it never resubmits. Unknown signing/submission may block indefinitely.

Publish active discovery only after verified public evidence and an explicit reviewed release. This proposal creates no real-money fee, sale, liquidity, tip, purchase, access grant, extra subscription or adoption claim.
