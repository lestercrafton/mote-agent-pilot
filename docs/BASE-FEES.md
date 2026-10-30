# Base fee observations and reconciliation

The public payer cannot enforce its complete authorized native-fee ceiling with an ordinary Base type-2 transaction. **Public submission is disabled.** `assertPublicFeeCap()` always rejects with `BASE_TOTAL_FEE_CAP_UNENFORCEABLE`; it accepts no configuration flag, safety margin, or caller-supplied certificate that changes that result. Tests may exercise separate isolated fixture capabilities, but those do not establish a public-chain guarantee.

This is a protocol limitation, not a missing multiplication. The [Base network fee documentation](https://docs.base.org/specifications/transactions/network-fees) distinguishes execution and L1 data charges. The [OP Stack fee documentation](https://docs.optimism.io/op-stack/transactions/fees) states that the current transaction format cannot limit the maximum L1 data fee. EIP-1559 `gasLimit × maxFeePerGas` caps execution cost; it does not cap all separate fees. An observed price, percentage margin, short quote lifetime, or larger budget reservation does not change what a signed transaction authorizes at inclusion.

The reviewed [GasPriceOracle source](https://github.com/ethereum-optimism/optimism/blob/develop/packages/contracts-bedrock/src/L2/GasPriceOracle.sol) identifies version `1.6.0`. Its `getL1FeeUpperBound(unsignedTxSize)` uses a practical compression-size estimate, accounts for signature size internally, and evaluates prices and scalars in the queried block. Its documented coverage is 99.99%, not a universal upper bound. The module passes the byte length of the exact unsigned type-2 encoding; it does not add another signature allowance. The official source links name moving branches, so their contents must be reviewed again before expanding supported versions.

## API

`src/base-fees.mjs` provides these read-only operations:

| Export | Result |
| --- | --- |
| `normalizeBaseFeeTransaction(intent)` | Validates and copies an exact Base Sepolia intent. |
| `estimateBaseFees({reader, transaction, blockTag})` | Observes execution maximum, estimated L1 size-based charge, and operator charge at the gas limit in one block; rechecks that block and network. Defaults to `finalized`. |
| `assertPublicFeeCap()` | Always rejects ordinary public submission; there is no bypass option. |
| `actualBaseFees({reader, transactionHash, expectedTransaction})` | Reconciles complete canonical finalized receipt evidence into execution, L1, operator, and total fee amounts. |

An intent has exactly `type: 2`, `chainId: 84532`, `from`, `to`, `nonce`, `gasLimit`, `maxFeePerGas`, `maxPriorityFeePerGas`, `value: "0"`, and `data`. Monetary/gas/nonce fields are unsigned decimal strings. Recipient, sender, calldata, nonce, and fee envelope are all bound to the result fingerprint. No signer, key, automatic fee/nonce population, deployment, access list, native transfer, bridge, swap, top-up, or RPC write is implemented. The default reader uses the existing fixed Base Sepolia read endpoint; test readers are dependency-injected mocks.

Estimate output includes `estimatedTotalAtAnchorWei`, but deliberately sets `reservationUpperBoundWei: null`, `hardTotalCapEnforced: false`, and `publicSubmissionAllowed: false`. It also records the exact block, oracle version, observed code hashes, and fee components. This result is diagnostic preparation, not a promise about inclusion fees or permission to spend. Unknown versions, methods, fork flags, malformed ABI values, arithmetic overflow, mismatched networks, or changed canonical blocks are errors.

## Actual fees

For a finalized supported transaction, reconciliation computes:

```text
execution = receipt.gasUsed × receipt.effectiveGasPrice
total     = execution + receipt.l1Fee + historicalOperatorFee
```

The RPC transaction must match the full expected intent. Transaction and receipt hash, block number/hash, transaction index, sender, and recipient must agree, and the block must contain that hash at that index. Execution gas must fit the signed limit; effective gas price must match the inclusion block's base fee and the signed EIP-1559 envelope. Both successful and reverted transactions incur fees and undergo the same canonical/finality checks. A confirmation count is never substituted for the `finalized` tag.

Operator evidence comes from `GasPriceOracle.getOperatorFee(receipt.gasUsed)` and the L1Block predeploy's scalar/constant **at the receipt's block number**, with canonical block rechecks before returning. Under [Isthmus](https://specs.optimism.io/protocol/isthmus/exec-engine.html), the operator charge is `floor(gasUsed × scalar / 1,000,000) + constant`; [Jovian](https://specs.optimism.io/protocol/jovian/exec-engine.html) changes it to `gasUsed × scalar × 100 + constant`. The module checks the oracle result against these supported rules. A pruned historical state or missing method is not replaced with latest state.

The [OP execution-client receipt fields](https://github.com/ethereum-optimism/op-geth/blob/optimism/core/types/receipt.go) include `l1Fee` and operator parameters. [Receipt derivation](https://github.com/ethereum-optimism/op-geth/blob/optimism/core/types/receipt_opstack.go) omits both operator fields when both parameters are zero. Missing fields are accepted as zero only when historical oracle and L1Block evidence explicitly establish zero; nonzero or partial missing evidence is rejected. Jovian's `blobGasUsed` represents DA footprint. It is not an extra payable EIP-4844 blob fee on the supported ordinary type-2 transaction.

`actualBaseFees()` returns `feeWei`/`totalFeeWei`, individual components, normalized transaction, canonical block, finality anchor, and a cloned validated receipt for the caller's separate payment-event check. Fee reconciliation does **not** prove that a Mote `Paid` event exists, deliver an order, release a journal entry, or authorize a replacement transaction. Every error carries `doNotReleaseReservation: true` and `doNotRepay: true`: callers must retain uncertain reservations and reconcile without resubmission. An actual fee above a policy limit remains a real incurred charge and must not be hidden or clamped.

This evidence trusts one RPC endpoint's canonical/finalized reports and historical state. Observed code hashes and a version string are not independent consensus or bytecode-attestation proofs. The supported oracle interface is intentionally narrow; older/pruned or newly upgraded deployments can remain unavailable until reviewed. No public transaction or deployed-oracle compatibility is claimed from the mocked tests.

## Local verification

```sh
node --test test/base-fees.test.mjs
```

The suite tests all three fee components, exact encoding size, hard-cap refusal despite forged flags, missing/invalid oracle evidence, both operator formulas, zero-fee evidence, incomplete L1/operator receipts, transaction/proof conflicts, late reorgs, reverted transactions, finality failure, integer overflow, and Jovian DA-footprint handling. It uses deterministic mocked RPC responses and performs no public transactions or credential operations.
