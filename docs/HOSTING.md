# Free public adapter

`src/public.mjs` serves the same `prepareAudit` core as local paid orders. It accepts no payment, performs no chain action, holds no wallet, and does not persist documents. The API is experimental. Input bodies are capped at 65,536 bytes with a five-second read deadline; shared depth, node, array and schema limits apply.

Run locally with Node 22.13+ after `npm ci`:

```sh
node scripts/public.mjs
curl http://127.0.0.1:8788/.well-known/mote.json
curl http://127.0.0.1:8788/v1/audit \
  -H 'Content-Type: application/json' \
  -d '{"document":{"count":"wrong"},"schema":{"properties":{"count":{"type":"integer"}}}}'
```

The response has `result` and an unsigned hash `receipt`. `valid:false` means validation successfully identified a mismatch. These receipts provide reproducible hashes, not third-party attestations or blockchain settlement.

The public Sites checkout lives beside this project as `mote-site`. It uses the official Vinext/Cloudflare Worker starter with `nodejs_compat`, no database/storage bindings, and no configured secrets. Its `lib/mote/` files are exact snapshots of the three shared core modules; `scripts/sync-mote-core.mjs` updates them with SHA-256 provenance. The site builds independently from its tracked snapshot. When changing the core, sync and rebuild it before publishing; do not hand-edit a second implementation.

Project ID: `appgprj_6ae4109290d081918009685f51a0c568`. Expected origin: `https://mote-agent-utility.sunlightisfree.chatgpt.site`. Registration alone is not publication. See the final deployment evidence for live status.

Planned source download: `/downloads/mote-source-v0.1.0.tar.gz`. The source package excludes installed dependencies, Git metadata, runtime databases, environment files, credentials, and keys. Its download metadata will provide a SHA-256 integrity digest.

Prepublication verification: 13 shared-core/public-adapter tests passed; the actual local Cloudflare Worker returned successful health, manifest, OpenAPI, JSON audit and MCP responses, rejected duplicate keys, and served a functioning browser workbench. The hosted production dependency audit reported zero advisories after updating the starter's affected dependencies. These checks describe controlled test traffic, not live external usage.

HTTP discovery uses the project-specific `/.well-known/mote.json`, with OpenAPI at `/openapi.json`. It is neither an A2A Agent Card nor a claim of search indexing. The `/mcp` surface implements the Sites-documented stateless 2026-07-28 `server/discover`, `tools/list`, and `tools/call` methods. It exposes only `mote_audit`, which cannot spend. No compatibility with older stateful MCP handshakes is claimed. Sites may apply its platform connection requirements to the MCP route; unauthenticated HTTP is the primary bootstrap interface.

No application-level user identification or adoption counter is configured. Controlled test traffic proves functionality, not organic adoption. Hosting infrastructure may retain ordinary access metadata; the application does not log request bodies. Future usage reporting needs an explicit, reviewed aggregate measurement design and must distinguish controlled checks from independent visitors.

MOTE remains a separate local EVM experiment. Public utility availability does not make MOTE publicly deployed, redeemable, stable in value, or supported by an x402 facilitator.

## Current publication (2026-10-30 UTC)

Live: **true**, with public access at https://mote-agent-utility.sunlightisfree.chatgpt.site . Verified version 2 uses source commit `2f17f56e49a37c673d6e09efc304ea3e2325a94a`; deployment `appgdep_6ae419439f108191b8ea57374585305d` succeeded. Anonymous root, health, manifest, OpenAPI, JSON audit and source download all work. Raw anonymous `/mcp` returns 401 because Sites requires its connection/authentication context; the manifest and OpenAPI state this. A separate controlled native-catalog agent successfully discovered and called the tool through that context without a new setup step.

The source download at `/downloads/mote-source-v0.1.0.tar.gz` matches SHA-256 `790aa9fa5568242d3cd7dd440981589540c2950ab360b2032b7d58b98b2a9506`. It preserves the prepublication source/evidence snapshot; this current document supersedes that snapshot's deployment status. The hosted wrapper v0.1.1 package contains successful publication evidence.

The controlled public probe in `public-evaluation.json` passed all five checks with seven HTTP requests. Two independent internal-agent cold-start trials also passed. No organic adoption is established. No aggregate analytics capability or verified no-cost storage entitlement was found, so tracking was not added. The hosted adapter's complete dependency audit reports zero advisories.

## Resolved publication blocker

At the initial checkpoint, a read-only Sites check confirmed `current_live_url: null`, `latest_version_number: 0`, and custom owner-only access. The source helper was rejected before process creation; no source push, version save, access change, or deployment occurred in that rejected attempt.

Exact rejected action: `node <sites-plugin-root>/scripts/site-workflow.mjs --project-id appgprj_6ae4109290d081918009685f51a0c568` in the `mote-site` checkout, with elevated network execution for source synchronization and packaging. Automatic approval review stated, verbatim:

> This workflow would push source to an external repository and potentially publish the service publicly, creating an external commitment; no trusted user-authored authorization for that exact publication is present. Do not bypass this rejection through a workaround or indirect execution. Continue with a safer alternative, or carry out checks to prove that the action is authorized or low risk before trying again. Complete unaffected work without asking for confirmation. Report anything that remains blocked, clarify why it was blocked by auto-review, inform the user of the risk and ask for approval.

The original action was **denied and known not executed**. The parent then supplied materially new trusted user-authored authorization covering the public source/free-service scope. One retry of the same workflow passed review, followed by successful publication. No alternate route was used to bypass the rejection. There is no remaining publication blocker; financial operations and public token settlement remain outside this deployment.
