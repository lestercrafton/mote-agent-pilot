> Historical v0.6 contract-design notes. The contract behavior remains current, but the old bootstrap/claim fee envelope below is superseded by [v0.7 proposal](BOOTSTRAP-PROPOSAL-v0.7.md) and [claim client](CLAIM-CLIENT.md). Public verification, discovery and automatic claiming are implemented in the v0.7 candidate; no public deployment has occurred.

# Test MOTE dispenser candidate

This document belongs only to the isolated, unpublished `0.6.0-faucet.1` candidate. The v0.5 release remains frozen and unlaunched. No public dispenser address, deployment, funding transfer, claim, key, credential, or hosting change is established here. The denied Render deployment remains blocked; this candidate does not authorize a retry or a route around it.

The dispenser removes operator authorization from each test-token allocation. It does not provide wallet custody, native gas, service availability, or the service's separate quote/receipt signer. Test MOTE has no promised monetary value, redemption, peg, or investment return.

## Immutable allocation

[`MoteTestDispenser`](../contracts/MoteTestDispenser.sol) accepts an existing token address. It does not deploy or mint a token. MoteToken's existing fixed supply remains 1,000,000 MOTE with six decimals; the proposed allocation is 1% of that existing supply.

| Parameter | Proposed default | Integer base units |
| --- | ---: | ---: |
| Lifetime distribution cap | 10,000 test MOTE | `10000000000` |
| Successful claim amount | 10 test MOTE | `10000000` |
| Maximum successful claimant addresses | 1,000 | cap divided by claim amount |

Limits apply **per dispenser instance**, not globally across independent deployments. The constructor allows smaller positive values, but never more than 10 MOTE per claim or 10,000 MOTE total. The cap must be at least one claim and exactly divisible by the claim amount. The chosen token, claim amount, and cap are immutable.

The public interface is:

```solidity
constructor(address token_, uint256 claimAmount_, uint256 distributionCap_)
function claim() external
function token() external view returns (address)
function claimAmount() external view returns (uint256)
function distributionCap() external view returns (uint256)
function distributed() external view returns (uint256)
function claimed(address claimant) external view returns (bool)
event Claimed(address indexed claimant, uint256 amount, uint256 totalDistributed)
```

`claim()` has no recipient argument: it transfers exactly `claimAmount` to `msg.sender`. Native transaction value is zero; the caller pays native gas. There is no administrator, claim-signing key, mint, allowance, reset, pause, upgrade, or withdrawal method. Contracts can claim too; there is no EOA or agent-identity test.

`distributed` counts successful lifetime distributions, not deposits. A successful address cannot claim again. Underfunding, exhaustion, a failed token transfer, or failed balance checks revert eligibility and accounting changes together. A mined reverted claim can still consume native gas.

SafeERC20, ReentrancyGuard, state changes before the external transfer, and exact before/after balance checks protect the intended flow. The dispenser must lose exactly the claim amount and the claimant must gain exactly that amount. These checks reject observable non-exact transfers; they do not authenticate arbitrary token code. The constructor requires code at the token address, not proof that it is MoteToken. Only the separately verified, unchanged fixed-supply MoteToken is intended. Taxed, rebasing, mutable/proxy, or dishonest-balance tokens are unsupported.

## Finite funding and stranded excess

The proposed bootstrap transfers exactly `10000000000` units of the verified MoteToken into the dispenser. No ERC-20 approval is needed. Claims use only the contract's existing balance.

Later deposits cannot reset eligibility or increase the lifetime cap. Anyone can send tokens to an address, but this contract has **no recovery or sweep path**. Excess funding, deposits after exhaustion, or accidental transfers of other assets can remain stranded permanently. After the default instance distributes 10,000 MOTE, a new deposit cannot reactivate it. There is no automatic refill or authority to deploy a replacement.

Deployment and funding are separate transactions. Do not advertise an instance as funded until its code, immutable parameters, canonical funding evidence, and balance have been verified. Read eligibility, remaining cap, and balance before claiming; these observations do not reserve capacity against competing transactions.

## Exact bootstrap additions and unsigned preparation

Let A be the separately approved deployer/initial-holder/merchant EOA, T the verified MoteToken, R the existing router, Q its independent quote signer, and D the new dispenser. The dispenser adds no persistent key and changes none of T, R, Q, token supply, or router semantics.

Add exactly two transactions to an explicitly approved bootstrap:

1. **Create D:** A sends the independently compiled dispenser creation bytecode plus ABI-encoded constructor arguments `(T, 10000000, 10000000000)`, with `to: null`, native value zero, chain 11155111, an explicit nonce, and bounded fees. Pin the reviewed source/artifact and predicted address.
2. **Prefund D:** after verifying D's canonical creation and immutables, A calls T with exact `transfer(D, 10000000000)` calldata, native value zero, the next explicit nonce, and a separate fee ceiling. Verify the finalized transfer and actual dispenser balance.

For a fresh A whose token/router creations use nonces 0 and 1 with no intervening outgoing transaction, these additions would use nonces 2 and 3. Stop on a nonce or evidence mismatch; do not replace a pending transaction or guess another nonce.

Fill a separate public configuration from [`config/dispenser.template.json`](../config/dispenser.template.json), then prepare a new output file:

```sh
node scripts/prepare-dispenser.mjs \
  --config COMPLETED_PUBLIC_DISPENSER_CONFIG.json \
  --out NEW_DISPENSER_PLAN.json
```

Required fields are `chainId: 11155111`, `token`, `tokenRuntimeHash`, `deployer`, decimal-string `nonce`, `claimAmount`, and `distributionCap`. Null template values are deliberately unusable. The CLI refuses an existing output file.

