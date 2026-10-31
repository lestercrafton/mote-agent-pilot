# Automatic test-MOTE onboarding candidate

`ClaimThenPayClient` performs a finalized dispenser claim, obtains a quote for a public synthetic JSON task, then calls the existing durable payment client. Valid preauthorization is sufficient for routine operation: no human confirmation screen occurs between these steps. This candidate is not deployed. Its integration tests use a loopback EVM and HTTP service, public fixture accounts, and the same Ethereum fee verification code as the public client.

The supported public network is Ethereum Sepolia (`11155111`). The public constructor requires the original verified public chain configuration and pinned read-only network source. `forLocalFixture` is an explicit test-only constructor requiring the existing local-EVM acknowledgment and literal loopback signer/RPC/HTTP transport. It does not replace fee checks. Base's complete-fee refusal remains unchanged.

## One wallet authority

Initialize the ordinary `TestnetBudgetJournal` first, before any payment attempts. Then explicitly initialize `ClaimBudgetJournal` once with:

```js
const journal = ClaimBudgetJournal.initialize({
  path: claimJournalPath,       // a new private local file; never auto-recreate
  policyId: 'payer-onboarding-v1',
  policy: claimPolicy,
  dispenserIdentity: dispenserChain.identity,
  paymentJournal,
});

const client = new ClaimThenPayClient({
  journal,
  paymentClient,               // existing TestnetMoteClient using paymentJournal
  dispenserChain,              // verified createDispenserChain(...) result
  signer,                     // caller-provisioned, trusted exact-request signer
});

const response = await client.claimThenExecute(input, {
  operationKey: 'agent-task-0001',
  publicSynthetic: true,
});
```

On restart, use `new ClaimBudgetJournal(...)` with the same paths, policy, policy ID, verified dispenser identity and reopened payment journal. Opening never creates missing files. Constructor identity binds the payment journal's canonical path, device/inode and complete immutable context, as well as the dispenser's code, deployment/funding/checkpoint hashes, base configuration, chain genesis, payer and HTTPS origin. Unknown policy fields are rejected; no keys or signer objects belong in either database.

The claim journal has one atomic, cross-process wallet gate. It holds that gate across claim, approval, payment and unknown outcomes. The payment signer wrapper requires the original owner, matching operation and a fresh exact inner payment intent before each send. Both the ordinary payment intent and outer send marker are durable before invoking the signer. There is no time-expiring lease or ownership takeover. A process stopped before sending cannot resume after a safe read-only recovery has ended its operation: the wrapper rejects that stale owner's next send.

All participating processes must use these same two journals and the wrapped signer. A caller with the raw signer, copied journals, another application or another wallet authority can bypass this software policy. A trusted signer must honor the exact type-2 chain, nonce, destination, native value, calldata and fee fields. The wrapper cannot prevent a malicious custody adapter from changing a transaction before it broadcasts. EOA only; no smart accounts, EIP-7702 delegation, account creation, chain switching, swaps, bridging, gas sponsorship or top-ups.

## Fixed fee allocations

The current proposed profile uses decimal wei strings:

| Permission | Gas limit | Maximum fee/gas | Signed fee ceiling |
|---|---:|---:|---:|
| `claim()` at the pinned dispenser, zero native value | 500,000 | 2 gwei | 0.001 test ETH |
| Exact token approval for the signed quote | 250,000 | 2 gwei | 0.0005 test ETH |
| Exact original quote payment | 500,000 | 2 gwei | 0.001 test ETH |

Priority fee is capped at 1 gwei. The claim policy allocation is `maxClaimGasWei: "1000000000000000"`; the payment journal reserves `maxGasPerTransactionWei: "1000000000000000"` for each of its two steps, and its lifetime `maxGasTotalWei` is `"2000000000000000"`. The claim policy pins `maxPaymentGasWei` to that same value. The combined `maxTotalGasWei` is `"3000000000000000"` (0.003 test ETH), including the payment journal's deliberately conservative approval reservation. The three actual signed transaction ceilings sum to 0.0025 test ETH. A proposed 0.007 test-ETH payer allocation is separate from these fee limits; the client does not obtain it automatically.

