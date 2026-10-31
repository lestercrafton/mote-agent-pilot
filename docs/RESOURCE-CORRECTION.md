# v0.7.1-resource.1 storage correction

This is an experimental local/testnet candidate. Public Render hosting remains maintenance-only, without persistent signing keys or a live payment database. The public free Sites utility is unchanged.

## Failure and diagnosis

The previous actual Render full fixture used 1,000 orders, 4,000 retained proof attempts, 64,167-byte inputs and concurrency four. It passed functional checks, but reached the 512 MiB cgroup boundary and increased memory.events.max by 5,237. No OOM or OOM kill occurred. Parent process peak RSS was 128 MiB; all retained source, backup and restored files totaled 596,147,316 bytes (568.5 MiB). The original evidence does not separate filesystem cache from other process memory. A subsequent same-source diagnostic now confirms the composition: at a sampled 536,870,912-byte limit, file cache was 378,548,224 bytes (361.0 MiB), anonymous memory 139,296,768 bytes (132.8 MiB), and kernel memory 18,644,992 bytes (17.8 MiB). Parent V8 heapUsed was 25,072,064 bytes (23.9 MiB); the simultaneous backup process used about 102.5 MiB RSS. RSS sums include shared pages and are not additive cgroup totals. Peak sampled file cache later reached 405,409,792 bytes. See [unaltered diagnostic](resource-old-host-memory-diagnostic.json), SHA-256 `67e57f5bb311080e3dcc793bf3bc41562b2c4e9c99a0dbcc5290906f7629556f`. No live order state was initialized.

Completed orders serialized the document three times: input.document, result.canonicalJson, and response.result.canonicalJson. The correction removes this redundancy in the real storage writer; it does not merely shrink a synthetic fixture or depend on compressible input.

## Exact representation and compatibility

New writes use the explicit `mote-order-elision-v1` envelope. Original input, validation metadata, algorithm/dialect, quotes, signed commitments, payment identity, receipts and signatures remain stored. The duplicated canonicalJson and response.result positions are explicit null placeholders. Reading reconstructs those bytes deterministically and then runs the same complete semantic, checksum, index, deployment-identity and signed-commitment checks. Encoding validates the full row before removing bytes, so it cannot silently repair an inconsistent caller result. Encoded and expanded records both retain the original 524,288-byte bound.

Legacy full rows remain readable and are not rewritten on read. For unusual legacy result key ordering that cannot reproduce exact JSON serialization, the writer retains the full representation. Thus this is not an automatic database migration or a universal one-third storage promise. Existing expanded databases still need their own resource qualification. The current maintenance host has no live order state to migrate.

The old reader rejects the compact envelope. Rolling application code back after compact writes requires a reviewed compatible reader/recovery plan; never roll back, delete or replace payment state to make old code start. Current maintenance-only deployment can return to the prior source because no live order database is initialized.

## Measurement

The shared production encoder now seeds the resource harness. Admission stays at 1,000 orders / 4,000 attempts / 20 orders per payer; all prior latency, integrity, recovery and memory thresholds remain unchanged. The cgroup gate remains 448 MiB, with no increase allowed in memory.events.max/oom/oom_kill. Host size remains 512 MiB / 0.5 CPU / 1 GB; authorized base hosting remains $7.25/month under a $20/month budget, not a provider cap.

The harness records phase snapshots and sampled peaks for parent RSS, V8 heap, external allocations, Linux memory.stat anonymous/file/kernel/dirty/writeback bytes, numeric cgroup process RSS and maintenance child lifecycle. These are samples, not allocation attribution traces; process RSS sums can double-count shared pages. Kernel lifetime memory.peak remains the acceptance source and must come from a fresh deployment cgroup. Historical failed evidence is retained, never cleared to manufacture a pass.

The original repeated-string profile remains available. `--payload-profile entropy` supplies a deterministic 64,000-character SHA-256/base64url stream, preserving input size and workload without relying on easy compression. The implementation has no compression dependency. Neither profile represents every allowed JSON shape or proves real chain/network throughput.

## Verification status

Focused codec, maintenance, runtime and service checks passed 54/54 on pinned Node24.22.2, including local fixture EVM and process-kill recovery. A separate independent review ran all eight codec tests and verified that the old reader rejects new compact rows. Full pinned Node24.22.2 regression passed [410/410](resource-full-tests-v0.7.1.txt), a fresh production-only install passed [29/29](resource-production-tests-v0.7.1.txt) and [service smoke](resource-production-smoke-v0.7.1.json), and both [onboarding](resource-onboarding-v0.7.1.json) and [original](resource-original-demo-v0.7.1.txt) local EVM demos passed. The [full high-entropy local fixture](resource-entropy-local-v0.7.1.json) passed functional checks with 212,171,890 bytes retained, but macOS correctly cannot set constrained acceptance. Actual-host corrected results are pending deployment and will be retained separately. No production-readiness or capacity claim follows from a local smoke run.

Resource evidence excludes real RPC latency/finality, arbitrary schema complexity, all adversarial concurrency patterns and actual provisioned signer startup. Controlled synthetic trials are not organic adoption, unique-agent counts, satisfaction or evidence that a new token is necessary.
