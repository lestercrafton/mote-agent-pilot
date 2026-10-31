# Bootstrap runner interface — preparation only

This module prepares and, only with separately approved custody and caller authorization, executes the five operator transactions in the [v0.7 proposal](BOOTSTRAP-PROPOSAL-v0.7.md). It does not perform the controlled payer's three transactions. There is no auto-execution CLI. The examples below are interface documentation; no public identity, key, permission or deployment is supplied by this document.

## Offline plan

`createBootstrapPlan` compiles the committed sources locally and accepts exactly these public fields. It neither opens a provider nor creates a key:

```js
import { createBootstrapPlan, validateBootstrapPlan } from '../src/bootstrap-plan.mjs';

const plan = createBootstrapPlan({
  chainId: 11155111,
  operator: publicRoles.operator,
  merchant: publicRoles.operator,
  quoteSigner: publicRoles.quoteSigner,
  payer: publicRoles.payer,
  operatorNonce: approvedStartingNonce, // canonical decimal string
  payerNativeWei: '7000000000000000',
});
validateBootstrapPlan(plan); // reconstructs source, roles, calldata and all caps
```

Payer and quote signer must be distinct from each other and the operator/merchant. Operator and merchant may share one address. Native allocation must be between 0.003 and 0.007 test ETH: the payer journals reserve 0.003 even though the three signed transaction ceilings total 0.0025. The plan fixes the other amounts, eight gas limits, 2 gwei maximum fee and 1 gwei priority fee. It carries canonical Sepolia genesis, predicted contract addresses, constructor arguments, compiler/source hashes, policy hash and plan hash. These public hashes detect changes; they are not signatures or authorization.

## Explicit durable authority and inactive custody

Use one approved canonical absolute journal path for the operator. Initialization is a separate local operation and must happen exactly once:

```js
import { initializeBootstrapJournal } from '../src/bootstrap-runner.mjs';

initializeBootstrapJournal({ path: approvedJournalPath, plan });
```

It creates the main SQLite journal and a `.lock.sqlite` process gate. Existing or partial files are never overwritten. Reopening uses the original files; creating a new path, copying a journal or restoring an older snapshot is not recovery. The lifetime process gate protects this canonical journal, not every possible use of the wallet. All operator custody must be exclusive to it, including across other tools and manual operations. Trusted local storage is required; checksums detect damage, not an administrator's valid rollback or rewrite.

The optional [native custody interface](../scripts/keychain/README.md) stays inactive until its separately reviewed provisioning/access action is authorized. Its exact bootstrap configuration is:

```js
const custodyOptions = {
  role: 'bootstrap',
  chainId: 11155111,
  allowedTransactions: plan.transactions.map(({ transaction }) => {
    const { from, ...unsignedIntent } = transaction;
    return unsignedIntent;
  }),
  activation: explicitlyApprovedNativeActivation,
  helperPath: approvedAbsoluteHelperPath,
  expectedHelperSha256: approvedHelperDigest,
};
// After separate native-access approval only:
// const signer = await openKeychainSigner(custodyOptions);
```

`openKeychainSigner` comes from `src/keychain-custody.mjs`. It yields only `getAddress()` and `signTransaction(exactIntent)` for this role, with no provider or broadcast method. The runner captures these methods before asynchronous work. Native activation metadata is a programming gate, not user consent. No real Keychain compatibility or access is established by fixture tests.

## Exact caller authorization and one-step execution

`createBootstrapRunner` requires an explicit authorization object with exactly these fields, supplied by the separately authorized caller:

```js
const authorization = {
  schema: 'mote-bootstrap-authorization-v1',
  enabled: true,
  planHash: plan.planHash,
  policyHash: plan.policyHash,
  chainId: 11155111,
  operator: plan.roles.operator,
  maximumTotalNativeWei: '50000000000000000',
  expiresAt: approvedExpiryUnixSeconds, // positive safe integer
};
```

The object is not cryptographic proof of permission; its creation belongs inside the approved caller boundary. It is never inferred from a plan or enabled by default.

```js
import { createBootstrapRunner } from '../src/bootstrap-runner.mjs';

// Only after the exact public actions, custody and policy are approved:
// const runner = await createBootstrapRunner({
//   plan, authorization, path: approvedJournalPath, signer,
// });
// try { const state = await runner.advance(); }
// finally { runner.close(); }
```

Each `advance()` first reconciles earlier transactions and may sign/broadcast at most one new pending step. It requires unchanged operator nonce, an undelegated EOA, sufficient remaining balance, canonical chain identity, an unexpired authorization and successful exact-transaction estimation. Intent commits before custody; the returned signed hash commits before broadcast. The journal stores public unsigned intents, transaction hashes and proofs, never keys or raw signed transaction bytes. There is no fee bump, replacement, refill, reset or automatic rebroadcast.

## Read-only recovery and estimation

Reopen the original journal without a signer and call `reconcile()`:

```js
const recovery = await createBootstrapRunner({
  plan, authorization, path: approvedJournalPath,
});
try { const state = await recovery.reconcile(); }
finally { recovery.close(); }
```

The same exact authorization binding is still required; its expiry does not block read-only reconciliation. `reconcile()` never invokes custody or broadcasts. Known hashes are checked against exact signed transaction fields, canonical inclusion, finalized history, source/runtime configuration and fees. Previously stored finalized anchors must remain canonical; a newer finalized head does not replace the original evidence. A missing hash, pending proof, reverted transaction, changed checkpoint or damaged authority stops progress. Even a known signed hash never observed on chain is not resubmitted. Interrupted signing can block indefinitely.

`estimateBootstrapTransaction({plan, index})`, exported from `src/bootstrap-runner.mjs`, performs read-only estimation against the fixed Ethereum Sepolia endpoint; `index` is 0–4. It does not modify the existing payment reader's method allowlist. The estimate uses the exact type-2 intent at a rechecked canonical block, rejects values below the reviewed necessary gas floor or above the signed ceiling, and never adjusts a cap. Later steps require their real predecessor state to exist. The runner repeats this check before signing and before submission. Successful estimation is neither authorization nor a guarantee of execution.

## Local evidence and limits

`test/bootstrap.test.mjs` passes 13 focused cases on Node 24.22.2, including actual five-transaction loopback execution, cross-process exclusion and four real process terminations: intent, signed hash, broadcast and finalized commit. It also exercises stale finalized anchors, custody mutation, authorization expiry during asynchronous work, invalid estimates and storage failures. The shared harness is `test/helpers/bootstrap-harness.mjs`; its separate local-only constructors cannot reopen a public-mode journal.

These fixtures use public known test accounts, Shanghai execution and simulated immediate finality on chain ID 11155111. They do not establish current public Sepolia execution costs, consensus finality, RPC authenticity independent of the pinned source, native custody readiness or public deployment. Current-fork execution qualification and all real activation actions remain separate.
