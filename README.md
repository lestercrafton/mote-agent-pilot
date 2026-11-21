# Mote

Mote validates tool-call JSON against an optional schema, returns canonical JSON, and computes a SHA-256 fingerprint. Try the [free utility](https://mote-agent-utility.sunlightisfree.chatgpt.site/).

The paid API adds a signed, recoverable receipt. A Base Sepolia rehearsal settled test USDC, delivered the result, and recovered the same signed response with one settlement. Mainnet has yet to be activated or verified. Once the payment host is available, its [USDC discovery document](https://mote-testnet-pilot.onrender.com/.well-known/mote-usdc.json) reports availability and the payment configuration.

## Agent integration

Start with the [payment profile](docs/PROFILE.md). The server returns an x402 v2 quote with the mandatory Mote request-binding extension. The client helper enforces a pinned policy, collects the two required signatures, and saves the original signed request for safe recovery. Deployments can opt into verification for already-deployed ERC-1271 payer accounts alongside compatible EOA payers.

## Development

Use Node 24.22.2 and the checked-in lockfiles.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm ci --prefix legacy --omit=dev --ignore-scripts --no-audit --no-fund
npm test
npm run demo
```

The tests and demo use synthetic fixtures. See the [operations guide](docs/OPERATIONS.md) for release, activation, backup, and recovery procedures.
