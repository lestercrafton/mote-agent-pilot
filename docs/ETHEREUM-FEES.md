# Ethereum Sepolia fee boundary

For the supported ordinary Ethereum Sepolia transaction, the complete network-fee ceiling is:

```text
maximum network fee = signed gasLimit × signed maxFeePerGas
actual network fee  = receipt.gasUsed × receipt.effectiveGasPrice
effectiveGasPrice   = min(maxFeePerGas, inclusionBlock.baseFeePerGas + maxPriorityFeePerGas)
```

This module supports only chain `11155111`, type `2`, zero native value, an explicit nonzero recipient distinct from the sender, an empty implicit access list, and an ordinary ECDSA signature. It rejects contract creation, native transfers, self-calls, authorization lists, blob transactions, extra access-list entries, alternate networks, and unexpected separate fee evidence. Token spending, payee/asset allowlists, wallet exclusivity, deployment identity, request authorization, and shared budget reservations remain the client's separate responsibilities. No fee result creates a signer, sends a transaction, or grants those permissions.

[EIP-1559](https://eips.ethereum.org/EIPS/eip-1559) defines the transaction's execution envelope and the effective price. Ethereum L1 has no additional Base-style L1-data or operator charge for this profile. The existing Base module remains unchanged and still rejects an unenforceable complete fee cap. This change selects a different pinned test network; it does not weaken Base's boundary. Mainnet and arbitrary-chain fallbacks are forbidden.

## Current Sepolia gas rules

The [Ethereum Foundation's announcement](https://blog.ethereum.org/2026/09/17/glamsterdam-testnet-announcement) schedules Sepolia's Glamsterdam upgrade for October 6, 2026, at timestamp `1791294816`. The pinned [Geth v1.17.7 network configuration](https://github.com/ethereum/go-ethereum/blob/v1.17.7/params/config.go) records that activation. Preparation uses timestamp-selected rules for this narrow zero-value, non-self, non-creation profile:

| Observed fork | Intrinsic inclusion gas | Calldata reservation floor |
| --- | --- | --- |
| Before Prague | `21000 + 4 × zeroBytes + 16 × nonzeroBytes` | Same as intrinsic |
| Prague, from `1741159776` | Same as above | `21000 + 10 × (zeroBytes + 4 × nonzeroBytes)` |
| Amsterdam, from `1791294816` | `15000 + 4 × zeroBytes + 16 × nonzeroBytes` | `15000 + 64 × calldataBytes` |

The gas limit must cover the larger inclusion/floor figure. [EIP-7623](https://eips.ethereum.org/EIPS/eip-7623) introduces the Prague calldata reservation; [EIP-2780](https://eips.ethereum.org/EIPS/eip-2780) changes intrinsic costs and [EIP-7976](https://eips.ethereum.org/EIPS/eip-7976) changes calldata pricing. Their combined implementation is visible in Geth's `IntrinsicGas`, `intrinsicBaseGasEIP2780`, and `FloorDataGas` functions. [Pinned transaction-processing source](https://github.com/ethereum/go-ethereum/blob/v1.17.7/core/state_transition.go)

The module also applies conservative application limits: gas limit from `21000` through `16777216` and calldata at most 65,536 bytes. These are product restrictions. They are not a claim that every currently valid Ethereum transaction has those bounds. [EIP-8037](https://eips.ethereum.org/EIPS/eip-8037) changes the `2^24` limit to an execution-gas dimension and permits a larger total transaction gas limit with a state-gas reservoir. [Geth's pinned constants](https://github.com/ethereum/go-ethereum/blob/v1.17.7/params/protocol_params.go) distinguish these limits.

The inclusion floor does not estimate the cost of running an ERC-20 approval or payment. State creation was repriced under Glamsterdam; passing an old local-chain test with a fixed gas limit does not prove that the same limit will complete on current Sepolia. The caller must choose sufficient gas within its preauthorized budget. The fee module never silently raises it. A reverted or out-of-gas transaction still incurs a bounded fee.

## State gas is included in receipt accounting

Amsterdam's separate state-gas dimension is **not a separate uncapped ETH fee**. In [Geth v1.17.7 `settleGas`](https://github.com/ethereum/go-ethereum/blob/v1.17.7/core/state_transition.go), unused execution and state gas are combined before deriving the charged scalar. Refund and calldata-floor handling then produce `UsedGas`, which becomes receipt gas usage. [EIP-8037's transaction accounting](https://eips.ethereum.org/EIPS/eip-8037) likewise defines the scalar transaction gas charge from both dimensions. Consequently, multiplying the receipt's scalar `gasUsed` by its effective price includes both dimensions; adding another state fee would double count it.

Reconciliation requires `0 < gasUsed <= signed gasLimit` and the exact effective-price equation. It does not impose the obsolete blanket `21000` receipt minimum. Inclusion-reservation rules and historical receipt usage are checked separately; EIP-7623/7976 prose also cautions against treating a reserved calldata floor as a universal receipt lower bound. The protocol-profile proof is tied to the reviewed sources and current rules, not a promise that every future Ethereum change is automatically supported. Known incompatible scheduled changes must be reviewed and gated before use; there is no invented expiry based on an EIP editorial deadline.

## API and evidence

`src/ethereum-fees.mjs` exports:

- `normalizeEthereumFeeTransaction(intent)`: validates the exact supported fields and copies them into a normalized intent. `type` and `chainId` are numbers; nonce, gas, fee, and value fields are canonical decimal strings.
- `estimateEthereumFees({reader, transaction, blockTag})`: defaults to the fixed Ethereum Sepolia reader and `latest`. It checks reported chain ID, observes code-free sender state, checks the inclusion floor and base fee, then rechecks the canonical block and chain. It returns an immutable bound, not an execution-success estimate.
- `assertEthereumFeeCap({transaction, evidence, maxFeeWei})`: synchronously recomputes the transaction fingerprint, unsigned encoding length, inclusion rules, every fee component, and the full reservation amount. It compares that amount with an independently supplied policy maximum. A caller-supplied `hardTotalCapEnforced` flag cannot replace these checks.
- `actualEthereumFees({reader, transactionHash, expectedTransaction})`: returns complete finalized fee evidence for the original transaction, including a revert, or fails while retaining uncertainty.

The estimate sets `reservationUpperBoundWei` to the exact gas-envelope product and `hardTotalCapEnforced` to `true`. Its `publicSubmissionAllowed` remains `false`: a fee observation alone is not complete payer authorization. Successful assertion returns `feeBoundarySatisfied: true` and the recomputed reservation. Its evidence checks detect inconsistent or altered fields; neither a hash nor a caller-provided evidence object authenticates an RPC endpoint or establishes freshness. The client obtains fresh observations at each original send boundary, separately checks deployment identity, and reserves its budget before signing.

Actual fee verification reconstructs the signed type-2 bytes from the exact intent and RPC signature, recovers the ECDSA sender, and checks the serialized transaction hash. RPC `r`/`s` scalars may be padded bytes or shortened integer encodings; normalization preserves their numeric value before signature verification. Non-empty access lists, blob or authorization fields, and unsupported fee types are rejected.

Transaction, receipt, canonical block, and block transaction-index membership must agree. Receipt sender, recipient, zero native value, exact calldata, nonce, and gas/fee envelope must match the durable original intent. Both successful and reverted receipts require finalized inclusion. The receipt's parent and inclusion blocks are checked, the original finalized anchor is rechecked, and the current finalized tag is read again before returning. A regressed, contradictory, or noncanonical completion anchor is rejected; ordinary finalized-head advancement is allowed. A block count never substitutes for finalized-tag support.

The sender must have code `0x` at the preparation observation and at the receipt parent/inclusion states for reconciliation. [EIP-7702](https://eips.ethereum.org/EIPS/eip-7702#transaction-origination) permits delegated accounts to originate type-2 transactions, so signature recovery alone does not establish the selected code-free payer profile. These state reads are endpoint observations, not a proof of every intermediate state within a block. Exclusive wallet/nonce control and the exact original-signature policy remain necessary.

Receipt evidence containing L1/operator/deposit fields is rejected, even when an OP fee field claims zero. Nonzero blob receipt fields are rejected. Output retains the shared component names `executionWei`, `l1DataWei: "0"`, and `operatorWei: "0"`; here `executionWei` represents the complete scalar Ethereum network-gas charge, including charged state gas. `feeWei` and `totalFeeWei` are equal. Returned receipt/log data still needs the separate Mote `Paid` verification before an order can be delivered or a token reservation settled.

## Failures and verification

All module errors carry `doNotReleaseReservation: true` and `doNotRepay: true`. A missing receipt produces `FEE_PENDING`; a receipt newer than the finalized head produces `FEE_NOT_FINALIZED`. Those distinct states permit a caller to wait and repeat a read under its original live submission ownership. They never authorize another send. Missing historical state, malformed data, unsupported evidence, incorrect signatures, chain mismatch, and reorg contradictions must stop reconciliation and retain reservations until resolved.

The module trusts one configured RPC endpoint's state and finality reports. It reconstructs transaction signatures but does not independently verify Ethereum consensus or receipt tries. The chain adapter separately checks the known network/genesis and pinned deployment checkpoint. Mocks and local fixtures do not establish public-network compatibility or a completed public payment.

```sh
node --test test/ethereum-fees.test.mjs
```

Focused tests cover exact fee caps and policy limits, forged evidence, fork-specific inclusion rules, signature and shortened-scalar handling, native/blob/set-code/access-list rejection, all receipt bindings, success/revert fees, missing receipt/finality, delegated senders, late reorg/finality regression, arithmetic overflow, and caller mutation. They use public development fixture signatures and mocked reads only; no keys are generated, public transactions sent, or denied credential actions retried.
