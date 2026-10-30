# Production resource verification

The proposed runtime is Node 24.22.2 on one Linux amd64 instance with 512 MiB RAM, 0.5 CPU and a 1 GB persistent disk. This is a **verification target**, not a measured hosting claim. The available development machine is macOS arm64. Read-only inspection found no Docker, Podman, Colima or nerdctl executable and no Docker.app; no engine was installed, started or granted permissions. A Linux/container qualification therefore remains pending.

`scripts/resource-check.mjs` provides an offline, bounded rehearsal. It imports production modules only and creates a unique temporary directory containing public synthetic fixtures. It accepts only the fixed supported network IDs, uses a well-known public development signing fixture in memory, and never calls a public RPC or submits a transaction. Its loopback HTTP server has no external target option. Fixtures and listeners are removed when it finishes; only an explicitly requested new evidence file is retained.

The saved [full local evidence](resource-verification-local-v0.5.json) passed on Node 24.22.2/macOS arm64: 1,000 orders, 4,000 attempts, about 292 MiB parent peak RSS, 569 MiB retained files, 0.68-second startup, 3.14-second backup and 4.69-second restore. Source hashes were unchanged during that run. These numbers exclude the maintenance child's RSS and are **not** combined 512 MiB container measurements. [Base compatibility smoke](resource-smoke-base-v0.5.json) also passed; the [container gate](resource-container-gate-v0.5.json) correctly refused qualification in this environment. The [status record](resource-verification-status-v0.5.json) keeps those distinctions explicit.

A separate clean production installation passed [29 focused tests](sepolia-production-tests-v0.5.txt) and the [three-row production smoke](resource-smoke-production-v0.5.json) on Node 24.22.2/macOS arm64 with no development packages present. This is dependency and functional evidence, not constrained-host qualification. The Dockerfile pins the official Linux amd64 Node image digest recorded in [container-base-v0.5.json](container-base-v0.5.json); the image has not been built, published or qualified here.

## What the harness tests

The full profile fills the compiled admission bounds: 1,000 semantically valid stored orders, 4,000 retained proof attempts, 20 orders per synthetic payer, and 64,167-byte inputs. Each order has a signed offer and signed synthetic receipt; the supplied proof adapter is a mock, not settlement. Row generation is followed by the real store's full startup validation. It then measures 120 loopback requests at concurrency four, mixing readiness, near-byte-limit free audits and exact receipt recovery, and confirms a new quote is rejected at capacity.

The online SQLite backup runs in a **separate Node process** while the service remains open in WAL mode. Readiness latency is measured during that process. Restore likewise runs as a separate process, creates new quarantined files and a fresh lock, and is followed by recovery-only startup. Normal startup of the restored file must fail, receipt recovery must match exactly and new quotes must remain forbidden. This avoids treating an in-process backup's memory as equivalent to a second production process.

The evidence distinguishes parent-process peak RSS from container-wide `memory.peak`, which includes the maintenance child and kernel-accounted memory. It records observed cgroup-v2 limits, memory events, CPU throttling counters, phase timings, nearest-rank latency quantiles, disk use and source/lockfile hashes. It never infers a memory limit from the machine's total RAM or a small RSS sample.

The smoke profile uses three rows and verifies the harness functions. Neither smoke nor an unconstrained full run can set `acceptancePassed:true`. Existing v0.4 benchmark evidence is a different source snapshot and must not be presented as v0.5 production qualification.

## Reproducible constrained run

