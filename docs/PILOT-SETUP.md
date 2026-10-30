# Current pilot setup and approval boundaries

This checkout is the unlaunched `0.5.0-sepolia.1` candidate. The existing Mote Site at `https://mote-agent-utility.sunlightisfree.chatgpt.site` remains the separate free JSON utility. No paid Mote Render service, persistent signing key, public-chain transaction or public token deployment has been established for this candidate. Local EVM fixtures are not public settlement on either network.

## Implemented and tested locally

The candidate includes pinned Ethereum and Base Sepolia read-only chain adapters, a restricted quote/receipt signer, a public-synthetic HTTP service, durable SQLite orders and idempotent result delivery. The service re-verifies canonical finalized payment evidence before delivery and recovery. It never submits transactions. Normal startup requires existing validated order and lock files; it cannot silently initialize missing state.

The SQLite maintenance kit creates consistent backups and restores only to new quarantined paths. Recovery-only mode can re-deliver retained results or reconstruct a missing row from the original complete signed offer, original public synthetic input and exact finalized payment proof. It cannot issue new offers or clear quarantine. Lost artifacts and unknown finality remain unresolved; elapsed time does not authorize repayment.

The Ethereum payer journal, exact-operation policy and enforceable type-2 fee boundary are implemented and locally exercised. See ETHEREUM-PILOT.md for the selected network. The standard public Base submission path deliberately stops before signer invocation because an ordinary transaction does not enforce a complete native-fee cap covering every separately charged component. A fee estimate or journal reservation cannot turn that into a hard cap. Recovery uses the original proof without sending again. See [TESTNET-CLIENT.md](TESTNET-CLIENT.md).

The current candidate passed **312/312 tests on Node 24.22.2**. See the [full regression log](sepolia-full-tests-v0.5.txt) and [standard-client EVM demo evidence](sepolia-demo-v0.5-evidence.json). The previous Base candidate's 246-test result remains historical evidence. These are controlled local tests. They do not establish hosted 512 MB performance, public-chain consensus, wallet custody, real outside adoption or production readiness.

## Proposed host and first installation

The current proposal is a separate Render Node service with one 512 MB instance and one 1 GB persistent disk. The earlier Sites/D1 pilot proposal is superseded: no D1 adapter or database is provisioned by this candidate. The native SQLite runtime must run on a Node host with durable storage.

The base is **$7/month compute plus $0.25/month disk**, on a $0 Hobby workspace. The **$7.25/month base is not a hard cap**: taxes, outbound traffic, builds or optional resources can add charges, and a platform-enforced total cap has not been established. Actual hosting authorization and budgets are tracked separately from portable source. Hosting authorization does not authorize repository credentials or quote-key provisioning. The dedicated public source repository is [lestercrafton/mote-agent-pilot](https://github.com/lestercrafton/mote-agent-pilot); candidate source synchronization is pending this review checkpoint. Render's Public Git Repository URL route requires no Git provider access grant. Pin the reviewed full source commit before deployment. [Render pricing](https://render.com/pricing), [Git provider access](https://render.com/docs/git-provider).

Follow [PILOT-RENDER.md](PILOT-RENDER.md) for the exact first-install sequence. The temporary setup command runs on the same proposed instance and serves only maintenance readiness. After an authorized operator uses Dashboard Shell to install verified public configuration and explicitly initialize the new store, the final runtime can be selected. Setup does not read a wallet key, run RPC, initialize the database, or expose an HTTP administration API.

`/ready` checks the pinned local database/lock files, schema, identity and recovery gate. It does not perform a fresh RPC verification or replay every stored order. Startup performs the fuller SQLite integrity and per-row validation. The configured row/resource bounds and omission of development-only Ganache/compiler imports reduce exposure, but no hosted memory/load measurement proves that all accepted data and recovery workloads fit 512 MB. Actual host startup and capacity validation remain deployment gates; do not respond to failure by silently buying a larger instance.

## Separate authority and access gates

- **Quote/receipt custody:** a dedicated unfunded quote key would be provisioned only after specific approval, under `MOTE_ETHEREUM_SEPOLIA_QUOTE_PRIVATE_KEY`. It must match the pinned quote signer and differ from the deployer, initial holder and merchant. The web service must never receive a deployer/admin key, seed phrase or transaction-signing wallet. No key value, generation directive or placeholder key is included.
- **Deployment authority:** public contract creation requires a separately approved signer/custody setup and exact deployment plan, target chain, transactions and fee authority. That signer stays outside the web service. Preparing calldata or a configuration file is not permission to broadcast it.
- **Test-asset onboarding:** any faucet account, sign-in, provider terms or funding action requires its own authorized path. No faucet action or external account creation is part of this delivery. Test assets must not be marketed as having value, a peg, redemption or a return.
- **Source/hosting access:** any hosting approval is scoped to the chosen service, terms and separately recorded budget. Repository credential transmission and persistent secret creation remain separate gates; merely reading or applying this document adds no authority. Use the authorized native provider workflow without substituting an unapproved access path.
- **Payer operation:** recurring agent calls require a valid preauthorization and trusted persistent spend journal, not a human prompt for each request. The current full-fee-cap boundary remains enforced; neither server readiness nor possession of a quote lifts it.
- **Recovery operations:** approve the backup destination, access, retention and any off-host cost before adding them. Never restore a payer journal from a service snapshot. Service restores stay quarantined until original proofs are reconciled, and there is no automatic activation command.

Once setup is authorized, operation is designed to be unattended within those established boundaries. Missing configuration, lost evidence, corruption, insufficient capacity or indeterminate settlement must stop the affected action and preserve recovery information. No component may acquire new resources, expand its budget, top up a wallet or replace an unresolved payment on its own.

See [the selected Ethereum deployment guide](ETHEREUM-PILOT.md), [the Render installation proposal](PILOT-RENDER.md), and [storage recovery](TESTNET-RECOVERY.md). The working names Mote and MOTE remain unvetted, and useful demand for a new token remains unproven.
