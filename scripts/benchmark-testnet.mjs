import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { HDNodeWallet, id } from 'ethers';
import { createTestnetService } from '../src/testnet-service.mjs';
import { initializeTestnetStore, TESTNET_STORE_LIMITS } from '../src/testnet-store.mjs';
import { startTestnetHttp } from '../src/testnet-http.mjs';
import { LIMITS } from '../src/json.mjs';

// LOCAL BENCHMARK ONLY. This well-known public development fixture is not a
// generated credential. It remains in memory. No transaction signer/provider,
// public API, RPC endpoint, account, hosted service or actual settlement is used.
const PUBLIC_FIXTURE = 'test test test test test test test test test test test junk';
const ORIGIN = 'https://benchmark.example.invalid';
const NOW = 2_000_000_000;
const WORKLOADS = [
  { name: 'small-valid', expectedValid: true, input: { document: { task: 'summarize', count: 3, labels: ['public', 'synthetic'] }, schema: { type: 'object', required: ['task', 'count'], properties: { task: { type: 'string' }, count: { type: 'integer', minimum: 0 }, labels: { type: 'array', items: { type: 'string' } } }, additionalProperties: false } } },
  { name: 'small-invalid', expectedValid: false, input: { document: { task: 'summarize', count: 'three' }, schema: { type: 'object', required: ['task', 'count'], properties: { task: { type: 'string' }, count: { type: 'integer', minimum: 0 } }, additionalProperties: false } } },
  { name: 'near-byte-limit', expectedValid: true, input: { document: { payload: 'a'.repeat(64000) }, schema: { type: 'object', required: ['payload'], properties: { payload: { type: 'string', maxLength: 64000 } }, additionalProperties: false } } },
];
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const rounded = value => Math.round(value * 1000) / 1000;
const assert = (condition, message) => { if (!condition) throw new Error(`Benchmark validation failed: ${message}`); };
function stats(values) {
  assert(values.length > 0, 'empty sample');
  const sorted = [...values].sort((a,b) => a-b);
  return { samples: values.length, min: rounded(sorted[0]), mean: rounded(values.reduce((a,b) => a+b,0) / values.length), p50: rounded(sorted[Math.ceil(sorted.length * 0.5) - 1]), p95: rounded(sorted[Math.ceil(sorted.length * 0.95) - 1]), max: rounded(sorted.at(-1)) };
}
async function pool(items, concurrency, operation) {
  const output = new Array(items.length); let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) { const index = cursor++; output[index] = await operation(items[index], index); }
  }));
  return output;
}
function groupRows(rows, name) {
  const selected = name ? rows.filter(row => row.workload === name) : rows;
  const metric = key => stats(selected.map(row => row[key]));
  return { jobs: selected.length, jobLatencyMs: metric('latencyMs'), requestBodyBytes: metric('requestBytes'), responseBodyBytes: metric('responseBytes'),
    quoteResponseBytes: metric('quoteResponseBytes'), resultResponseBytes: metric('resultResponseBytes'), recoveryResponseBytes: metric('recoveryResponseBytes'),
    quoteLatencyMs: metric('quoteMs'), resultLatencyMs: metric('resultMs'), recoveryLatencyMs: metric('recoveryMs') };
}

/** Bounded loopback HTTP measurement. Options cannot select an external target.
 * The HTTP service and load driver share this one unrestricted local process. */
