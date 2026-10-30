# Registered testnet client and durable budget

This is a separate, unpublished pilot adapter. The original local `MoteClient`, `DurableMoteClient`, and `SQLiteBudgetJournal` are unchanged. No public transaction was broadcast by its tests.

`TestnetMoteClient` can inspect discovery and authenticated quotes, reconcile previously tracked finalized transactions, recover results, and reconstruct service records lost after backup restoration. Ethereum Sepolia (11155111) supports ordinary type-2 zero-value payments under a transaction-enforced native ceiling of `gasLimit * maxFeePerGas`. The client recomputes and validates this ceiling, preauthorizes both exact intents within caller limits, then automatically approves and pays through the caller-provisioned signer. It never increases fee limits, replaces transactions, or tops up funds.

Base Sepolia (84532) remains different: ordinary type-2 transactions cannot enforce a complete L1 + L2 + operator fee cap. **Base `execute` still rejects with `BASE_TOTAL_FEE_CAP_UNENFORCEABLE` before any signer method or new reservation**. An estimated fee, caller boolean, or external claimed attestation cannot enable it. Existing controlled Base tests use an explicitly synthetic transport, never a public cap claim.

## Construction and policy

```js
import { createEthereumSepoliaReader } from '../src/testnet-rpc.mjs';
import { createTestnetChain } from '../src/testnet-chain.mjs';
import { TestnetMoteClient, readTestnetIdentity } from '../src/testnet-client.mjs';
import { TestnetBudgetJournal } from '../src/testnet-journal.mjs';

// config, expectedConfigHash and policy are trusted operator/caller inputs.
// A remotely discovered manifest does not supply spending authorization.
const chain = await createTestnetChain({ config, expectedConfigHash });
const chainIdentity = await readTestnetIdentity(chain);
const options = { path: journalPath, policyId, policy, chainIdentity };

// Run initialize(options) once, explicitly, for a genuinely new authority file.
// It returns an open handle and fails if the file already exists.
// const journal = TestnetBudgetJournal.initialize(options);
const journal = new TestnetBudgetJournal(options); // existing file only
const client = new TestnetMoteClient({
  baseUrl: policy.serviceOrigin,
  reader: createEthereumSepoliaReader(), chain, policy, journal,
  signer: externallyProvisionedSigner, // omit for read-only recovery
});
```

Required policy fields are `enabled`, `chainId: 11155111` (or explicitly `84532`), `payer`, `token`, `router`, `recipient`, `quoteSigner`, exact non-loopback HTTPS `serviceOrigin`, `publicSynthetic: true`, `configHash`, `deploymentAnchorHash`, `maxSingleSpend`, `maxTotalSpend`, `maxGasPerTransactionWei`, `maxGasTotalWei`, `maxFeePerGas`, and `maxPriorityFeePerGas`. All limits and fees are decimal integer strings. Optional `asset` must be `MOTE`, and optional `decimals` must be `6`. `deploymentAnchorHash` is `hashJson(chain.config.deployments)`. Unknown policy fields are rejected.

The journal additionally binds the pinned checkpoint hash, contract runtime code hashes, quote signer, and optional genesis hash. Base pruned-history configurations may use `genesisHash: null`; Ethereum requires its known public genesis verified by the deployment adapter; the verified finalized checkpoint and deployment anchors remain mandatory. Policy IDs, limits, addresses, origin, or chain identity cannot silently change on reopening.

`TestnetMoteClient` accepts `{baseUrl, signer?, reader, chain, policy, journal, fetchImpl?, finalityWaitMs?, finalityPollMs?}`. `fetchImpl` is a test transport hook, not a spending authorization. Public construction still rejects local-fixture configurations, other chains, and non-HTTPS origins. Signer keys, provider objects, and raw signed transactions never enter the journal.

## Agent operations

```js
await client.discover();
const offer = await client.quote(publicSyntheticInput, quoteKey, {
  publicSynthetic: true,
});
// Ethereum Sepolia executes within the caller policy; Base rejects its full fee cap.
await client.execute(offer, orderKey);

// Read-only recovery of an existing tracked attempt; null uses its recorded hash.
await client.recover(originalSignedOffer, null, originalOrderKey);

// Restore a missing service record using retained original input.
await client.recoverFromOriginalInput(
  originalSignedOffer, originalPublicSyntheticInput,
  originalPaymentHashOrNull, originalOrderKey,
  { publicSynthetic: true },
);
```

Retain the original signed offer, public synthetic input, order key, transaction references, and journal. The journal intentionally stores the offer and returned result, not the original input. Reconstruction locally recomputes both the request and result hashes, verifies finalized original fee/payment evidence, posts to `/v1/recover`, and verifies the signed receipt. It cannot adopt an untracked payment, replace a payment hash, reset authority, or resume a send. When restoring server state after a previously completed result, the first immutable durable receipt remains authoritative locally.

