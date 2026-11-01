# Provider choice and exact live setup gates

Official sources checked November1,2026. These are engineering notes, not acceptance of provider terms or a launch approval.

**Chosen candidate:** Coinbase Developer Platform (CDP) facilitator, x402 v2 exact native USDC; Base Sepolia for the first authorized rehearsal, Base mainnet only after separate approval. CDP publishes support for these networks, API-key authentication and facilitator-paid gas for the EIP-3009 path. Its published pricing is1,000 onchain facilitator transactions/month free, then$0.001 each; verification is free. See [CDP facilitator](https://docs.cdp.coinbase.com/x402/seller/facilitator) and [FAQ](https://docs.cdp.coinbase.com/x402/support/faq).

Pinned SDKs: `@x402/core`, `@x402/evm`, `@x402/extensions`2.29.0 and `@coinbase/cdp-sdk`1.60.0. The package lock pins transitives. The adapter uses the official exact client and official CDP JWT implementation. It deliberately supplies a strict REST transport because the installed generic HTTP client follows redirects, and the generic resource server can repeat settlement on pending responses. See [production configuration](https://docs.cdp.coinbase.com/x402/seller/production-configuration), [exact scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md), [payment identifier](https://github.com/x402-foundation/x402/blob/main/docs/extensions/payment-identifier.mdx), [Circle addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses).

## Earliest unavoidable user action

Authorize the **specific CDP account/project and API-key provisioning/storage step**, including provider terms if a new account is required. Required capability: authenticate `/platform/v2/x402/{supported,verify,settle}`. This path needs a CDP API key ID+secret; it does **not** need a CDP wallet secret or permission to create a custodial wallet. Exact dashboard permission scopes and account billing requirements must be inspected before granting access. No credentials, provider agreement or billing enrollment have been created or accepted.

The user must also identify or separately approve a **verified native-USDC receiving address**. No recipient has been invented. A fixture/testnet address must not be silently reused for real revenue. If a new wallet is needed, its custody, recovery and permissions require their own concrete approval. The application needs only the public receiving address, not its spending key.

No new card step or hosting upgrade has been established. A CDP free tier does not establish that the user's account needs no billing setup; that remains to be checked in the authorized account flow. Do not request card details in chat. Existing Render authorization is not authorization for a new vendor subscription or crypto transfer.

## Remaining gates before paid activation

1. Review and provision the API credential and separate nonfunded offer/receipt signer, with secure storage and rotation. Do not reuse A2/Q/P2/P3 or their approved test-only authority. Decide the verified recipient and explicit provider-attempt/USDC budgets.
2. Authorize a bounded **Base Sepolia** test using supported test-USDC fixtures/wallet authority. Call `/supported` and verify exact native-USDC acceptance. Demonstrate CDP's actual transaction type, calldata shape and events fit the narrow proof verifier. Check RPC finalized block, bounded logs and EIP-1898 historical authorization state. No live facilitator transaction has been tested in this candidate.
3. Prove dropped-response, restart, timeout and receipt recovery with the real provider before any real funds. Retain the original journal and never retry an unknown settle. Finality may take longer than the provider's initial success response.
4. Finish production operations: Linux/actual-host qualification; monitored snapshot cadence and approved encrypted off-host transfer; production signer rotation/recovery; operator handling for unresolved reservations; approved source-bound legacy Q rebind and credential provisioning. Local combined wiring, disk/WAL gates and consistent quarantined backup/restore are implemented and fixture-tested; off-host transfer is disabled. No upgrade is currently demonstrated necessary.
5. Set an actual service price, refund/support and privacy terms, accounting/retention, applicable operator obligations and an explicit limited beta policy. The current free utility already performs the same deterministic computation; willingness to pay for signed recoverable receipts has not been established. No adoption or revenue claim is made.
6. Obtain separate exact approval for public release/activation and any real-money test, including network, asset, recipient, maximum amounts and fees. This local integration authorization does not authorize those actions.

The adapter provides cryptographic exact payer-amount boundaries and a durable application request-count budget. It cannot enforce future provider invoice pricing or protect against other activity using the same credentials. An account-level billing cap, or an explicitly approved invoice exposure, is needed before paid provider usage.
