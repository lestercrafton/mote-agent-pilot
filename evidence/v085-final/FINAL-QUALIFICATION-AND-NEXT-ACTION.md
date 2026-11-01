# Mote v0.8.5: reviewed and qualified, payments still disabled

November 1, 2026. This addendum supersedes the pending-review and pending-Linux statements in the immutable candidate's preparation report and the earlier checkpoint. It does not alter the source archive or authorize deployment, credentials, a signer, activation or payment.

## Completed

- Independent bounded review: 35 changed/added files and all 153 manifest entries checked; no demonstrated release-blocking security/code defect. Eleven targeted synthetic checks passed on Node 24.22.1. This was a direct review, not a completed formal security-plugin scan.
- Exact target runtime qualification: **170 passed, 0 failed, 0 skipped, 0 cancelled**, Node **24.22.2**, Debian 12, root-owned procfs, on the existing 512 MiB Render service. The previous local-runtime mismatch is resolved for final qualification.
- The test process ran for **78.942 seconds**, below the 120-second limit. Peak whole-service cgroup memory was **437,874,688 bytes (417.59 MiB)**, below the unchanged **469,762,048-byte (448 MiB)** threshold. Owned test-process cleanup completed. A later capture measured 251,047,936 bytes (239.42 MiB).
- All 153 source files matched the frozen manifest before and after execution. Six reused pinned dependency versions matched. All 86 legacy files and the strict proof/pagination baseline remain unchanged.
- Fixture staging and output were confined to a fresh private temporary directory. No live credentials, keys, signer commands, payments, faucet, deployment, restart, persistent application-data writes, or new costs were involved.

This is native fixture/resource qualification, not a live combined-production capacity measurement, a comprehensive security audit, disaster recovery proof, or evidence of demand. The current public service was not changed. No new mainnet payment was attempted.

## Immutable identity and evidence

- Source ZIP: `Mote-USDC-v0.8.5-production-prep.1-review-candidate.zip`, 561,076 bytes.
- Source ZIP SHA-256: `c59ad02344564f53e039cfd5a41fc5550f440627c4f677d163cd508f7fd7109d`.
- Manifest SHA-256: `6660080623a3ab948c4c9172c27f773f971a66b99d1ef05a804942858651e752`.
- Actual-host report SHA-256: `fb2141073306dc6ac2f42feb54a21322e8d126f570814e0cddf177fda7db3198`.
- Actual-host test log SHA-256: `4dd39aef2d03dfe89d7b81df88cce9a489c625630d4e81a1bd7bfce0b7bd07dd`.
- Capture SHA-256: `6807f58548dfb7f1bb4cff2d7aac5ab6ac4329a33aaca2afb690a64635c1eded`, captured 2026-11-01T19:32:58.197833Z.

The accompanying raw report/log, capture metadata, independent-review record, and bounded runner retain the evidence. The review record's historical `nativeLinuxQualification: pending` field describes its earlier time; this addendum and the actual-host report supply the completed result. The source ZIP's earlier pending text is deliberately preserved rather than silently rewriting the reviewed artifact.

## One concrete next approval: deploy disabled and provision its receipt signer

The following is an approval-ready action, not an action already executed:

> Approve publishing the reviewed v0.8.5 source identified above to **lestercrafton/mote-agent-pilot**, then deploying that exact resulting commit to my existing Render service **srv-dbijuvou01pc73d59c30**, with real payments disabled. Approve the explicit old-to-new source-binding record for the unchanged testnet quote key and existing restricted CDP credential, and exactly one persistent, unfunded receipt/offer signer at **/var/data/mote-usdc/production/receipt.key**. Approve fresh owner-private production directories, disabled private recipient configuration, and read-only custody, CDP `/supported`, and Base-finality preflight. Preserve the old records and stop if signer, transition or journal state already exists or is uncertain. No secret export, receiving-wallet access, payment, paid-route activation, new subscription, additional permission widening, or hosting upgrade. Proposed price and provider spending limits remain uncommitted until activation approval.

Exact destinations and controls:

