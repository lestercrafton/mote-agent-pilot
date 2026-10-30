# Retained Base Sepolia preparation

This is the retained Base-specific preparation guide from the earlier candidate. **Ethereum Sepolia is selected for v0.5; follow [ETHEREUM-PILOT.md](ETHEREUM-PILOT.md).** Base automatic payments remain disabled by the complete-fee-cap guard. The retained tooling prepares: reproducible token/router creation data, complete Solidity verification input, read-only public-network inspection, finalized deployment verification, and a portable free MCP bridge. **No Mote contracts have been deployed publicly by this work.** There is no public paid API, price, redemption promise or evidence that a new token is necessary. A local EVM configured with chain ID 84532 remains a local rehearsal.

## Retained network and recorded observation

Base Sepolia uses chain ID **84532**, public read RPC `https://sepolia.base.org`, submission endpoint `https://sepolia-sequencer.base.org`, and explorer `https://sepolia.basescan.org`. These are the current [official network settings](https://docs.base.org/get-started/connect-to-base). `config/base-sepolia.json` records the configuration with deployed addresses unset and broadcasting disabled.

```sh
npm ci
npm run testnet -- inspect
```

The saved controlled observation in `base-sepolia-observation.json` found the expected chain and finalized oracle code, but the official RPC reported pruned history before block 46,500,000. Its status is therefore `observed-partial`, with `chainIdentityPinned:false` and `readiness:false`; this does not satisfy a deployment identity gate. The inspector never substitutes another endpoint or treats a missing genesis as verified.

The inspector permits only bounded read RPCs against the fixed HTTPS endpoint. It checks the reported chain, observed genesis, canonical latest/safe/finalized blocks and the GasPriceOracle code. It rejects redirects, signing/submission methods, malformed responses and unavailable finality. A successful observation proves what that RPC reported; it is not independent consensus verification or a Mote deployment.

## Prepare the exact public artifacts

The verifier input is self-contained, including the referenced OpenZeppelin sources. It reproduces the existing contract bytecode without changing the token or router:

```sh
npm run testnet -- verification --out prepared-verification
```

The command writes `solc-input.json`, compiler/build metadata and ABIs into a new directory. It does not overwrite existing files, contact an explorer or require an API key.

After an approved signer setup supplies public addresses, copy `config/testnet-roles.template.json` to a new public configuration file. Fill in `deployer`, `initialHolder`, `merchant`, `quoteSigner`, and a current unused decimal-string `nonce`. Never put keys, seed phrases or credentials in this file. Unknown fields are rejected. Then:

```sh
npm run testnet -- account --address YOUR_PUBLIC_TESTNET_DEPLOYER_ADDRESS
npm run testnet -- plan --config public-roles.json --out prepared-testnet-launch
```

The plan contains exactly two unsigned contract creations, zero native value, consecutive nonces, predicted addresses, exact constructor arguments, source/bytecode fingerprints and a public plan hash. The token is fixed supply, six decimals, with no additional mint/tax/blacklist/upgrade hook. The router permanently binds the token, merchant and ECDSA quote signer. Predicted addresses are not deployed addresses. The plan deliberately contains no signature, gas authorization, expiry or broadcast capability.

The deployer and initial holder may be the same dedicated test-only account. The quote signer should be a separate unfunded key; it must persist across service restarts. The router does not support ERC-1271 contract signatures or signer rotation. Losing/changing that key requires a new router. Never use the repository's public local fixture accounts on a public network.

## Gas and faucet onboarding

Choose the CDP Portal faucet, using an existing external address. The current [CDP quickstart](https://docs.cdp.coinbase.com/faucets/introduction/quickstart) requires a signed-in CDP account for the UI, then selection of Base Sepolia and ETH plus the destination public address. The UI path does not require this project to create an API key or wallet secret. No account, faucet claim or connection was made here.

The [current faucet limits](https://docs.cdp.coinbase.com/faucets/introduction/welcome) list 0.0001 test ETH per claim and 1,000 claims per 24 hours. These are provider limits, not a guaranteed allocation or an invitation to evade limits. Use only free test ETH; never buy or bridge real funds for this pilot. Check the actual balance and gas estimate before claiming again. No funds have been spent.

Gas preparation is a separate required gate. [Base fees](https://docs.base.org/specifications/transactions/network-fees) include L2 execution, L1 data/security and any configured operator fee. GasPriceOracle is `0x420000000000000000000000000000000000000F`; its L1 upper-bound and operator-fee methods must be included in a fresh estimate. A token deployment can be estimated first; the router requires the deployed token to exist. Do not pretend that `gasLimit * gasPrice` caps the entire Base fee. The candidate now includes a public payer policy/journal and finalized actual-fee reconciliation, but it deliberately disables ordinary public submission because a complete hard fee cap is unavailable. See BASE-FEES.md and TESTNET-CLIENT.md; this is not production spend authorization.

## Signing, deployment and recovery runbook

1. Complete the specific signer/hosting approval described in `PILOT-SETUP.md`; obtain public addresses without exposing secret material in chat or files. A preauthorization must name chain 84532, the exact plan hash/roles, fee limits and a validity window.
2. Obtain free test ETH using the approved faucet account. Recheck chain, pending/latest nonce equality, code absence at predicted addresses, balance and current complete Base fees. Abort on changed state; rebuild and review the public plan instead of altering it silently.
3. Use the approved external signer for the token creation. Persist exact intent and the returned transaction hash before proceeding. If submission becomes uncertain, reconcile the original transaction; do not blindly retry or increment nonce.
4. Wait for matching canonical **finalized** evidence. Then estimate and submit the exact router creation with its expected next nonce and immutable addresses. No additional transfer, allowance, public faucet distribution or quote is implied by deployment.
5. Record the two hashes in a public JSON object with exactly `token` and `payments`, and run:

```sh
npm run testnet -- verify --plan prepared-testnet-launch/plan.json --receipts deployment-hashes.json --out verified-deployment.json
```

The checker requires both successful creation receipts, exact sender/nonces/value/input/address, finalized canonical blocks, compiler runtime matching outside immutable slots, immutable getters, token metadata/fixed supply/mint allocation, and the EIP-712 domain. It has no signing or sending method. Its output proves deployment evidence only, not a paid service or fee policy.

6. Submit the exported Standard JSON and exact constructor arguments to the explorer's verification UI when the operator is ready. Compiler version, optimizer and EVM target are recorded; no explorer account/API credential is created here. Public explorer verification and publication of verified addresses must precede a claim of public MOTE contracts.
7. Do not enable automatic Base payments: the shared candidate now implements durable orders, finalized-payment recovery and actual-fee accounting, but an enforceable complete Base fee cap remains unavailable. Bounded test-token onboarding is also not implemented. The original local prototype remains restricted to its local chain and origin; the separate testnet client does not bypass the Base refusal.

Base distinguishes preconfirmation, L2 inclusion, L1 batch inclusion and [L1 batch finality](https://docs.base.org/specifications/transactions/transaction-finality). This pilot chooses the RPC `finalized` tag and never substitutes a fixed number of L2 blocks. This may make a first pilot slow; a faster risk policy needs a separate decision and tests.

## Public utility and interoperability now

The existing free service remains available at `https://mote-agent-utility.sunlightisfree.chatgpt.site`. The new `scripts/mcp-public.mjs` lets a stdio-capable MCP host use that anonymous HTTP utility without a wallet or token. See `PUBLIC-MCP.md`. It does not call or bypass the protected hosted `/mcp` endpoint. Registry publication still requires an approved identity; local configuration or a source download does not establish indexing or organic adoption.

## Gates for eventual economic value

A testnet pilot is a proving ground. Moving beyond test assets requires demonstrated usefulness, independent security review, reviewed custody and recovery, complete fee/spend accounting, sustainable operating costs, explicit financial authorization and applicable legal review. No launch date, market price, peg, redemption, return or adoption is promised. Stablecoin-compatible payment support may be more useful than requiring a new token; x402 remains unimplemented here.
