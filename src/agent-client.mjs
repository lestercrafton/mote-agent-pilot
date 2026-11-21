import { chmodSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getBytes, Interface, verifyMessage } from 'ethers';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import {
  assert, address, fail, hash32, uint,
  PROFILE, CONTRACT_PROFILE, NETWORKS,
  validateOffer, validatePayment, validatePaymentEnvelope,
} from './protocol.mjs';
import { authorize, recoverAuthorization } from './client.mjs';
import { Journal } from './journal.mjs';
import { FinalizedProof, rpcReader } from './chain-proof.mjs';
import { hashJson, prepareAudit } from './core/json.mjs';
import { USDC_MANIFEST } from './combined.mjs';

export const DEFAULT_RPCS = Object.freeze({
  'eip155:8453': 'https://mainnet.base.org',
  'eip155:84532': 'https://sepolia.base.org',
});

const ERC20_BALANCE_ABI = new Interface(['function balanceOf(address account) view returns (uint256)']);
const DEFAULT_INPUT = Object.freeze({ document: { task: 'sort', count: 3 } });

export function createEoaSigner(wallet) {
  assert(wallet && typeof wallet.address === 'string' && typeof wallet.signTypedData === 'function', 'SIGNER_INVALID');
  return Object.freeze({
    address: wallet.address,
    signTypedData: ({ domain, types, message }) => wallet.signTypedData(domain, types, message),
  });
}

export function generatePaymentId(prefix = 'mote-agent') {
  const clean = String(prefix).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'mote-agent';
  return `${clean}-${randomBytes(12).toString('hex')}`;
}

export function formatUsdc(microUsdc) {
  const value = BigInt(microUsdc);
  const whole = value / 1_000_000n;
  const frac = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '') || '0';
  return `${whole}.${frac}`;
}

async function readJsonResponse(response, maxBytes = 131072) {
  assert(response.body, 'RESPONSE_BODY');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      assert(total <= maxBytes, 'RESPONSE_LIMIT');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 256) }; }
  return { status: response.status, headers: response.headers, body };
}

function parseDiscoveryLink(linkHeader) {
  if (typeof linkHeader !== 'string') return null;
  for (const part of linkHeader.split(',')) {
    const match = /^\s*<([^>]+)>;\s*([^]*)$/.exec(part);
    if (!match) continue;
    const [, href, params] = match;
    if (/(?:^|;\s*)rel="service-desc"/.test(params)) return href;
  }
  return null;
}