1. Publish only the reviewed manifest-listed source and nonsecret evidence. Exclude private operator configuration, runtime, keys, journals and dependencies. Record the actual new Git commit; it does not exist yet.
2. Preserve legacy commit `70061654f33aea56ea1f6a1babff411af5c43f2d` and its Q import records. Create one exclusive transition at `/var/data/mote-usdc/release-transition.json`, binding the exact new commit, current service/origin, existing public destination hash and manifest hash. Pin `MOTE_RELEASE_TRANSITION_HASH` and `MOTE_SOURCE_ARTIFACT_HASH`. Do not replace the real `RENDER_GIT_COMMIT`, reimport Q or alter existing path permissions.
3. Use the same service, disk, origin `https://mote-testnet-pilot.onrender.com`, size and existing hosting budget. Set `MOTE_USDC_ENABLED=false` and run the reviewed combined startup. Check the exact deployed commit, free utility, testnet routes and disabled paid discovery before further work.
4. Create `/var/data/mote-usdc/production` and its `backups` child owner-private, reconcile absence, and run the qualified one-time receipt provisioner. Public intent must precede key creation. No automatic replacement/retry after interruption. Only its public identity/status may be output. The real key stays on Render; no secret goes through shell arguments, environment values, logs, screenshots, chat or source.
5. Keep existing Q at `/var/data/mote-sepolia-quote/quote.key` and restricted CDP at `/var/data/mote-usdc/cdp.json`. The source transition explicitly authorizes the new code's access; it is a security-sensitive revision change. Verify the CDP public-ID hash without exposing its secret or broadening its IP/account permissions.
6. Store only disabled private recipient/signer configuration at `/var/data/mote-usdc/production/config.draft.json`. Use the already confirmed native-USDC-on-Base receiving address privately; do not publish email or recipient in source. Do not initialize the paid journal or begin its economic window during staging.
7. Run the reviewed preflight with USDC disabled: custody validation, `/supported` and Base finalized identity only. No signing, verification, settlement, new listener or journal. Return actual deployed source identity, public signer identity, disabled readiness and resource observations. A failed gate stops the dependent step, without replacing authority.

Risks and consequences: the new signer is a real secp256k1 private key, even though the application exposes only message signing. Never fund it or use it as the revenue wallet. Host compromise could forge service receipts/offers and spend assets mistakenly sent to it; it could also expose the existing CDP credential within that credential's permissions. Its existing IP allowlist uses shared Render network ranges. The new source is explicitly trusted with these materials. Single-host private SQLite snapshots support restart/logical recovery, but disk loss can lose signer and records: no off-host export is configured. Rollback must preserve journals/counters and must never create a second writer or treat an older snapshot as fresh authority. The key is not automatically revoked by rolling code back; disable the route to stop new service signatures/payments. No receiving-wallet spending key is requested.

## Remaining activation gates — no further feature revision requested

After the approved disabled deployment passes its actual-source/custody preflight, the genuine remaining decisions are:

- Confirm operator disclosures/terms and receiving-wallet recovery are adequate. The wallet is user controlled; no seed phrase, recovery code, private key or identical screenshot is requested. Smart-account receipt compatibility does not imply payer compatibility.
- Approve exact beta economics and activation: proposed **0.01 USDC/job**, at most **100 lifetime settlement attempts** in one fixed window of at most **24 hours**, and a proposed **$1 total provider authorization including tax**. These are proposals, not active terms. At the documented nonfree rate, 100 attempts correspond to at most $0.10 before tax; account-wide activity and changed pricing require fresh checking. The application count cap is not a provider-enforced dollar cap. No card, new subscription or hosting upgrade has been identified as necessary.
- Initialize the one private production journal and its approved fixed window exactly once, verify backups/admission, and enable the paid route only after that activation decision. Same-disk backup limitations must remain visible; no automatic refunds or unknown-payment resubmission are promised.
- Complete a separately authorized mainnet smoke payment with a compatible EOA EIP-3009 payer and Mote request-binding helper. Lester performs any personal-wallet final signing/payment action; the receiving smart wallet is not assumed able to serve as that payer. Verify finalized USDC transfer, delivery and identical recovery without another settlement.

Paid-route activation and any real-value payment are separate from the disabled-deployment/signer bundle. Existing free service and experimental MOTE/Sepolia evidence remain intact. No organic adoption or profitability claim follows from the tests.

Current official references used for the proposal: [CDP facilitator](https://docs.cdp.coinbase.com/x402/seller/facilitator), [CDP x402 FAQ](https://docs.cdp.coinbase.com/x402/support/faq), [Circle native USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses). Rates and live account terms must be checked at activation.
