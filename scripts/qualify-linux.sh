#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Preparation artifact. This script never installs a container engine, publishes
# an image, reads custody, passes host secrets or connects tests to public RPC.
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
BASE='node:24.22.2-bookworm-slim@sha256:a43f7fc3e52e87d12a905f46eea0275def84ca8f2981a5b53fed44d7fb398ee0'

assert_runtime() {
  node -e 'if(process.platform!=="linux"||process.arch!=="x64"||process.version!=="v24.22.2")throw Error("Requires pinned Linux x64 Node24.22.2")'
  test "$(npm --version)" = '11.19.1'
  test "$ROOT" = /app
  test -d /evidence
}

source_manifest() {
  (
    cd "$ROOT"
    find src scripts artifacts test -type f -print
    if test -d contracts; then find contracts -type f -print; fi
    printf '%s\n' package.json package-lock.json Dockerfile.qualify Dockerfile.qualify.dockerignore
  ) | LC_ALL=C sort | while IFS= read -r file; do sha256sum "$ROOT/$file"; done
}

case "${1:-}" in
  --inside-development)
    test "$#" = 1
    assert_runtime
    cd "$ROOT"
    source_manifest > /evidence/source-before.sha256
    npm ls --depth=0 --json > /evidence/development-dependencies.json
    npm test > /evidence/full-tests.log 2>&1
    npm run demo:onboarding -- --evidence /evidence/onboarding.json > /evidence/onboarding.log 2>&1
    npm run demo > /evidence/original-demo.log 2>&1
    source_manifest > /evidence/source-after.sha256
    cmp /evidence/source-before.sha256 /evidence/source-after.sha256
    printf '%s\n' 'Development suite and both local demos passed; source unchanged.'
    exit 0
    ;;
  --inside-production)
    test "$#" = 1
    assert_runtime
    cd "$ROOT"
    source_manifest > /evidence/source-before.sha256
    npm ls --omit=dev --depth=0 --json > /evidence/production-dependencies.json
    node --input-type=module > /evidence/production-imports.json <<'NODE'
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
const omitted = ['ganache', 'solc', '@modelcontextprotocol/client'];
for (const name of omitted) assert.equal(existsSync(`node_modules/${name}`), false, `${name} leaked into production install`);
const modules = ['testnet-networks','testnet-rpc','testnet-chain','testnet-signer','testnet-service','testnet-store',
  'testnet-http','testnet-client','testnet-journal','ethereum-fees','base-fees','dispenser-chain','dispenser-discovery',
  'claim-client','claim-journal','keychain-custody'];
for (const name of modules) await import(`./src/${name}.mjs`);
await import('./scripts/testnet-server.mjs');
console.log(JSON.stringify({node:process.version,platform:process.platform,architecture:process.arch,modules,
  productionEntrypointImport:true,omittedDevelopmentPackages:omitted,nativeCustodyActivated:false,publicNetwork:false},null,2));
NODE
    node --test --test-concurrency=1 test/ethereum-fees.test.mjs test/testnet-http.test.mjs test/testnet-runtime.test.mjs > /evidence/production-tests.log 2>&1
    node scripts/resource-check.mjs --profile smoke --chain 11155111 --data-root /var/data --evidence /evidence/service-smoke.json > /evidence/service-smoke.log 2>&1
    source_manifest > /evidence/source-after.sha256
    cmp /evidence/source-before.sha256 /evidence/source-after.sha256
    printf '%s\n' 'Fresh production-only import, HTTP/runtime and synthetic service smoke checks passed.'
    exit 0
    ;;
  --inside-resource)
    test "$#" = 1
    assert_runtime
    cd "$ROOT"
    node scripts/resource-check.mjs --profile full --chain 11155111 --require-container --data-root /var/data --evidence /evidence/resource.json > /evidence/resource.log 2>&1
    printf '%s\n' 'Separate constrained synthetic service check passed; inspect its evidence and container state.'
    exit 0
    ;;
esac

usage() {
  cat <<'TEXT'
Usage: bash scripts/qualify-linux.sh [--output NEW_DIRECTORY] [--resource]

Build fresh pinned Linux amd64 development and production-only qualification
images using an already-authorized Docker engine. Installs may use the network;
every test/demo container runs with --network none and no host secret mounts.
--resource adds a separate 512MiB/no-swap/0.5CPU synthetic runtime gate.
No image is pushed or deployed. Missing engine/unsupported cgroups fail closed.
TEXT
}
OUTPUT=''
RESOURCE=false
while test "$#" -gt 0; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --output) test "$#" -ge 2 && test -z "$OUTPUT" || { usage >&2; exit 2; }; OUTPUT=$2; shift 2 ;;
    --resource) test "$RESOURCE" = false || exit 2; RESOURCE=true; shift ;;
    *) usage >&2; exit 2 ;;
  esac