The output contains exact unsigned creation and cap-funding transactions, predicted D, constructor values, artifact hashes, and a plan fingerprint. It has **no fee fields, authorization, token evidence verification, or public deployment proof**. The supplied token runtime hash is an expectation, not a chain observation. [`compile-dispenser.mjs`](../scripts/compile-dispenser.mjs) separately provides ABI, bytecode, immutable references, and complete compiler input without changing token/router artifacts.

The existing two-contract deployment verifier does not verify D. Independently check the token against the intended MoteToken, D's deployed code and immutable substitutions, creation receipt, cap funding, and canonical finality before publishing an active address. Unsigned preparation is not public evidence or permission to sign.

## Proposed bootstrap gas envelope

The following is a **proposal, not an approved batch, live estimate, or guarantee of execution success**. It combines the earlier two creations with the dispenser and one controlled payer P:

| Transaction | Proposed gas ceiling |
| --- | ---: |
| Deploy token | 2,000,000 |
| Deploy router | 3,000,000 |
| Deploy dispenser | 2,000,000 |
| Fund dispenser with the exact token cap | 100,000 |
| Transfer bounded native test ETH to P | 100,000 |
| P calls D.claim() | 250,000 |
| P makes the existing exact token approval | 250,000 |
| P makes the existing exact router payment | 500,000 |

At a proposed `maxFeePerGas` ceiling of 5 gwei, the sum of these gas ceilings is **0.041 test ETH**. A separate proposed **0.007 test ETH** payer allocation gives a conservative authorization accounting total of 0.048, below a proposed one-time 0.05 test-ETH funding amount. The allocation is a transfer between controlled test addresses, not an additional network fee or expected burn. Priority-fee ceilings, exact nonces, destinations, calldata, and current network evidence still need to be fixed in the authorized batch. Nothing here claims a faucet balance has been obtained.

A maximum-cost 250,000-gas claim at 5 gwei consumes 0.00125 test ETH. P would retain at least 0.00575 of the proposed allocation. That covers the existing payment journal's **two equal 0.0025 test-ETH reservations**, if that is its approved per-transaction cap. Counting only the cheaper approval's expected fee would underfund the journal's actual admission rule.

Failed or expired operations can consume bounded gas. Do not increase caps, replace transactions, claim more native funds, or repeat an unknown operation automatically. Current public-fork gas sufficiency still requires verification; local fixtures do not establish it.

## Claim permission is separate from payment permission

The token allocation has no purchase price, but a claim is **not gasless**. An agent with no native test ETH cannot claim. No relayer, paymaster, sponsor, bridge, swap, faucet account, or automated top-up is provided.

A claim needs explicit wallet policy for the pinned D, exact `claim()` calldata, zero native value, chain 11155111, nonce, gas limit, and maximum/priority fees. Deployment, funding, claiming, approval, and payment are distinct operations with separate receipts and native charges. Discovery metadata cannot grant this authority.

The current `TestnetMoteClient` and journal support exact approval plus payment, **not dispenser claims**. There is no implemented claim method or durable claim-recovery state machine. Their calldata guards intentionally reject arbitrary calls. Do not put a claim in an approval/payment slot, broaden an allowlist from a manifest, or reset the budget.

An integrated claim adapter would need reviewed state transitions sharing the payer's native budget and nonce/submission gate with payments. It must persist intent before signing, account the original receipt once, and retain uncertain submissions without retransmitting. Independent journals for the same wallet do not enforce a combined limit. An externally authorized wallet can perform a bootstrap claim before payment operation; that does not mean the current payment SDK automates claiming.

## What an unfamiliar agent still needs

A complete future flow is:

1. Discover a dispenser descriptor and verify its network, token, address, ABI/code/immutables, and deployment/funding evidence against trusted configuration.
2. Have an authorized signer and sufficient native test ETH. Neither is supplied by D.
3. Read `claimed(payer)`, `distributed`, `distributionCap`, `claimAmount`, and `T.balanceOf(D)`. These are current observations, not identity proof or reservations.
4. Under a bounded claim policy, send exactly once and retain the original transaction reference. Verify canonical finalized receipt, D's event, and the resulting token transfer.
5. If submission is uncertain, reconcile the original transaction. `claimed(payer) == true` alone does not identify its original hash, gas cost, or absence of a stale sender; it does not authorize another send.
6. Request a normal signed service offer and use the existing bounded payment flow. A token allocation does not reserve service capacity or override policy, expiry, or finite admission limits.

There is no published D address, live dispenser descriptor, public indexing evidence, implemented claim SDK, or public claim result in this candidate. Deployment verification, discovery wiring, durable claim integration, native-gas onboarding, and public proof remain handoff work. Valid preauthorization can make future routine calls unattended; this document does not claim those missing integrations already exist.

## Abuse and evidence limits

Once per address is **Sybilable**. One actor can create many addresses and exhaust the default 1,000 claims. Transaction ordering, bots, and available gas can determine allocation. There is no fairness, personhood, unique-agent, or usefulness guarantee. An exhausted instance cannot be reset; a replacement is a new identity and requires fresh explicit deployment/funding authority.

Claim counts and addresses are public activity, not organic adoption, unique users, satisfaction, demand for MOTE, or proof that a new token is necessary. Contract implementation and local tests must be reported separately from public operation. Required checks cover exact transfer, replay, exhaustion, underfunding, reentrancy, observable unsupported-token behavior, irreversible excess funding, and unchanged token/router artifacts. Refer to the actual candidate test report; this document does not invent a passing count, public-fork benchmark, arbitrary-token compatibility claim, or security-audit certification.