export async function discoverPaidService({ origin, manifestPath = null, fetchImpl = fetch, timeoutMs = 15000 }) {
  const baseUrl = new URL(origin);
  assert(
    baseUrl.origin === origin.replace(/\/+$/, '') &&
    !baseUrl.username && !baseUrl.password &&
    (baseUrl.protocol === 'https:' || ['127.0.0.1', 'localhost'].includes(baseUrl.hostname)),
    'ORIGIN_INVALID',
  );
  const cleanOrigin = baseUrl.origin;

  let resolvedManifestPath = manifestPath;
  let discoveredVia = manifestPath ? 'explicit' : 'fallback';
  if (!resolvedManifestPath) {
    try {
      const home = await fetchImpl(`${cleanOrigin}/`, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      const linked = parseDiscoveryLink(home.headers.get('link'));
      await home.body?.cancel?.().catch(() => {});
      if (linked && linked.startsWith('/')) {
        resolvedManifestPath = linked;
        discoveredVia = 'link-header';
      }
    } catch {
      // Fall back to well-known path if root endpoint is unavailable or lacks a Link header.
    }
    if (!resolvedManifestPath) resolvedManifestPath = USDC_MANIFEST;
  }

  const manifestUrl = new URL(resolvedManifestPath, cleanOrigin);
  assert(manifestUrl.origin === cleanOrigin, 'MANIFEST_ORIGIN_MISMATCH');
  const res = await readJsonResponse(
    await fetchImpl(manifestUrl.toString(), { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }),
  );
  assert(res.status === 200 && res.body && typeof res.body === 'object', 'MANIFEST_UNAVAILABLE');
  const manifest = res.body;
  assert(manifest.enabled !== false, 'PAID_SERVICE_DISABLED');
  assert(manifest.profile === PROFILE, 'UNSUPPORTED_PROFILE');
  assert(NETWORKS[manifest.network], 'UNSUPPORTED_NETWORK');
  assert(uint(manifest.amount) && BigInt(manifest.amount) > 0n, 'MANIFEST_AMOUNT');
  assert(hash32(manifest.configHash), 'MANIFEST_CONFIG_HASH');
  const endpointUrl = new URL(manifest.endpoint);
  assert(endpointUrl.origin === cleanOrigin || endpointUrl.protocol === 'https:', 'MANIFEST_ENDPOINT');
  assert(address(manifest.asset) === address(NETWORKS[manifest.network].asset), 'MANIFEST_ASSET_MISMATCH');

  const c = Object.freeze({
    ...(manifest.payerSignatureProfile ? { payerSignatureProfile: manifest.payerSignatureProfile } : {}),
    profile: PROFILE,
    origin: endpointUrl.origin,
    path: endpointUrl.pathname,
    method: 'POST',
    network: manifest.network,
    asset: address(manifest.asset),
    payTo: address(manifest.payTo),
    offerSigner: address(manifest.offerSigner),
    amount: manifest.amount,
    identity: manifest.configHash,
    maxTimeoutSeconds: 120,
    offerLifetime: 180,
  });

  return {
    origin: cleanOrigin,
    manifestPath: manifestUrl.pathname,
    discoveredVia,
    endpointUrl: `${cleanOrigin}${endpointUrl.pathname}`,
    manifest,
    config: c,
  };
}

export async function checkUsdcBalance({ network, payer, rpc }) {
  const net = NETWORKS[network];
  assert(net, 'UNSUPPORTED_NETWORK');
  const data = ERC20_BALANCE_ABI.encodeFunctionData('balanceOf', [address(payer)]);
  const raw = await rpc('eth_call', [{ to: address(net.asset), data }, 'latest']);
  const [balance] = ERC20_BALANCE_ABI.decodeFunctionResult('balanceOf', raw);
  return { balanceMicroUsdc: balance, formattedUsdc: formatUsdc(balance) };
}

export async function verifyMoteReceipt({ config: c, input, payment, paymentId, response, proof = null, rpc = null }) {
  assert(response && response.status === 'complete' && response.receipt && typeof response.signature === 'string', 'RECEIPT_MISSING');
  const r = response.receipt;
  const expected = prepareAudit(input);
  const { value } = validatePaymentEnvelope(c, input, payment, Math.floor(Date.now() / 1000), { recovery: true });
  assert(
    hashJson(response.result) === expected.resultHash &&
    r.profile === c.profile &&
    r.configHash === c.identity &&
    r.paymentId === paymentId &&
    r.payer === value.payer &&
    r.requestFingerprint === value.fingerprint &&
    r.resultHash === expected.resultHash &&
    r.amount === c.amount &&
    r.asset === c.asset &&
    r.payTo === c.payTo,
    'RECEIPT_SCOPE_MISMATCH',
  );
  assert(address(verifyMessage(getBytes(hashJson(r)), response.signature)) === c.offerSigner, 'RECEIPT_SIGNATURE_INVALID');

  if (proof) {
    const settled = await proof.settled(payment, r.transaction);
    assert(settled, 'FINALITY_PROOF_FAILED');
    for (const field of ['transaction', 'network', 'blockNumber', 'blockHash']) {
      assert(r[field] === settled[field], 'FINALITY_PROOF_MISMATCH');
    }
    assert(
      typeof r.finalizedBlock === 'string' &&
      /^0x[0-9a-fA-F]{1,64}$/.test(r.finalizedBlock) &&
      hash32(r.finalizedHash) &&
      BigInt(r.finalizedBlock) >= BigInt(settled.blockNumber) &&
      BigInt(r.finalizedBlock) <= BigInt(settled.finalizedBlock),
      'FINALITY_ANCHOR_INVALID',
    );
    if (rpc && r.finalizedBlock !== settled.finalizedBlock) {
      const anchor = await rpc('eth_getBlockByNumber', [r.finalizedBlock, false]);
      assert(anchor?.number === r.finalizedBlock && anchor.hash === r.finalizedHash, 'FINALITY_ANCHOR_MISMATCH');
    }
    return { verified: true, finalized: true, settled };
  }
  return { verified: true, finalized: false, settled: null };
}

function makeServerError(httpStatus, body) {
  const code = typeof body?.error === 'string' && /^[A-Z_]+$/.test(body.error) ? body.error : `HTTP_${httpStatus}`;
  return Object.assign(new Error(`Mote server rejected request (${httpStatus}: ${code})`), {
    code,
    httpStatus,
    serverBody: body,
  });
}

export async function payAndAudit({
  origin,
  manifestPath = null,
  input = null,
  signer,
  journalPath,
  paymentId = null,
  maxPerPayment = '10000',
  maxTotal = '10000',
  fetchImpl = fetch,
  rpc = null,
  rpcUrl = null,
  verifyFinality = true,
  checkBalance = true,
  dryRun = false,
  recoverOnly = false,
  verifyRecovery = false,
  pollIntervalMs = 5000,
  maxPolls = 60,
  timeoutMs = 25000,
  now = () => Math.floor(Date.now() / 1000),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onEvent = () => {},
}) {
  assert(signer && typeof signer.address === 'string' && typeof signer.signTypedData === 'function', 'SIGNER_REQUIRED');
  assert(uint(maxPerPayment) && uint(maxTotal) && BigInt(maxPerPayment) > 0n && BigInt(maxPerPayment) <= BigInt(maxTotal), 'SPENDING_CAP_INVALID');
  assert(typeof journalPath === 'string' && journalPath.length > 0, 'JOURNAL_PATH_REQUIRED');

  onEvent({ stage: 'discover', origin });
  const discovery = await discoverPaidService({ origin, manifestPath, fetchImpl, timeoutMs });
  const { config: c, manifest, endpointUrl } = discovery;

  assert(BigInt(c.amount) <= BigInt(maxPerPayment), 'PRICE_EXCEEDS_MAX_PER_PAYMENT');
  const jobInput = structuredClone(input ?? manifest.request?.example ?? DEFAULT_INPUT);
  const id = paymentId ?? generatePaymentId();
  assert(/^[A-Za-z0-9_-]{16,128}$/.test(id), 'PAYMENT_ID');

  const resolvedRpc = rpc ?? (DEFAULT_RPCS[c.network] || rpcUrl ? rpcReader(rpcUrl ?? DEFAULT_RPCS[c.network], { fetchImpl }) : null);

  let balanceInfo = null;
  if (checkBalance && !dryRun && !recoverOnly && resolvedRpc) {
    balanceInfo = await checkUsdcBalance({ network: c.network, payer: signer.address, rpc: resolvedRpc });
    onEvent({ stage: 'balance', payer: address(signer.address), balanceMicroUsdc: balanceInfo.balanceMicroUsdc.toString(), formattedUsdc: balanceInfo.formattedUsdc });
    assert(balanceInfo.balanceMicroUsdc >= BigInt(c.amount), 'INSUFFICIENT_USDC_BALANCE');
  }

  const policy = {
    ...(c.payerSignatureProfile ? { payerSignatureProfile: c.payerSignatureProfile } : {}),
    enabled: true,
    network: c.network,
    asset: c.asset,
    payTo: c.payTo,
    origin: c.origin,
    offerSigner: c.offerSigner,
    configHash: c.identity,
    payer: address(signer.address),
    maxPerPayment,
    maxTotal,
  };

  const rawParent = dirname(journalPath);
  if (!existsSync(rawParent)) {
    mkdirSync(rawParent, { recursive: true, mode: 0o700 });
    chmodSync(rawParent, 0o700);
  }
  const resolvedJournalPath = join(realpathSync(rawParent), basename(journalPath));
  const journal = new Journal(resolvedJournalPath, { config: c.identity, policy }, {
    create: !existsSync(resolvedJournalPath),
    clientBudget: maxTotal,
  });

  try {
    let payment;
    let quote = null;
    let signingMs = 0;
    let fromJournal = false;

    const existing = journal.clientGet(id);
    if (recoverOnly || existing) {
      assert(existing, 'RECOVERY_RECORD_NOT_FOUND');
      payment = recoverAuthorization(journal, id);
      fromJournal = true;
      onEvent({ stage: 'recovered_authorization', paymentId: id });
    } else {
      onEvent({ stage: 'quote', endpoint: endpointUrl });
      const quoteRes = await readJsonResponse(
        await fetchImpl(endpointUrl, {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(jobInput),
          signal: AbortSignal.timeout(timeoutMs),
        }),
      );
      assert(quoteRes.status === 402, 'QUOTE_UNAVAILABLE');
      const headerValue = quoteRes.headers.get('payment-required');
      quote = headerValue ? decodePaymentRequiredHeader(headerValue) : quoteRes.body;
      const offer = quote?.extensions?.['mote-request-binding']?.info?.offer;
      validateOffer(c, jobInput, offer, now());
      onEvent({ stage: 'quote_verified', amount: c.amount, formattedUsdc: formatUsdc(c.amount), expiresAt: offer.body.expiresAt });

      const t0 = performance.now();
      payment = await authorize({
        config: c,
        input: jobInput,
        offerResponse: quote,
        paymentId: id,
        signer,
        journal,
        policy,
        now: now(),
        paymentValidator: validatePayment,
      });
      signingMs = Math.round((performance.now() - t0) * 100) / 100;
      onEvent({ stage: 'signed', paymentId: id, signingMs, nonce: payment.payload.authorization.nonce });
    }

    const encodedSignature = encodePaymentSignatureHeader(payment);
    const paymentHeaderBytes = Buffer.byteLength(encodedSignature);
    if (manifest.limits?.paymentHeaderBytes) {
      assert(paymentHeaderBytes <= manifest.limits.paymentHeaderBytes, 'PAYMENT_HEADER_TOO_LARGE');
    }

    if (dryRun) {
      return {
        status: 'dry-run',
        dryRun: true,
        paymentId: id,
        payer: address(signer.address),
        signingMs,
        fromJournal,
        paymentHeaderBytes,
        discovery: {
          origin: discovery.origin,
          manifestPath: discovery.manifestPath,
          discoveredVia: discovery.discoveredVia,
          endpoint: endpointUrl,
          network: c.network,
          amount: c.amount,
          formattedUsdc: formatUsdc(c.amount),
          payTo: c.payTo,
          offerSigner: c.offerSigner,
          configHash: c.identity,
        },
        quoteExpiresAt: quote?.extensions?.['mote-request-binding']?.info?.offer?.body?.expiresAt ?? null,
        authorizationValidBefore: payment.payload.authorization.validBefore,
      };
    }

    const proof = verifyFinality && resolvedRpc
      ? new FinalizedProof(c, resolvedRpc, { allowContractSignatures: c.payerSignatureProfile === CONTRACT_PROFILE })
      : null;

    let txHint = null;
    let lastResponse = null;
    let polls = 0;

    while (true) {
      const headers = {
        'content-type': 'application/json',
        'PAYMENT-SIGNATURE': encodedSignature,
        ...(txHint ? { 'X-Mote-Transaction': txHint } : {}),
      };
      onEvent({ stage: polls === 0 ? 'submit' : 'poll', attempt: polls + 1, paymentId: id, txHint });
      const res = await readJsonResponse(
        await fetchImpl(endpointUrl, {
          method: 'POST',
          redirect: 'error',
          headers,
          body: JSON.stringify(jobInput),
          signal: AbortSignal.timeout(timeoutMs),
        }),
      );
      if (res.status !== 200 && res.status !== 202) {
        throw makeServerError(res.status, res.body);
      }
      lastResponse = res;

      if (res.status === 200) {
        const paymentResponseHeader = res.headers.get('payment-response');
        const decodedPaymentResponse = paymentResponseHeader ? decodePaymentResponseHeader(paymentResponseHeader) : null;
        if (decodedPaymentResponse) {
          assert(
            decodedPaymentResponse.success === true &&
            decodedPaymentResponse.transaction === res.body.receipt.transaction &&
            decodedPaymentResponse.network === c.network &&
            address(decodedPaymentResponse.payer) === address(signer.address),
            'PAYMENT_RESPONSE_HEADER_MISMATCH',
          );
        }
        const verification = await verifyMoteReceipt({
          config: c,
          input: jobInput,
          payment,
          paymentId: id,
          response: res.body,
          proof,
          rpc: resolvedRpc,
        });
        onEvent({ stage: 'complete', paymentId: id, transaction: res.body.receipt.transaction, finalized: verification.finalized });

        let recoveryVerified = null;
        if (verifyRecovery) {
          const original = recoverAuthorization(journal, id);
          const replayRes = await readJsonResponse(
            await fetchImpl(endpointUrl, {
              method: 'POST',
              redirect: 'error',
              headers: { 'content-type': 'application/json', 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(original) },
              body: JSON.stringify(jobInput),
              signal: AbortSignal.timeout(timeoutMs),
            }),
          );
          assert(replayRes.status === 200 && hashJson(replayRes.body) === hashJson(res.body), 'RECOVERY_MISMATCH');
          recoveryVerified = true;
          onEvent({ stage: 'recovery_verified', paymentId: id, identical: true });
        }

        return {
          status: 'complete',
          dryRun: false,
          paymentId: id,
          payer: address(signer.address),
          signingMs,
          fromJournal,
          polls,
          balanceBefore: balanceInfo ? balanceInfo.formattedUsdc : null,
          paymentHeaderBytes,
          transaction: res.body.receipt.transaction,
          receipt: res.body.receipt,
          result: res.body.result,
          signature: res.body.signature,
          response: res.body,
          finalityVerified: verification.finalized,
          recoveryVerified,
        };
      }

      if (res.body?.status === 'unsettled') {
        onEvent({ stage: 'unsettled', paymentId: id });
        return {
          status: 'unsettled',
          dryRun: false,
          paymentId: id,
          payer: address(signer.address),
          signingMs,
          fromJournal,
          polls,
          response: res.body,
        };
      }

      if (hash32(res.body?.transaction)) txHint = res.body.transaction;
      polls++;
      if (polls > maxPolls) {
        return {
          status: 'pending',
          dryRun: false,
          paymentId: id,
          payer: address(signer.address),
          signingMs,
          fromJournal,
          polls,
          transaction: txHint,
          response: res.body,
        };
      }
      onEvent({ stage: 'waiting_finality', paymentId: id, transaction: txHint, nextPollMs: pollIntervalMs });
      await sleep(pollIntervalMs);
    }
  } finally {
    if (journal.db.isOpen) journal.close();
  }
}
