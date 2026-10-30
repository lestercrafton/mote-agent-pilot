# Original local protocol and interoperability

This document describes the retained local `mote-local-v1` prototype and its loopback MCP bridge. Its local finality, expiry and client-lifetime limitations are scoped to that implementation. For the separate current testnet candidate, use [PILOT-HTTP.md](PILOT-HTTP.md), [TESTNET-CLIENT.md](TESTNET-CLIENT.md) and [ETHEREUM-PILOT.md](ETHEREUM-PILOT.md). The public free MCP bridge is described in [PUBLIC-MCP.md](PUBLIC-MCP.md).

Mote is an unvetted working name. This repository implements a local development prototype with a useful demonstration JSON utility, not established demand, a public cryptocurrency launch, a peg, a redemption promise, or a value claim. The public fixture balances are worthless. No creator royalty or tip recipient is configured; tips do not affect access or discovery.

## Implemented discovery

`GET /.well-known/mote.json`, `GET /openapi.json` and `GET /health` are free. The Mote manifest is project-specific and includes capability, limits, deterministic price calculation, chain/token/router/recipient bindings and recovery information. It is not an A2A Agent Card, x402 Bazaar listing, or proof that an agent directory has indexed the service. Discovery supplies data; it never authorizes spending.

The demonstration capability is `json.audit`: deterministic sorted-key JSON, SHA-256 fingerprint, byte count, and optional validation against a deliberately restricted draft-07 JSON Schema subset. `src/json.mjs` defines the supported keywords and resource limits. Remote references, regular expressions, custom executable validators and fetching URLs are absent. Mote's sorted-key representation does not claim RFC 8785 conformance.

## Implemented HTTP and settlement protocol

The wire protocol is **`mote-local-v1`**, not x402. The client first requests a free quote with `POST /v1/quotes`, supplying `{payer,input:{document,schema?}}` and an `Idempotency-Key`. The server prepares and stores the bounded deterministic result before issuing a signed offer. Unsupported or excessive input fails before payment. A schema validation finding (`valid:false`) is a successful audit result, not an execution failure.

The exact price is an integer string in token base units: `1000 + 10 * canonicalInputByteLength`. MOTE has six decimals. The formula covers the service only; native chain transaction gas is separate. The quote expires after 120 seconds. The authoritative payment fields are EIP-712 signed: `quoteId`, `requestHash`, `payer`, `amount`, `deadline`, with domain name `MotePayments`, version `1`, `chainId` and router `verifyingContract`. The router binds immutable token, merchant and quote signer. Clients must verify these bindings against an independently supplied allowlist, rather than trust discovery as an approval source.

The complete offer also carries `offerSignature`: EIP-191 over canonical JSON of every offer field except `offerSignature` itself, signed by the immutable quote signer. The client verifies it before payment so the promised `resultHash` and descriptive metadata cannot be altered independently of the contract's payment quote.

The explicitly authorized local fixture client approves the exact amount and calls the router. The router transfers MOTE and emits `Paid`; this is a real transaction in the local EVM, with no public-chain settlement. A consumed quote cannot charge again. The client then supplies `{quoteId,transactionHash}` to `POST /v1/orders` with a stable `Idempotency-Key`. The API verifies the successful receipt and matching event before returning the prepared result and receipt. Payment in an ERC-20 `Transfer` alone is not sufficient proof.

The response contains `result`, `receipt`, `receiptSignature` and `receiptSigner`. The receipt binds the request/result hashes, payer, exact amount, chain, token, router, recipient, transaction and local block identity. Its signature is EIP-191 over the Mote canonical representation of the receipt. This is a project-specific signed receipt format. It is not the x402 offer/receipt extension. The prototype only has local mined-block assurance; public-chain reorganization and operational finality policies remain launch work.

After a lost response, resubmit the original quote/transaction/idempotency key or query `GET /v1/orders/{quoteId}`. An unpaid prepared quote reports `awaiting_payment`; a registered payment yields the stored result and receipt. An uncertain payment must be reconciled against the chain before any new payment attempt. A token nonce by itself does not provide result delivery; the stored order and receipt provide recovery. The current client budgets and fixture chain lifetime must be understood before using a fresh client process: resetting the demo is not a durable production spending system.

## Implemented MCP bridge

`node scripts/mcp.mjs` serves stdio MCP through pinned `@modelcontextprotocol/server@2.4.0`. It uses the SDK's `serveStdio` factory, with **2026-07-28** modern request envelopes and **2025-11-25** legacy initialization both exercised by `test/mcp.test.mjs`. This is verified interoperability for the tool calls in these tests, not a claim to implement every optional MCP capability.

The four tools are `mote_discover`, `mote_quote`, `mote_order` and `mote_recover`. They do not create wallets, request secrets, approve tokens, sign quotes, submit transactions, swap, bridge, or top up. `mote_order` registers proof of a payment that was already submitted by a separately authorized client. The host must keep payment permission and deterministic budget controls outside language-model reasoning.

`MOTE_URL` defaults to `http://127.0.0.1:8787`. Only HTTP literal loopback origins (`127.0.0.1` or `[::1]`) are accepted; URL credentials, paths, query strings, fragments, remote hosts and HTTP redirects are rejected. This restriction is intentional for the local prototype. Bridge requests have a 10-second timeout, a 64 KiB request-body cap, a 256 KiB response cap and a 128 KiB stdio message-buffer cap. stdout is reserved for MCP JSON-RPC traffic.

Configure an MCP host with the absolute project path as its working directory, command `node`, arguments `scripts/mcp.mjs`, and optional environment `MOTE_URL=http://127.0.0.1:8787`. Start the local service separately with `npm start` first.

## x402 integration gap

There is no x402 adapter in the runtime. There are no `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE` or `PAYMENT-RESPONSE` headers, x402 version negotiation, x402 payment payload validation, external facilitator calls, Bazaar registration, or ERC-3009 authorization methods. HTTP's use of payment-related concepts does not establish x402 conformance.

A future reviewed integration should use the official x402 v2 implementation and conformance tests, support an appropriate stable asset in addition to any optional MOTE path, and preserve exact pricing and client budgets. A newly deployed ERC-20 is not automatically supported by hosted facilitators; supported networks, assets, authorization methods and service policies must be checked. MOTE ownership should not be required for discovery or basic integration. Do not require speculative token purchases to exercise discovery.

The official exact scheme supports verification, successful resource handling, then settlement where the authorization method permits it. This prototype prepares its deterministic result before issuing an offer, which avoids charging for preparation errors, but it does not implement that x402 flow. Availability, crash recovery and retention still matter after a local payment. Adopting ERC-3009 would require signed authorization and validity-window tests in addition to this router's quote-consumption test; it is not implemented here.

Sources used for this design:

- [Official MCP TypeScript SDK v2 stdio guide](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio) and [MCP 2026-07-28 tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).
- [x402 exact scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact.md), [payment identifier extension](https://github.com/x402-foundation/x402/blob/main/docs/extensions/payment-identifier.mdx), and [offer/receipt extension](https://github.com/x402-foundation/x402/blob/main/docs/extensions/offer-receipt.mdx).
- [x402 Bazaar discovery extension](https://github.com/x402-foundation/x402/blob/main/specs/extensions/bazaar.md) and [ERC-3009 transfer authorization](https://eips.ethereum.org/EIPS/eip-3009).
