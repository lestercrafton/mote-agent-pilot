# Mote bound EIP-3009 profile v1

For the standalone fixture, `GET /health` and `GET /.well-known/mote.json` are free and `POST /v1/audit` is the paid endpoint. The combined adapter preserves the existing free `/v1/audit`; its free USDC discovery and health are `/.well-known/mote-usdc.json` and `/v1/usdc/health`, and its paid `POST /v1/usdc/audit` accepts `{document,schema?}` with the same bounded JSON/schema core as the existing free service. Missing `PAYMENT-SIGNATURE` returns402 with the official x402 v2 `PAYMENT-REQUIRED` header and one exact offer. No token ownership is necessary to discover or inspect the price.

Offer: exact network, native-USDC contract, recipient, integer base-unit amount, EIP-712 token domain and120s maximum authorization duration; signed body also binds config identity, resource, request/result hashes, issue time and180s expiry. Operator signature is an explicit Mote format, not a claim to implement the standard offer-receipt extension.

`src/client.mjs:authorize` checks the preauthorized policy and reserves total spending authority before invoking the official exact SDK. It adds `payment-identifier.info.id` and the mandatory `mote-request-binding.info` containing the offer and an EIP-712 `MoteRequest` signature by the same payer. Typed fields: origin, method, path, canonical request hash, signed-offer hash, payment ID and the full token-domain authorization digest. No private key is passed to Mote; the signer interface only has address and typed-data signing.

The binding is necessary because standard EIP-3009 does not sign an HTTP request or payment ID. Its signed fields are from/to/value/validAfter/validBefore/nonce, scoped by token domain and chain. The server rejects missing or altered binding before provider admission. It does not claim that ordinary stock x402 clients, SIWx or payment-ID alone bind request contents.

Retry with the **identical original body and original PAYMENT-SIGNATURE**, even after expiry. A completed response and signature are persisted and returned unchanged. Pending202 does not authorize a replacement payment. Optional `X-Mote-Transaction` supplies a transaction-hash hint that must pass full proof. There is no unauthenticated order dump, settlement retry route or auto-refund endpoint.

Response200 includes deterministic result plus a Mote-signed receipt binding policy/config, payer, payment ID/fingerprint, result hash, exact price/asset/payee and finalized chain evidence. Standard `PAYMENT-RESPONSE` carries the successful transaction/network/payer. Persist receipt and original authorization for recovery. This is not an implementation of the standard x402 offer-receipt extension.

Supported adapter metadata:

| Network | Native USDC | EIP-712 name/version |
|---|---|---|
| Base Sepolia, eip155:84532 | 0x036CbD53842c5426634e7929541eC2318f3dCF7e | USDC /2 |
| Base, eip155:8453 | 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 | USD Coin /2 |

Both use6 decimal places. No bridged assets, alternate recipients, Permit2, approval transactions or fallback networks are accepted. Network metadata alone is not activation or verified facilitator conformance.