Use the reviewed production Dockerfile and locked dependencies. The image must use Node **24.22.2**, target `linux/amd64`, and install with `npm ci --omit=dev --ignore-scripts`. Keep `ganache`, `solc` and the development MCP client out of the image. Include the resource-check and maintenance scripts so the same production dependency installation can be tested. Record the base image digest and resulting image ID; do not substitute a moving `latest` tag in release evidence. Render requires Linux amd64 for prebuilt images. [Render image requirements](https://render.com/docs/deploying-an-image).

On an already approved Docker-capable environment, build without publishing:

```sh
docker build --platform linux/amd64 -t mote-resource-check:v0.5 .
```

Create fresh disposable data/evidence directories outside the source tree, then run with no external network and both memory and CPU limits. These commands are a plan; they were not executed on the current machine:

```sh
MOTE_RESOURCE_ROOT=$(mktemp -d)
mkdir "$MOTE_RESOURCE_ROOT/data" "$MOTE_RESOURCE_ROOT/evidence"
docker create --name mote-resource-v05 \
  --platform linux/amd64 --memory=512m --memory-swap=512m --cpus=0.5 \
  --network=none --pids-limit=128 --read-only \
  --user "$(id -u):$(id -g)" \
  --tmpfs /tmp:rw,nosuid,noexec,size=32m \
  --mount "type=bind,src=$MOTE_RESOURCE_ROOT/data,dst=/var/data" \
  --mount "type=bind,src=$MOTE_RESOURCE_ROOT/evidence,dst=/evidence" \
  mote-resource-check:v0.5 \
  node scripts/resource-check.mjs --profile full --chain 11155111 \
    --require-container --data-root /var/data \
    --evidence /evidence/resource.json
docker start -a mote-resource-v05 > "$MOTE_RESOURCE_ROOT/evidence/output.txt" 2>&1
docker inspect --format '{{json .State}}' mote-resource-v05 \
  > "$MOTE_RESOURCE_ROOT/evidence/container-state.json"
docker inspect --format '{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.NanoCpus}} {{.Image}}' mote-resource-v05 \
  > "$MOTE_RESOURCE_ROOT/evidence/container-limits.txt"
```

Do not discard the container before collecting its exit/OOM state. An OOM kill may prevent the script from writing JSON; an absent report is failure/unknown, never success. After preserving evidence, remove only this task-owned disposable container and directories. Repeat in a fresh container for Base Sepolia (`--chain 84532`) to check shared storage behavior without lifting Base's payer refusal. Record whether amd64 execution is native or emulated; emulation is not an equivalence claim about Render hardware.

`--require-container` fails before creating fixtures unless it directly observes Node 24.22.2, Linux x64, cgroup-v2 memory maximum 536,870,912 bytes, swap maximum zero, CPU quota 0.5 and no known development packages. Missing cgroup files or a different limit blocks qualification. A new engine, image pull, package install, external build runner or added permission requires its own authorized environment; this script does not provision one.

## Acceptance thresholds and gaps

These are engineering gates chosen for headroom, not vendor guarantees:

| Check | Required result |
| --- | --- |
| Full fixture correctness | All startup, capacity, backup, quarantine and exact recovery checks pass |
| Container outcome | Exit 0, no OOM kill, no increase in `memory.events` `oom`, `oom_kill` or `max` |
| Container memory peak | At most 448 MiB, including the maintenance child and page cache |
| Parent process peak RSS | At most 384 MiB; cannot substitute for container memory |
| Retained data + snapshot + restored copy | At most 850 MiB, leaving over 100 MiB even if 1 GB means 1,000,000,000 bytes; verify actual mount capacity |
| Normal/recovery startup | At most 30 seconds each for the full fixture |
| Backup / restore | At most 60 / 90 seconds |
| `/ready` p95 | At most 250 ms, both under mixed load and during backup |
| Free audit / receipt recovery p95 | At most 1 / 2 seconds with the zero-latency synthetic proof adapter |

The bound is not a proof for every supported JSON shape. Before public admission, separately exercise maximum node/depth/array inputs, schema-heavy failures, maximum concurrency, unavailable/slow RPC, disk exhaustion and restart during real maintenance on the same constrained runtime. The Docker bind mount above does not impose a 1 GB disk quota; the harness records final retained file sizes, not a maximum filesystem-use trace. Check actual filesystem free space and transient WAL/staging headroom on the approved host. A 1 GB disk is finite; quote/attempt counts do not prove every possible stored record and repeated backup fits. No automatic disk expansion, old-record deletion or paid upgrade is permitted as a response to a failed gate.

The harness shares its parent process between service and load driver, which adds client work to its measurements. It does not execute the externally provisioned production key/config startup, establish real RPC latency or model public traffic. After source access, host and key gates are independently resolved, the exact production entrypoint needs a separate startup/readiness/free-audit check on the actual instance. Do not send a public payment to measure memory. Retain the source commit, lockfile/image digest, observed limits, raw evidence and failures.

On threshold failure, keep new paid admission disabled. Return to the prior verified code only if its stored schema and network identity remain compatible; do not roll back the database or clear quarantine. Keep the free utility separate. Reproduce locally, reduce work or tighten reviewed admission limits, rerun tests and repeat the constrained rehearsal. A larger host or additional resource requires a separate decision; changing a budget value does not create a platform hard cap.