export async function runTestnetBenchmark({ jobsPerConcurrency = 24, freeJobsPerWorkload = 10, concurrencies = [1,4] } = {}) {
  assert(Number.isInteger(jobsPerConcurrency) && jobsPerConcurrency >= 3 && jobsPerConcurrency <= 36 && jobsPerConcurrency % 3 === 0, 'jobsPerConcurrency must be 3–36 and divisible by three');
  assert(Number.isInteger(freeJobsPerWorkload) && freeJobsPerWorkload >= 1 && freeJobsPerWorkload <= 10, 'freeJobsPerWorkload must be 1–10');
  assert(Array.isArray(concurrencies) && concurrencies.length >= 1 && concurrencies.length <= 2 && new Set(concurrencies).size === concurrencies.length && concurrencies.every(value => value === 1 || value === 4), 'only bounded concurrency 1 and/or 4 is permitted');
  const startedAt = new Date().toISOString();
  const quoteSigner = HDNodeWallet.fromPhrase(PUBLIC_FIXTURE, undefined, "m/44'/60'/0'/0/3");
  const identity = { origin: ORIGIN, chainId: 84532, genesisHash: null, token: `0x${'11'.repeat(20)}`, router: `0x${'22'.repeat(20)}`, recipient: `0x${'33'.repeat(20)}`, quoteSigner: quoteSigner.address.toLowerCase(), checkpoint: { blockNumber: '1', blockHash: id('benchmark-checkpoint') }, configHash: id('benchmark-mock-config-not-a-deployment') };
  const proofs = new Map(); let proofChecks = 0; let identityChecks = 0;
  const adapter = {
    identity,
    async verifyIdentity() { identityChecks++; return structuredClone(identity); },
    async verifyPayment({ offer, transactionHash, finalizedAnchor }) {
      proofChecks++;
      const proof = proofs.get(transactionHash);
      assert(proof && proof.quoteId === offer.quote.quoteId, 'controlled proof must match original quote');
      if (finalizedAnchor) assert(JSON.stringify(finalizedAnchor) === JSON.stringify(proof.finalized), 'saved mock anchor changed');
      return structuredClone(proof);
    },
  };
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'mote-benchmark-')));
  const database = join(directory, 'orders.sqlite');
  let service; let http; let timer;
  let sampledPeakRssBytes = process.memoryUsage().rss; const baselineRssBytes = sampledPeakRssBytes;
  const sampleRss = () => { sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss); };
  let localHttpRequests = 0;
  try {
    initializeTestnetStore({ path: database, identity });
    service = await createTestnetService({ adapter, quoteSigner, database, now: () => NOW });
    http = await startTestnetHttp({ service, host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${http.address.port}`;
    timer = setInterval(sampleRss, 2);
    const request = async (path, value, key) => {
      assert(path.startsWith('/') && !path.startsWith('//'), 'only relative loopback paths permitted');
      const serialized = value === undefined ? undefined : JSON.stringify(value);
      const begin = performance.now(); localHttpRequests++;
      const response = await fetch(base + path, { method: serialized === undefined ? 'GET' : 'POST', redirect: 'error', headers: { ...(serialized === undefined ? {} : { 'content-type': 'application/json' }), ...(key ? { 'idempotency-key': key } : {}) }, ...(serialized === undefined ? {} : { body: serialized }) });
      const buffer = Buffer.from(await response.arrayBuffer());
      const latencyMs = performance.now() - begin; sampleRss();
      const body = JSON.parse(buffer.toString('utf8'));
      assert(response.status === 200, `HTTP ${response.status} ${body.error?.code ?? ''}`);
      return { body, requestBytes: serialized === undefined ? 0 : Buffer.byteLength(serialized), responseBytes: buffer.length, latencyMs };
    };
    const discovery = await request('/.well-known/mote.json');
    assert(discovery.body.launchStatus === 'unlaunched-candidate', 'manifest must not claim deployment');
    // Three free requests warm parser/validator/HTTP paths. Paid signing/SQLite
    // operations are not warmed; all first paid calls remain in the samples.
    for (const workload of WORKLOADS) { const warm = await request('/v1/audit', workload.input); assert(warm.body.result.valid === workload.expectedValid, 'warm-up result validity'); }
    const paidRounds = []; const freeRounds = [];
    let sequence = 0;
    for (const concurrency of concurrencies) {
      const roundBegin = performance.now(); const roundRss = process.memoryUsage().rss;
      const rows = await pool(Array.from({ length: jobsPerConcurrency }, (_, index) => WORKLOADS[index % WORKLOADS.length]), concurrency, async workload => {
        const job = sequence++; const jobBegin = performance.now();
        const payer = `0x${id(`public-benchmark-payer-${job}`).slice(-40)}`;
        const quote = await request('/v1/quotes', { payer, input: workload.input, publicSynthetic: true }, `benchmark-quote-${job}`);
        const offer = quote.body; const tx = id(`mock-proof-only-${job}`);
        proofs.set(tx, { transactionHash: tx, blockNumber: '10', blockHash: id('mock-payment-block'), transactionIndex: '0', logIndex: '1', blockTimestamp: String(NOW), transactionNonce: '1', payer: offer.quote.payer, amount: offer.quote.amount, quoteId: offer.quote.quoteId, requestHash: offer.quote.requestHash, token: identity.token, router: identity.router, recipient: identity.recipient, configHash: identity.configHash, finalized: { blockNumber: '11', blockHash: id('mock-finalized-anchor') } });
        const result = await request('/v1/orders', { quoteId: offer.quote.quoteId, transactionHash: tx, publicSynthetic: true }, `benchmark-result-${job}`);
        const recovery = await request(`/v1/orders/${offer.quote.quoteId}`);
        assert(result.body.result.valid === workload.expectedValid, 'result validity');
        assert(JSON.stringify(result.body) === JSON.stringify(recovery.body), 'GET recovery must return the exact signed response');
        assert(result.body.receipt.testOnly === true && result.body.receipt.publicSynthetic === true, 'receipt must retain pilot declarations');
        return { workload: workload.name, latencyMs: performance.now() - jobBegin, requestBytes: quote.requestBytes + result.requestBytes,
          responseBytes: quote.responseBytes + result.responseBytes + recovery.responseBytes,
          quoteResponseBytes: quote.responseBytes, resultResponseBytes: result.responseBytes, recoveryResponseBytes: recovery.responseBytes,
          quoteMs: quote.latencyMs, resultMs: result.latencyMs, recoveryMs: recovery.latencyMs };
      });
      const durationMs = performance.now() - roundBegin;
      paidRounds.push({ concurrency, durationMs: rounded(durationMs), jobsPerSecond: rounded(rows.length * 1000 / durationMs), requestsPerJob: 3, baselineRssBytes: roundRss, endRssBytes: process.memoryUsage().rss, overall: groupRows(rows), workloads: Object.fromEntries(WORKLOADS.map(workload => [workload.name, groupRows(rows, workload.name)])) });
      for (const workload of WORKLOADS) {
        const begin = performance.now();
        const samples = await pool(Array.from({ length: freeJobsPerWorkload }), concurrency, async () => {
          const response = await request('/v1/audit', workload.input);
          assert(response.body.result.valid === workload.expectedValid && response.body.receipt.settlement === 'none', 'free result never claims settlement');
          return response;
        });
        const duration = performance.now() - begin;
        freeRounds.push({ concurrency, workload: workload.name, requests: samples.length, durationMs: rounded(duration), requestsPerSecond: rounded(samples.length * 1000 / duration), latencyMs: stats(samples.map(item => item.latencyMs)), requestBodyBytes: stats(samples.map(item => item.requestBytes)), responseBodyBytes: stats(samples.map(item => item.responseBytes)) });
      }
    }
    sampleRss();
    const responseBodyBudget = 5_000_000_000;
    const bodyOnlyEstimates = Object.fromEntries(WORKLOADS.map(workload => {
      // Use the larger observed response length across concurrency rounds.
      const responseBytes = Math.max(...paidRounds.map(round => round.workloads[workload.name].responseBodyBytes.max));
      return [workload.name, { responseBodyBytesPerQuoteResultAndGetRecovery: responseBytes,
        jobsWithOneCachedManifestForEntireBudget: Math.floor((responseBodyBudget - discovery.responseBytes) / responseBytes),
        jobsIfManifestFetchedForEveryJob: Math.floor(responseBodyBudget / (responseBytes + discovery.responseBytes)) }];
    }));
    const sourceHashes = Object.fromEntries(['scripts/benchmark-testnet.mjs', 'src/testnet-service.mjs', 'src/testnet-store.mjs', 'src/testnet-http.mjs', 'src/public.mjs', 'src/json.mjs'].map(name => [name, createHash('sha256').update(readFileSync(new URL(`../${name}`, import.meta.url))).digest('hex')]));
    return {
      evidenceVersion: 'mote-local-capacity-measurement-v1', startedAt, finishedAt: new Date().toISOString(), localOnly: true,
      environment: { node: process.version, sqlite: process.versions.sqlite ?? null, v8: process.versions.v8, os: platform(), osRelease: release(), architecture: arch(), logicalCpus: cpus().length, cpuModel: cpus()[0]?.model ?? 'unknown', systemMemoryBytes: totalmem(), processMemoryLimitEnforced: false, render512MiBHostTested: false, serverAndLoadDriverShareProcess: true },
      method: { transport: 'loopback HTTP, no TLS', chainProofs: 'controlled synthetic adapter responses; no chain settlement', keys: 'well-known public development fixture, memory only', paidWork: 'quote + controlled proof/result + exact GET receipt recovery', freeWork: 'bounded JSON validation/canonicalization', quantiles: 'nearest rank', warmup: 'one free request per workload; no paid-path warmup', jobsPerConcurrency, freeJobsPerWorkload, concurrencies, externalApiRequests: 0, publicRpcCalls: 0, transactionsSubmitted: 0, localHttpRequests, mockProofChecks: proofChecks, mockIdentityChecks: identityChecks },
      workloads: WORKLOADS.map(workload => ({ name: workload.name, expectedValid: workload.expectedValid, inputJsonBytes: bytes(workload.input), inputFractionOfHttpBodyCap: rounded(bytes(workload.input) / LIMITS.bodyBytes), description: workload.name === 'near-byte-limit' ? '64,000 ASCII characters and a small supported schema; near byte cap, not worst-case schema/depth complexity' : 'small synthetic tool-call document and supported schema' })),
      discovery: { responseBodyBytes: discovery.responseBytes, requestBodyBytes: 0, countedRequests: 1 },
      paidPathWithMockProofs: paidRounds, freeAudit: freeRounds,
      memory: { baselineRssBytes, sampledPeakRssBytes, processLifetimeMaxRssBytes: process.resourceUsage().maxRSS * 1024, sampleIntervalMs: 2, caveat: 'Samples can miss brief peaks; lifetime max includes module startup. RSS includes this load driver and is not a Render measurement.' },
      fiveDecimalGbResponseBodyOnly: { bytes: responseBodyBudget, estimates: bodyOnlyEstimates, excluded: ['HTTP request/response headers', 'TLS/TCP framing and retransmissions', 'provider metering/compression rules', 'RPC/provider traffic and rate limits', 'blockchain inclusion/finality wait', 'client transaction fees', 'other endpoints and downloads'], interpretation: 'Arithmetic response-body ceilings only, not actual monthly jobs, guaranteed throughput, a hosting quote or a spending cap.' },
      operationalLimits: { ...TESTNET_STORE_LIMITS, cumulativeAcrossDatabaseLifetime: true, automaticRetentionOrResetImplemented: false, note: 'The quote admission cap can stop new paid-path work long before a bandwidth ceiling. Existing orders remain recoverable; this benchmark does not authorize resets.' },
      limitations: ['No public deployment, external users, payments or token demand were measured.', 'Local CPU, shared load generation and unrestricted memory differ from a 0.5-CPU/512-MiB host.', 'Real finalized proof verification performs network reads absent from this mock-proof benchmark; paid-path throughput cannot be projected to public operation.', 'Small finite samples do not establish sustained capacity, availability, rate-limit behavior, disk endurance or monthly cost.'],
      sourceHashes,
    };
  } finally {
    clearInterval(timer);
    try { await http?.close(); } finally { try { service?.close(); } finally { rmSync(directory, { recursive: true, force: true }); } }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw new Error('This bounded local benchmark accepts no command-line targets or overrides.');
  const evidence = await runTestnetBenchmark();
  writeFileSync(new URL('../docs/testnet-benchmark-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ evidence: 'docs/testnet-benchmark-evidence.json', localOnly: true, chainProofs: 'mock; no settlement', paidJobs: evidence.paidPathWithMockProofs.reduce((n,round) => n + round.overall.jobs, 0), freeRequests: evidence.freeAudit.reduce((n,round) => n + round.requests, 0), sampledPeakRssBytes: evidence.memory.sampledPeakRssBytes, responseBodyOnlyEstimates: evidence.fiveDecimalGbResponseBodyOnly.estimates }) + '\n');
}