`client.budget` returns integer strings `{tokenReserved, tokenSpent, gasReservedWei, gasSpentWei}`. Ethereum receipt accounting verifies the exact type-2 transaction signature/hash and canonical finalized execution fee. Base accounting separately includes execution, L1 data, and operator fees. If a canonical actual fee exceeds a former reservation, it is counted rather than hidden; further continuation fails closed.

## Signer and original-owner finality wait

A signer implements `getAddress(): Promise<string>` and `sendTransaction(exactUnsignedIntent): Promise<{hash}>`. It is trusted caller-provisioned code that must sign/send exactly the supplied network, payer, destination, calldata, nonce, zero native value, gas limit, and type-2 fee fields. The supported transaction path is EOA-only, including an ethers JsonRpcSigner connected to the selected network or an equivalent exact-request adapter. ERC-4337, EIP-7702 delegation, and smart-contract wallets are unsupported. There is no account or chain switching, wallet-connection setup, or arbitrary-wallet compatibility claim. It must reject unsupported requests, never mutate them or add approvals, swaps, bridging, top-ups, or replacement transactions. The client persists the exact intent before calling it and verifies the original transaction cryptographically and against all intent fields before resolving accounting. A malicious signer outside that interface contract is not controlled by a local SQLite file.

The live original owner polls its known original transaction for finalized proof before proceeding. Defaults are a 30-minute wait and 15-second polling; constructor bounds allow 0–30 minutes and 100–60000 ms polling. Only `FEE_PENDING` and `FEE_NOT_FINALIZED` are retried. Missing/malformed evidence, canonicality changes, or timeout retain the reservation and wallet gate. After approval finality, the client rechecks deployment identity, quote deadline, and exact next nonce before a payment intent. Restarted recovery never resumes submission. Ethereum gas ceilings are fixed conservatively at 250000 for approval and 500000 for payment, each checked against the authorized full fee cap. Local Shanghai tests do not prove gas sufficiency on every public fork; a bounded revert remains possible and is never automatically retried.

## Explicit local rehearsal

`TestnetMoteClient.forLocalFixture({...options, acknowledgment: LOCAL_FIXTURE_ACKNOWLEDGMENT, localServiceOrigin})` uses the same class, fee checks, durable transitions, and signed-transaction proof validation. It requires a verified `local-fixture` chain with a genesis hash, a literal loopback HTTP RPC reader, and any supplied signer's `JsonRpcProvider` connection at that same loopback origin. `localServiceOrigin` must also be literal loopback HTTP. Signed metadata still uses its pinned HTTPS origin. The private construction capability cannot be supplied as a public constructor option. No production entrypoint invokes the factory.

`test/helpers/ethereum-client-harness.mjs` starts real local Ganache RPC and the real HTTP/service/store implementation. Its transactions are actual local EVM settlement, not Ethereum Sepolia settlement. It uses no fee-boundary override; known public fixture accounts stay on loopback. The helper is intended only for tests and the explicitly labeled local demo.

## Recovery and storage limits

SQLite transactions atomically reserve both payment and fee authority across processes. One non-expiring wallet gate spans approval and payment. Exact calldata and nonce intents are recorded before a signer could see a transaction. Known hashes can be reconciled read-only. Unknown original sends retain their fee reservation and gate, even after another canonical matching payment is observed. Recovery never calls a signer, sends an approval, or broadcasts a replacement.

Use one pinned journal for every process controlling that payer. WAL with FULL synchronization, bounded write-lock waits, checksums, schema/accounting invariants, inode checks, and hardlink rejection detect many storage failures. Missing, read-only, corrupted, or replaced files fail closed; they are never re-created automatically. Trusted storage is still required: a valid malicious rollback, editing the program, external wallet activity, or using independent journals cannot be prevented by this local authority store. A stopped owner may leave approval or send authority permanently reserved rather than risk a stale sender racing recovery.

RPC evidence assumes the selected reader is trustworthy; it is not an independent consensus proof. Missing finality or total-fee evidence retains authority. A chain/finality failure during delivery reports `settlementState: 'reconciliation_required'` without reducing already counted spending. An ordinary delivery/result failure after verified settlement reports recovery guidance and never authorizes repayment.

## Verification

`node --test test/ethereum-client.test.mjs test/ethereum-journal.test.mjs` exercises actual loopback EVM transactions, real HTTP service delivery, and cross-process client budget authority. Existing `testnet-client`, `testnet-journal`, and `base-fees` suites preserve Base refusal and recovery regressions. Client tests cover cap rejection before signer use, authenticated requests/results, restart recovery, lost send and service responses, missing fee evidence, reorgs, tampered receipts, reverted payments, reconstruction, and storage failures. Separate contract/service suites cover actual local EVM integration. Neither kind is public-network settlement or external adoption.
