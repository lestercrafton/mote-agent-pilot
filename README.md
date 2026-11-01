# Mote USDC v0.8.6 continuous-admission candidate

Local preparation only; deployed v0.8.5 and real payments remain disabled. No publication, deployment, credentials, wallet changes, provider calls or payments occurred for this candidate.

See [continuous admission](docs/CONTINUOUS-ADMISSION.md) for the changes, actual capacity limits, qualification and remaining approval gates. This supersedes historical production-cap proposals in the retained v0.8.5 documents. A proposed price is not accepted terms.

The fixed 100-attempt and 24-hour shutdown are removed. New authority is still bounded by explicit provider-dollar reservations, retained-state bytes, pending/rate/concurrency limits, disk/WAL health and verified backup freshness. This does not establish millions of transactions of capacity. Neither free-tier credit nor future revenue automatically increases spending authority.

Use Node24.22.2 with pinned root and legacy dependencies. `npm test` uses public synthetic fixture keys only. Local qualification and remaining exact Linux/runtime gaps are recorded in the report. Do not weaken custody guards for a test environment.

The existing persistent signer is reused only after a source-bound public grant validates; no signer replacement or custody record rewrite is supported. All original legacy files and strict payment verification remain unchanged. Startup does not create keys or initialize the paid journal. The existing receiving wallet and its recovery are outside service custody.
