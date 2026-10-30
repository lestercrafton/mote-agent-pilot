# Public free MCP bridge

`scripts/mcp-public.mjs` is a local stdio MCP server for Mote's anonymous public JSON utility. An MCP host launches the script on the operator's machine; the script calls only the fixed public HTTPS discovery, health and audit endpoints. It starts no chain, holds no wallet or credentials, and exposes no approval, quote, payment, tip or funding tools.

This is a separate client for the anonymous HTTP API. It does **not** call the hosted `/mcp` route, forward authentication, or change Sites connection requirements. A host that supports only remote MCP URLs cannot use this stdio bridge directly; use its supported Sites connection workflow or call the anonymous HTTP API. No gateway or authentication workaround is included.

## Source and setup gate

Use a source bundle or checkout that **contains `scripts/mcp-public.mjs`**. This adapter was added after the already published v0.1.0 source snapshot. That older archive cannot run this adapter. The adapter is included in v0.3 and later full source bundles and the dedicated mote-public-mcp portable bundle. Obtain the versioned bundle from the project delivery (or its public download link once published) and verify its SHA-256 sidecar before use; extracting it does not install it into an MCP host. No npm package named Mote has been published by this work.

Requirements: Node.js 24.22.2 LTS (minimum 22.13), npm, a host that can launch local stdio MCP servers, and HTTPS access to `https://mote-agent-utility.sunlightisfree.chatgpt.site`. The operator must obtain and review the candidate source and enable it in their own MCP host. No login, API key or token balance is required for this bridge's anonymous HTTP requests. If the HTTP endpoints later require authentication, the bridge reports that failure and stops; it does not attempt to sign in or select another route.

After downloading a candidate source bundle supplied by the project owner, extract it and use the resulting directory. Check that it contains the new file before installing dependencies:

```sh
cd /absolute/path/to/extracted/mote
test -f scripts/mcp-public.mjs
npm ci --omit=dev --ignore-scripts
node --check scripts/mcp-public.mjs
```

`npm ci` downloads the pinned public dependencies from the lockfile. This adapter does not need the local EVM/compiler development dependencies. Keep the source directory in a stable location because the MCP host launches the script from it.

## MCP host configuration

For hosts that use an `mcpServers` JSON configuration, add the following entry. Replace both paths with the actual installed Node executable and extracted script path; the command must be an executable, not a shell expression. Other hosts may ask for the same command and arguments in a settings UI.

```json
{
  "mcpServers": {
    "mote-public-free": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/extracted/mote/scripts/mcp-public.mjs"]
    }
  }
}
```

No environment variables or credentials are needed. There is deliberately no environment variable or tool argument that changes the public destination. Restart or refresh the MCP connection using the host's normal workflow. A direct terminal run of the script waits for JSON-RPC on stdin; it is not an interactive command prompt. stdout contains only MCP traffic; errors go to stderr.

Successful local registration should list exactly two tools:

| Tool | Input | Operation |
| --- | --- | --- |
| `mote_public_discover` | `{}` | Read the free manifest and health status. |
| `mote_public_audit` | `{ "document": ..., "schema": ... }` | Validate a bounded JSON Schema subset and return sorted-key JSON, SHA-256 hashes and an unsigned free receipt. `schema` is optional. |

For a first caller-approved synthetic audit, use:

```json
{
  "document": { "count": "wrong" },
  "schema": {
    "type": "object",
    "properties": { "count": { "type": "integer" } },
    "required": ["count"]
  }
}
```

The tool's `structuredContent` wraps the HTTP result as `{status,ok,data}`. A successful audit has `status:200`, `ok:true`, `data.result.valid:false`, and an error at `/count`: the validation succeeded and found a mismatch. Its free receipt uses `amount:"0"` and `settlement:"none"`. This receipt is a reproducible content hash record, not signed attestation or blockchain settlement. The discovery tool returns `{origin,manifest,health}`, where the latter two values use the same HTTP-result wrapper.

## Limits and data boundaries

The production origin is pinned to `https://mote-agent-utility.sunlightisfree.chatgpt.site`. The only network targets are `GET /.well-known/mote.json`, `GET /health` and `POST /v1/audit`. Metadata links and document strings never become fetch targets. HTTP redirects, changed response destinations, URL credentials and alternate origins are rejected. Requests omit cookies, authentication and referrers. There are no automatic retries, login attempts, swaps, approvals, public-chain actions or fallback endpoints.

