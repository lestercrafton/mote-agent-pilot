# Linux qualification preparation

**Status: prepared, not executed.** No Docker, Podman or other local container engine was available in the inspected development environment. This candidate supplies a reproducible qualification procedure; it has not established a successful Linux install, Linux test result or 512 MiB runtime result. Darwin tests, a Darwin install with Linux platform metadata, and an amd64 image declaration are not Linux execution evidence.

The qualification base is the official `node:24.22.2-bookworm-slim` **Linux amd64** image pinned to `sha256:a43f7fc3e52e87d12a905f46eea0275def84ca8f2981a5b53fed44d7fb398ee0`, previously recorded in [base-image metadata](container-base-v0.5.json). The Dockerfile additionally requires actual Linux/x64 Node **24.22.2** and npm **11.19.1**. It fails on mismatch instead of installing another npm version or accepting a moving image tag.

## Running in an approved environment

Use an already-installed, authorized Docker engine with Linux amd64 execution support. Native amd64 execution is preferable; when emulation is used, record that fact and do not treat performance as equivalent to the intended host. Building needs access to the pinned official image and public npm packages. The script does not install an engine, arrange a remote runner, pass host credentials, publish images or deploy a service.

From this project, after that environment is available and approved:

```sh
bash scripts/qualify-linux.sh --output /absolute/new/qualification-directory
```

The output directory must not already exist. Without `--output`, a fresh temporary directory is created and printed. There is no automatic upload. The development and production builds use separate fresh stages with `--no-cache`; neither copies host `node_modules` or shares an installed dependency tree. Installs are exactly:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
```

No dependency installation uses `--force`, platform-error suppression or lifecycle scripts. A package/platform failure stops the qualification and leaves the build log. Repair and review the lockfile/source, then run a new qualification; do not interpret package omission or an ignored install error as success.

`Dockerfile.qualify.dockerignore` admits only package manifests, the qualification recipe, source/modules, Solidity contracts, committed JSON artifacts and required test fixtures. It excludes dependency trees, credentials, local databases, native helper binaries and prior logs. It does not change the separate production Dockerfile or production build context.

## Checks and retained evidence

After installation, every test/demo container runs as the image's unprivileged `node` user with `--network none`, no host mounts, no forwarded environment secrets, dropped capabilities and no new privileges. Loopback fixture HTTP/RPC remains available; external RPC, publishing and hosting are unavailable.

The development container runs `npm test`, `npm run demo:onboarding` and the original `npm run demo`. The onboarding demo executes the eight local EVM transactions and recovery path using public, worthless fixture accounts. It is not public Sepolia settlement or current-fork gas qualification. The full development suite has no 512 MiB memory ceiling; compiler/EVM test tooling is not the production service workload.

The independently installed production container checks that Ganache, solc and the MCP client development package are absent; imports the service/chain/client/dispenser/custody interfaces and production entrypoint without activating it; runs the focused Ethereum fee, HTTP and runtime tests; and runs the synthetic service resource **smoke** profile. That smoke exercises loopback HTTP, durable rows, backup, quarantine and recovery without a real signer or public chain. It does not invoke approved-secret production startup. The qualification image includes test files and is not the production deployment image.

Evidence includes the base digest, Docker/engine platform metadata, both immutable resulting image IDs and inspections, raw install/test/demo logs, top-level dependency inventories, source-file SHA-256 manifests before/after execution, onboarding JSON, production imports and service-smoke JSON, container settings and exit/OOM states. Source manifests must match before/after; production inputs must also match their development-image counterparts, rejecting drift between builds. An empty or missing report, nonzero exit, unfinished container, OOM or interrupted script never counts as success. A failure retains its task-created container and ID for inspection; successful containers are removed only after evidence is copied. Images are retained locally and never pushed. Remove retained failed containers only after reconciling their state and preserving evidence.

`status.txt` reports completion only after every requested stage passes. Individual reports are still necessary to interpret what was tested; this status does not attest native Keychain operation, external network trust, public deployment or hosted availability.

## Separate constrained runtime gate

To additionally request the existing full synthetic resource check in a **new production-only container**:

```sh
bash scripts/qualify-linux.sh --resource --output /absolute/new/qualification-with-resources
```

Only this extra container receives `--memory 512m --memory-swap 512m --cpus 0.5`. The checker independently requires cgroup-v2 evidence for 512 MiB memory, zero swap, 0.5 CPU, Linux/x64 Node 24.22.2 and absent development packages. Unsupported or missing cgroups block acceptance. Raw resource JSON, logs and container OOM/exit state are retained. See [resource thresholds and limitations](RESOURCE-VERIFICATION.md).

The resource workload uses synthetic settlement proofs and an ephemeral container filesystem. It measures its own data/snapshot/restore footprint; it does not enforce or qualify a real 1 GB persistent hosting disk, validate remote signer startup, include public RPC latency or demonstrate availability on Render. Passing this gate would qualify only the recorded constrained fixture and exact image. Actual host startup, storage, custody and deployment remain separate gates.

## Preparation validation

Shell syntax and the script's help path can be checked without a container:

```sh
bash -n scripts/qualify-linux.sh
bash scripts/qualify-linux.sh --help
```

These checks do not execute npm installation, build an image or run any Linux tests. The missing container engine remains the concrete qualification blocker until an authorized execution environment is supplied.