done
command -v docker >/dev/null 2>&1 || { printf '%s\n' 'Blocked: an already-installed, authorized Docker engine is required. No container qualification ran.' >&2; exit 2; }
docker version --format '{{.Server.Version}}' >/dev/null
if test -z "$OUTPUT"; then OUTPUT=$(mktemp -d "${TMPDIR:-/tmp}/mote-linux-qualification.XXXXXX");
else mkdir -- "$OUTPUT"; fi
OUTPUT=$(cd -- "$OUTPUT" && pwd -P)
printf 'Evidence directory: %s\n' "$OUTPUT"
printf '%s\n' "$BASE" > "$OUTPUT/base-image.txt"
docker version > "$OUTPUT/docker-version.txt"
docker info --format 'os={{.OSType}} architecture={{.Architecture}} cgroupVersion={{.CgroupVersion}}' > "$OUTPUT/engine-platform.txt"
printf '%s\n' 'State: running; no success is implied until all requested checks pass.' > "$OUTPUT/status.txt"
trap 'code=$?; if test "$code" -ne 0; then printf "State: failed-or-interrupted (exit %s). Retain logs and container IDs; missing evidence is not success.\n" "$code" > "$OUTPUT/status.txt"; fi' EXIT

build() {
  local target=$1
  docker build --platform linux/amd64 --no-cache --target "$target" \
    --file "$ROOT/Dockerfile.qualify" --iidfile "$OUTPUT/$target-image-id.txt" \
    "$ROOT" > "$OUTPUT/$target-build.log" 2>&1
  docker image inspect "$(cat "$OUTPUT/$target-image-id.txt")" > "$OUTPUT/$target-image-inspect.json"
}

run_check() {
  local image=$1 label=$2 mode=$3
  shift 3
  local cid rc=0 state
  cid=$(docker create --platform linux/amd64 --network none --cap-drop ALL \
    --security-opt no-new-privileges --pids-limit 256 "$@" "$image" \
    bash scripts/qualify-linux.sh "$mode")
  printf '%s\n' "$cid" > "$OUTPUT/$label-container-id.txt"
  docker inspect --format '{{json .HostConfig}}' "$cid" > "$OUTPUT/$label-host-config.json"
  test "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$cid")" = none
  docker start --attach "$cid" > "$OUTPUT/$label-container.log" 2>&1 || rc=$?
  docker inspect --format '{{json .State}}' "$cid" > "$OUTPUT/$label-state.json"
  mkdir "$OUTPUT/$label"
  docker cp "$cid:/evidence/." "$OUTPUT/$label/" || rc=1
  state=$(docker inspect --format '{{.State.Running}} {{.State.OOMKilled}} {{.State.ExitCode}}' "$cid")
  if test "$rc" -ne 0 || test "$state" != 'false false 0'; then
    printf 'Failed or uncertain %s; retained container %s and evidence at %s.\n' "$label" "$cid" "$OUTPUT" >&2
    return 1
  fi
  # Remove only this completed, task-created container after retaining evidence.
  docker rm "$cid" >/dev/null
}

build development
run_check "$(cat "$OUTPUT/development-image-id.txt")" development --inside-development
build production
run_check "$(cat "$OUTPUT/production-image-id.txt")" production --inside-production
# Reject source/lock drift between the two independent builds. Production has
# a strict subset of the development inputs, with the same absolute /app paths.
while IFS= read -r entry; do
  grep -F -x -- "$entry" "$OUTPUT/development/source-before.sha256" >/dev/null
done < "$OUTPUT/production/source-before.sha256"
if test "$RESOURCE" = true; then
  run_check "$(cat "$OUTPUT/production-image-id.txt")" resource --inside-resource \
    --memory 512m --memory-swap 512m --cpus 0.5
fi
printf 'State: passed requested Linux container checks. Resource gate requested: %s. No public deployment, public transaction or native custody qualification.\n' "$RESOURCE" > "$OUTPUT/status.txt"
printf 'Completed requested checks. Review evidence: %s\n' "$OUTPUT"