Full claim policy fields are exactly:

```js
{
  enabled: true, chainId: 11155111,
  payer, serviceOrigin, baseConfigHash, dispenserConfigHash, dispenser,
  claimGasLimit: '500000',
  maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000',
  maxClaimGasWei: '1000000000000000',
  maxPaymentGasWei: '2000000000000000',
  maxTotalGasWei: '3000000000000000',
}
```

These are explicit limits, not estimates of execution success. Ethereum's zero-value type-2 `gasLimit × maxFeePerGas` ceiling is recomputed from each exact intent by the existing fee module. Gas limits are never increased automatically. A reverted claim is charged its actual canonical fee, recorded permanently and never retried. The local EVM runs Shanghai; it does not prove successful execution on the current public fork. The more conservative 500,000 claim gas limit is a reviewed proposal, not public execution evidence.

Actual claim and payment fees are recorded separately and exposed together by `client.budget`. Claim costs do not disappear after initialization or restart. The payment allocation is a lifetime cap for this journal, so a completed first task can leave too little room to reserve another pair of transactions; this causes an automatic denial. There is no automatic policy expansion, fresh journal or balance replenishment.

## Recovery and failure behavior

`await client.recover(operationKey)` verifies the original recorded transactions and retrieves the existing result. Construct the recovery client without a signer. Recovery never calls signer methods, creates a new reservation, repeats a claim, repeats a payment or resumes a partly executed transaction sequence.

If service data was lost after a backup restore, pass the original public synthetic input:

```js
await client.recover('agent-task-0001', {
  originalInput: input,
  publicSynthetic: true,
});
```

Local request/result hashes must match the original operation. The existing payment client's signed-offer reconstruction and receipt verification remain active.

- A lost HTTP result after a known finalized payment is recoverable without another transaction.
- A known claim hash can be reconciled after a finality timeout. If no payment began, recovery returns `status: "claim_finalized_no_payment"`, ends the old operation and sends nothing. A separately identified new task may then use the confirmed claim under the unchanged remaining policy.
- An intent whose send returned no durably recorded hash remains uncertain. Merely observing `claimed(payer) == true` does not release its original fee reservation or wallet gate. Recovery does not guess the hash or rebroadcast.
- A known approval followed by an unknown payment remains owned by the inner payment journal and outer wallet gate. Neither journal automatically resumes after a crash.
- Once a quote is durably handed to the payment client, an absent inner reservation is not evidence that its original process stopped. Recovery retains the outer gate in that case; it never reports completion while a delayed original could still create inner authority. This conservative rule may require explicit investigation after a crash during handoff.
- Finality polling is limited to the original live owner and original hash, default 30 minutes with 15-second polls, maximum 30 minutes. Only pending/not-finalized evidence is retried. Timeout retains authority.
- An already-claimed wallet is inspected at canonical finalized state and does not send another claim. Its earlier external claim costs are outside this newly authorized journal, not asserted to have been free. Any previously attempted claim in this journal prevents that shortcut from erasing uncertainty.
- Exhaustion, insufficient dispenser funds, insufficient payer gas, wrong identity, altered input, disabled policy or a fee cap failure prevents new sends. Claims are once per address and sybilable; no identity/fairness or free native gas is promised.

Both SQLite stores require trusted writable local storage. The outer store uses `BEGIN IMMEDIATE`, WAL, `synchronous=FULL`, bounded busy waits, schema/checksum/invariant validation, and file identity/hardlink checks. Missing, read-only, corrupt or replaced files fail closed. Well-formed malicious database rollback/copying remains outside the prototype's guarantees. Do not delete a journal to recover availability; retain unknown intent evidence and resolve the original chain state.

## Local evidence

`node --test --test-concurrency=1 test/claim-client.test.mjs` exercises the actual claim→approval→payment path, exact receipt-fee accounting, response loss and restart, unknown send retention, bounded finality waiting, preexisting claims, canonical reverts, exhausted distribution, stale-owner fencing and independent processes sharing the same SQLite authority. These are controlled local tests, not external adoption, public settlement or a security audit.
