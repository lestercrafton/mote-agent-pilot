# Local capacity measurement, not a hosting guarantee

This historical **v0.4 Base fixture benchmark** ran **208 loopback HTTP requests** on Node24.22.2: 48 quote/result/receipt-recovery workflows with explicitly mocked finalized proofs, 60 free audits, three warmups and one manifest. No public API, RPC, transaction or credential was used. The existing real-EVM rehearsal is separate. This benchmark is not chain settlement and has no real finality wait.

| Synthetic workload | Quote bytes | Result bytes | GET receipt recovery bytes | Total outbound JSON bodies |
| --- | ---: | ---: | ---: | ---: |
| Small valid | 1,367 | 1,793 | 1,793 | 4,953 |
| Small invalid | 1,367 | 1,922 | 1,922 | 5,211 |
| Near 64KiB body limit | 1,371 | 65,742 | 65,742 | 132,855 |

Discovery adds 3,723 bytes. For an assumed decimal **5 GB** outbound allowance and one cached manifest, response-body arithmetic gives about **1,009,488 small-valid**, **959,508 small-invalid**, or **37,634 near-limit** workflows. Fetching the manifest for every job reduces these to 576,302 / 559,659 / 36,609. This excludes HTTP/TLS framing, retransmission, provider metering/compression, RPC traffic, downloads and every other shared use. It is not a monthly capacity or cost promise. Check the current [Render pricing](https://render.com/pricing) and dashboard allowance before deployment.

The current pilot deliberately stops new admissions after **1,000 cumulative quotes per database**, **20 per payer** and **4,000 proof attempts**, including unsuccessful quotes. It has no automatic retention/reset that creates fresh spending or sales authority. These limits dominate the hypothetical bandwidth ceiling; Base also retains its public fee-cap refusal. The selected v0.5 Ethereum path has a distinct signed type-2 fee policy, not a universal payment refusal. Existing receipts remain recoverable. A monthly hosting budget pays infrastructure; it does not buy an unlimited amount of blockchain gas.

The local mixed-workload process achieved 47.8 mock-proof workflows/second at concurrency1 (p50 20.5ms, p95 28.3ms), and 53.5/second at concurrency4 (p50 72.5ms, p95 85.6ms). Sampled peak RSS was 173.0MiB including the same-process load generator. Samples are small and finite; Node/OS caching affects the results. The Apple M3 Max with unrestricted memory is not a 0.5CPU/512MB Render instance. This historical benchmark did not test constrained-host capacity or worst-case schema/depth/startup/full-database memory. The later v0.5 full 1,000-row local rehearsal is recorded in [RESOURCE-VERIFICATION.md](RESOURCE-VERIFICATION.md); constrained Linux/512 MiB qualification remains pending.

Actual proof verification performs multiple historical/public RPC reads and waits for finalized chain evidence. Therefore neither local jobs/second nor body-budget arithmetic should be multiplied into a promised live monthly transaction count. Use this measurement to size an initial bounded pilot, then measure the actual approved host before increasing limits or spending. No outside usage or adoption was measured.

The benchmark command is `node scripts/benchmark-testnet.mjs`. It has no target override, permits only modest concurrency and removes its temporary synthetic database. The recorded environment, latency distributions, byte counts, method and source hashes are in `testnet-benchmark-evidence.json`. Running the current source may produce different values; those recorded hashes identify the historical snapshot.
