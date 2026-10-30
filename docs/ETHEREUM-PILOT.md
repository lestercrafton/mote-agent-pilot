# Ethereum Sepolia pilot runbook

Ethereum Sepolia (11155111) is the selected no-value pilot. The retained Base path remains disabled for automatic payments because its separate fee components lack an enforceable complete cap. Ethereum ordinary type-2 transactions bind a total gas limit and maximum fee per gas; the payer reserves that signed ceiling and reconciles complete actual fees. This change selects a different network; it does not relax the budget or relabel a fee estimate as permission.

Official sources: [Ethereum application test networks](https://ethereum.org/developers/docs/networks/), [Sepolia configuration](https://github.com/eth-clients/sepolia), [EIP-1559](https://eips.ethereum.org/EIPS/eip-1559), [PublicNode provider](https://ethereum.publicnode.com/?sepolia). The fixed anonymous read endpoint is `https://ethereum-sepolia-rpc.publicnode.com`. It is a third-party RPC provider, not an independent consensus proof. Canonical genesis, exact chain, deployment bytecode/configuration and finalized history are checked. No mainnet or arbitrary RPC override exists.

## Public configuration and deployment evidence

`config/ethereum-sepolia.json` contains public network references and null deployment addresses. `config/ethereum-sepolia-roles.template.json` deliberately contains null role addresses: it is not an executable distribution. Never use the public local-fixture accounts outside an isolated simulator.

```sh
node scripts/testnet.mjs inspect --network ethereum-sepolia --out NEW_OBSERVATION.json
node scripts/testnet.mjs account --network ethereum-sepolia --address EXISTING_PUBLIC_ADDRESS --out NEW_ACCOUNT.json
node scripts/testnet.mjs plan --config COMPLETED_PUBLIC_ROLES.json --out NEW_PLAN_DIRECTORY
```

These commands read or prepare unsigned public artifacts. The planner creates exactly two zero-native-value contract creations and full compiler verification input; it cannot create keys, fund, sign or broadcast. Reusing a mainnet wallet on a test network is inappropriate. Dedicated deployer/holder/quote identities, faucet access and exact public testnet transaction authority are separate setup actions and have not occurred in this candidate.

After separately authorized contract deployment, use actual transaction hashes:

```sh
node scripts/testnet.mjs verify --plan NEW_PLAN_DIRECTORY/plan.json --receipts ACTUAL_HASHES.json --out NEW_VERIFICATION.json
node scripts/testnet-admin.mjs prepare-config --plan NEW_PLAN_DIRECTORY/plan.json --receipts ACTUAL_HASHES.json --origin https://ACTUAL_SERVICE_HOST --out NEW_DEPLOYMENT.json
node scripts/testnet-admin.mjs verify-config --config NEW_DEPLOYMENT.json --hash VERIFIED_CONFIG_HASH
```

The admin CLI selects the network from the validated plan and pins the known Ethereum genesis. The quote key is an independent offline attestation key; it must differ from deployer, holder and merchant. A funded deployment wallet never belongs in the web service. See `PILOT-RENDER.md` for exact setup and durable initialization. Existing SQLite state is never silently reset, migrated to another chain or attached to new custody.

## Wallet operation under preauthorization

The caller supplies a legitimate existing EOA signer, a trusted pinned deployment identity and a deterministic policy. Discovery metadata cannot grant or enlarge spending authority. The standard client uses exact approvals and fixed conservative application limits of 250,000 approval gas and 500,000 payment gas, with caller-pinned maximum fee and priority fee. These are ceilings, not a promise of execution success under every fork or congestion state. A low fee, insufficient balance, expiry, inconsistent evidence or unavailable finality fails closed without automatic fee increases or replacement transactions.

Ethereum offers default to one hour, with a maximum two hours. The original active client can wait up to 30 minutes per known transaction for canonical finality, polling at bounded intervals, before proceeding from finalized approval to payment. It rechecks chain identity, nonce and expiry before payment. A crash, timeout or unknown submission retains reservations; restart recovery never resumes an unfinished send. A successfully paid receipt can be recovered after the original quote's wall-clock expiry. Routine permitted calls need no human approval UI after valid signer/policy setup.

The wallet must already hold authorized test ETH and test MOTE. Official Ethereum documentation links faucets; requirements may include sign-in, proof-of-work or an existing account. No faucet claim, token giveaway service, bridging or automated top-up is implemented. Public transactions, keys and custody still require specific authorization. All test-token balances have no claimed economic value.

## Verification and launch boundary

`npm run demo:sepolia` exercises the same standard client and fee checks on actual loopback EVM transactions, with a deliberately acknowledged local transport and public fixture signer. No fee-boundary override is used. The simulator's fork is Shanghai, so this is not direct execution evidence for the current public fork; the fee module separately verifies current protocol accounting against official sources and mocked fork-specific receipts. It is also not a public deployment or organic usage claim.

Read `ETHEREUM-FEES.md`, `TESTNET-CLIENT.md`, `RESOURCE-VERIFICATION.md`, `TESTNET-RECOVERY.md` and `ECONOMICS.md` before any pilot activation. Keep the useful public free Site available while deployment, source verification, host capacity, signer provisioning and testnet transaction authorization are resolved. No real-money fee or token sale is activated by this runbook.
