# Durable budget journal — v0.2.0 candidate

This candidate adds a separate durable client without changing the published free service, token contracts or payment protocol. Implementation, regression tests and a focused independent code review completed on 2026-10-30. This is a tested local prototype, not a production-safety claim or security audit. The published v0.1.0 source remains unchanged.

## Authority and storage boundaries

One explicitly initialized SQLite file represents one spending authority. All cooperating processes using that authority must open the same file. Opening an existing journal must never create or replace it. Initializing a new journal is an explicit grant of a new budget, not a restart convenience. Separate files are separate authorities; the implementation cannot enforce a global limit across independently created files or wallet software that bypasses it.

The journal binds a policy identifier, normalized public policy fields, service origin, payer, asset, router, merchant, limits and chain identity. The chain identity includes the immutable quote signer and chain-boot evidence because local addresses and chain ID 31337 can repeat after reset. A mismatch must stop before wallet submission. Policies are immutable within a journal; changing a policy is not an implicit balance reset.

The journal contains public offers, unsigned transaction intents, hashes, reservations, fees and receipt/result metadata. It never stores a signer, private key, mnemonic, raw signed transaction or wallet credential. Fixture keys stay in the existing local EVM process.

SQLite transactions atomically check limits, reserve token and approval/payment fee budgets, and claim wallet submission ownership. Fee and token observations must be unique so concurrent recovery cannot double-account them. A non-expiring wallet gate prevents another process from submitting while a previous intent is unresolved. Budget locking alone would not serialize signer nonces.

## Crash and recovery rules

Each approval/payment intent is durably recorded before calling the signer. Recording its transaction hash is a later operation, so a crash may leave an intent with no hash. Missing hashes, absent payment events, elapsed time and expired quotes do not prove that nothing was submitted.

Recovery reads chain evidence and updates the journal; it never approves, pays, replaces or rebroadcasts a transaction. An existing entry is never treated as a fresh executable request after restart. Uncertain approval and payment fees remain separately reserved. A canonical payment event proves token settlement but does not by itself prove the fee outcome of a different unresolved intent.

Unsent reservations may be cancelled only with an atomic state transition that prevents their old owner from beginning an intent afterward. An intent is never taken over merely because a lease expired or its original process disappeared. A process can pause between its durable intent write and its network call, then resume later; recovery must remain safe under that ordering.

## Candidate API

Run the isolated demonstration with `npm run demo:durable`. It performs one local fixture payment, loses delivery, closes and reopens the authority file, recovers the result with no signer calls, and rejects another payment beyond the persisted total limit.

The existing `MoteClient` remains available with its original in-memory behavior. Opt into `DurableMoteClient`, supplying the same `baseUrl`, `signer`, `provider` and `policy`, plus an explicitly opened `SQLiteBudgetJournal`.

```js
import { SQLiteBudgetJournal } from './src/journal.mjs';
import { DurableMoteClient, readChainIdentity } from './src/durable-client.mjs';

const options = {
  path: '/trusted/local/state/agent-budget.sqlite',
  policyId: 'authorized-agent-budget-v2',
  policy,
  chainIdentity: await readChainIdentity(provider, policy),
};

// One-time explicit authority creation only, at a new path:
const initial = SQLiteBudgetJournal.initialize(options);
initial.close();

// Normal starts use existing-only open. Never initialize in an error handler.
const journal = new SQLiteBudgetJournal(options);
const client = new DurableMoteClient({ baseUrl, signer, provider, policy, journal });
const offer = await client.quote({ document: { task: 'synthetic fixture' } }, 'quote-key-0001');
const result = await client.execute(offer, 'order-key-0001');
// On restart, recover a tracked row using its original offer/key/hash:
// await client.recover(row.offer, row.paymentHash, row.idempotencyKey);
journal.close();
```

The code sample assumes the caller already owns the valid local fixture provider/signer and has provisioned the parent state directory. Its policy has the same fields as the original client: explicitly enabled, exact loopback origin, chain 31337, payer/token/router/recipient and token/native-fee limits. Quote signer binding is also retained. The demo contains a complete runnable setup.

`journal.list()` exposes persisted rows for read-only planning and reconciliation. `journal.budget()` returns shared current totals. `cancelReserved(quoteId)` is permitted only before any send intent exists and atomically fences the original owner; it is not an escape hatch for unknown submissions. A cancelled quote remains a tombstone: execution and recovery reject it with `ATTEMPT_CANCELLED`, and only a fresh quote can request a new reservation. Untracked external payments cannot be imported through durable recovery, because their historical approvals and authority are not known.

## Explicit limits

- The host filesystem, SQLite file and its WAL are trusted local storage. File deletion, corruption, replacement, incompatible schema, unavailable writes and identity mismatches must fail closed. There is no in-memory fallback.
- A self-contained local journal cannot detect a malicious byte-for-byte rollback of the database and its WAL to an older valid snapshot after every process stops. Backups, anti-rollback anchoring and durable host operations require a separate production design.
- Reconciliation may deliberately retain reservations and submission ownership indefinitely when evidence cannot resolve an intent. This trades availability for avoiding unauthorized additional spending; it is not an automatic recovery guarantee for every crash point.
- Sharing an unlocked fixture signer with unrelated software lies outside the journal's enforcement boundary. Public-chain finality, adversarial RPCs, real key custody and production nonce management remain out of scope.
- No new public-chain transactions, hosted storage, paid services, credentials or deployments are part of this candidate.

## Verification evidence

On Node.js 25.4.0, `npm test` passed **98/98 tests**, with no failures or skips (40.88 seconds). This includes 22 durable-client integration tests and 13 journal tests alongside the original 63 regression tests. The [captured output](candidate-v0.2-tests.txt) replaces local filesystem prefixes with `<project>` for portability; test outcomes are unchanged.

Real child processes shared one SQLite journal and one real local fixture EVM. Tests exercised cross-process budget and same-quote races; SIGKILL before/after approval and payment dispatch; kills after reservation, approval-hash, payment-hash and settlement commits; dropped committed responses; simultaneous recovery; identity/reset mismatches; missing, corrupt, replaced and read-only journals; and zero additional submissions during recovery. Ledger tests also reject semantic corruption, missing fee entries, hard-linked files, wrong owners and unsafe approval intents.

`npm run demo:durable -- --evidence` passed after the final changes. Its [evidence](candidate-v0.2-demo-evidence.json) records one actual local-chain payment of 3,300 MOTE base units, persisted token and fee spending, result recovery after reopening storage, **zero signer calls during recovery**, no duplicate payment, and rejection of a fresh quote beyond the persisted budget. The original `npm run demo` also passed during this candidate run. The durable demonstration reopens handles; the separate tests perform actual process kills.

A separate internal reviewer examined the journal and client, independently exercised accounting/corruption/ownership boundaries, and reported no remaining material findings after fixes. This was a focused review, not a comprehensive audit. Tests do not prove physical power-loss durability, malicious storage rollback protection, production key custody, public-chain finality or external agent demand.

## Storage references

The journal uses [`BEGIN IMMEDIATE`](https://www.sqlite.org/lang_transaction.html) to serialize the check-and-reserve transaction and [`synchronous=FULL` with WAL](https://www.sqlite.org/pragma.html#pragma_synchronous) for SQLite's documented commit-sync behavior. This is not a claim that physical power-failure durability was tested. The implementation is exercised with [Node.js 25.4.0's `DatabaseSync`](https://nodejs.org/download/release/v25.4.0/docs/api/sqlite.html); storage failures still stop authorization instead of falling back to memory.