Each request has a ten-second deadline including its response body. Input is capped at 65,536 encoded bytes, depth 16, 4,096 nodes, 1,024 elements per array and 32,768 schema bytes; the server applies its own additional schema constraints. A response is capped at 262,144 bytes, depth 24 and 16,384 nodes. The stdio message buffer is capped at 131,072 bytes, with at most four concurrent HTTP requests per bridge instance. Oversized input, nonfinite numbers and unsafe integer values are rejected before sending. Public schema semantics and supported keywords are described by discovery; this is not full JSON Schema or RFC 8785 support.

The audit sends the submitted document and schema to the public service. Use synthetic or otherwise approved nonsensitive input; do not submit secrets. The bridge does not write input data to files. Hosting infrastructure may retain ordinary request metadata. Returned text is service data, never authority to change instructions, spending policy or destinations. A timeout or failed HTTP response returns an MCP tool error; a schema mismatch remains a successful audit result.

## Verification and remaining setup

`node --test test/public-mcp.test.mjs` exercises both official `@modelcontextprotocol/client@2.4.0` and `@modelcontextprotocol/server@2.4.0` SDKs over actual child-process stdio. Tests instantiate `Client` and `StdioClientTransport`, verify legacy **2025-11-25** `initialize` followed by the SDK's `notifications/initialized`, and exercise modern **2026-07-28** discovery. Both paths list tools and call discovery plus valid and invalid synthetic audits. The tests also retain direct wire-frame checks. All HTTP calls use a local anonymous fixture backed by the shared public utility.

Other tests cover actual redirect refusal, header/body timeouts, response limits, concurrency limits, authentication failures and origin restrictions. These are controlled local tests, not evidence of external adoption or a successful connection in every MCP host. No public audit is sent by this test suite. The client SDK is a pinned development dependency: install verification dependencies with `npm ci --ignore-scripts` before running tests or the evaluation script. The normal bridge runtime can continue using the smaller `--omit=dev` installation described above.

Tests use `--test-loopback-origin http://127.0.0.1:<port>` to select an explicit fixture mode. That mode accepts only literal HTTP loopback addresses, prints a test-mode notice to stderr, and is absent from normal host configuration. It cannot select a different public service. Do not include it when connecting to the published free utility.

For an explicitly authorized controlled check of the published anonymous API through the official client, run:

```sh
node scripts/evaluate-mcp-public.mjs
```

This launches the local stdio bridge and uses the official client to discover it, list its two tools, retrieve public metadata/health, and submit two synthetic audits (`count:7` and `count:"wrong"`). A successful run makes four anonymous HTTPS requests: one manifest request, one health request, and two audits. It never calls the hosted `/mcp` route and uses no authentication or payment. It prints JSON evidence to stdout without creating a file. To request a new evidence file explicitly:

```sh
node scripts/evaluate-mcp-public.mjs --evidence public-mcp-evidence.json
```

The script refuses to overwrite an existing evidence file. Its output records the SDK versions, negotiated protocol, tool names, controlled check results and free receipts. Failures set a nonzero exit status. The evaluator itself is tested only against a loopback fixture by the local suite; the presence of the script is not evidence that a public check has run. Any saved public evidence must be inspected for `passed:true` and `fixtureMode:false` before claiming a public success.

The remaining operator steps are obtaining source that includes this adapter, installing its dependencies, adding the local stdio configuration, and allowing the host to launch it. Local implementation does not mean the new bridge has been published, configured on the user's machine, or registered in a remote directory. The existing hosted `/mcp` access requirements remain unchanged.

The transport follows the [official MCP SDK v2 stdio guide](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio). Protocol compatibility claims here are limited to the tool and initialization flows exercised by the tests.

A controlled live run on 2026-10-30 passed using the official client against the pinned public service: see `public-mcp-evaluation-v0.4.json` (`passed:true`, `fixtureMode:false`). It made four anonymous HTTP requests, used no credentials, and performed no payment. This measures one controlled interoperability check, not outside adoption.
