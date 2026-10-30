# Render pilot installation proposal

Status: prepared locally; no paid Mote Render service, persistent quote key or public-chain deployment has been established. The dedicated public source repository has been created; candidate source synchronization is pending this review checkpoint. Actual hosting authorization and budgets are tracked separately from portable source; no platform-enforced total spending cap has been established. Repository credentials and quote-key provisioning remain separate approval gates. Public Ethereum Sepolia contracts and verified deployment evidence are separate prerequisites. This is not a claim that the pilot is publicly usable.

The final configuration is [render-pilot.yaml](../render-pilot.yaml): one Oregon Node 24.22.2 instance, `0.5c-512mb` (0.5 CPU, 512 MB), a 1 GB disk at `/var/data`, health check `/ready`, no previews, one instance, and automatic application deployment disabled. Its final start command is `node scripts/testnet-server.mjs`. The former Starter-sized compute is $7/month plus $0.25/month for the disk on a $0 Hobby workspace: **$7.25/month base, not a spending cap**. Build or outbound overages, tax and optional resources can add charges. A build-minute limit is not a total billing cap. Recheck the quote before purchase. [Pricing](https://render.com/pricing), [Blueprint fields](https://render.com/docs/blueprint-spec).

The existing free utility does not need this paid instance. The proposed instance serves the separate durable, public-synthetic testnet pilot. The selected Ethereum client enforces the complete ordinary type-2 fee ceiling. Base remains disabled; starting a service does not supply signer custody, test balances or public transaction authorization. See ETHEREUM-PILOT.md.

## Prepare before creating the host

Use the reviewed source and lockfile on Node 24.22.2 from [lestercrafton/mote-agent-pilot](https://github.com/lestercrafton/mote-agent-pilot), after its candidate source commit is verified. Render's Public Git Repository URL route needs no Git provider connection or private-repository access grant. Select the reviewed full commit explicitly, keep auto-deploy disabled and verify the deployed SHA. A private-repository alternative would require separately authorized provider access; it is not needed for this public route. Do not put repository credentials, wallets, `.env` files, payer journals or SQLite backups in source. This document does not authorize creating an account, connecting a repository or transmitting a credential. [Git provider access](https://render.com/docs/git-provider).

After separately approved contract deployment, the preparation machine with the full development dependencies runs:

```sh
node scripts/testnet-admin.mjs prepare-config \
  --plan prepared-testnet-launch/plan.json \
  --receipts deployment-hashes.json \
  --origin "$MOTE_REVIEWED_ORIGIN" \
  --out deployment.json
```

`MOTE_REVIEWED_ORIGIN` is the exact reviewed canonical HTTPS service origin, without a trailing slash. `deployment-hashes.json` contains actual previously approved deployment transaction hashes; it is not a command to broadcast. This command reads RPC evidence, compiles/verifies the expected artifacts and writes a **new** public configuration file. It does not sign or send. Retain the reported config hash independently as `MOTE_CONFIG_HASH`; never infer the pin from an untrusted file while installing it. If the final Render hostname is not known before creation, choose the intended name/origin first and confirm the assigned origin before preparing the config; a mismatch requires fresh configuration review, not a header override.

```sh
node scripts/testnet-admin.mjs verify-config \
  --config deployment.json --hash "$MOTE_CONFIG_HASH"
node scripts/testnet-admin.mjs identity \
  --config deployment.json --hash "$MOTE_CONFIG_HASH" \
  --out expected-public-identity.json
```

These are read-only chain operations. Save the public files and independently checked hash through the approved deployment handoff. Do not run `prepare-config` on the minimal production installation: its compiler dependencies are intentionally omitted there.

## First installation on the same instance

A missing order database must make the real server fail closed. Render's disk is only available at runtime on its attached instance, not during build/pre-deploy commands or one-off jobs. The first install therefore needs a temporary maintenance process on the **same** approved service and disk. Do not use a second service or an ephemeral shell. Paid web services support Dashboard Shell; an ephemeral shell requires a prior successful deploy and has separate billing. We have not established that a failed first deployment offers a usable disk-backed shell. [Disk constraints](https://render.com/docs/disks), [Shell access](https://render.com/docs/ssh).

1. After approval, create the single service using the blueprint's resource limits, but override its first start command to `node scripts/testnet-setup.mjs`. Keep `/ready` as the health check. Set `MOTE_MODE=ethereum-sepolia-setup`, and **omit** `MOTE_ETHEREUM_SEPOLIA_QUOTE_PRIVATE_KEY` and every other wallet/key variable. Do not use a blank, generated or fixture key. If applying a Blueprint would require its final `sync:false` secret field now, use a reviewed installation-only copy with that field omitted; retain the final blueprint unchanged for the eventual pilot configuration.
2. Keep auto-deploy off and, when using a Blueprint, disable **Blueprint Auto Sync** separately. The temporary setup process serves `GET /ready` with HTTP 200; every other request returns HTTP 503. It performs no signing, RPC, order API or database initialization. Its healthy response proves only that the setup process is running; it does not prove payment or testnet readiness.
3. Open this service's **Dashboard Shell** after the maintenance deployment succeeds. Use this existing instance, not SSH key creation, an ephemeral shell, a one-off job or pre-deploy hook. Confirm the expected runtime and mounted path:

   ```sh
   node --version
   test -d /var/data && test -w /var/data
   ```

4. Transfer only the verified public `deployment.json` and `expected-public-identity.json` through the approved handoff into `/var/data`, with new-file/no-overwrite semantics and mode 0600. Public source configuration may alternatively be copied from the reviewed checkout using Node `copyFileSync` with `COPYFILE_EXCL`; do not copy keys, journals or databases. Confirm their hashes against the independently retained handoff. Set the public `MOTE_CONFIG_HASH` and exact `MOTE_PUBLIC_ORIGIN` values; those are configuration pins, not secrets. From the service source directory run:

   ```sh
   node scripts/testnet-admin.mjs verify-config \
     --config /var/data/deployment.json --hash "$MOTE_CONFIG_HASH"
   node scripts/testnet-admin.mjs init-store \
     --config /var/data/deployment.json --hash "$MOTE_CONFIG_HASH" \
     --database /var/data/orders.sqlite
   node scripts/testnet-admin.mjs inspect-store \
     --config /var/data/deployment.json --hash "$MOTE_CONFIG_HASH" \
     --database /var/data/orders.sqlite
   ```

   `init-store` explicitly creates both new SQLite files and refuses existing state. It does not sign or send transactions. A failed initialization is inspected; never delete or overwrite old files merely to make startup pass. Existing or restored databases follow [TESTNET-RECOVERY.md](TESTNET-RECOVERY.md) instead.
5. Only after specific quote-key approval, provision the **dedicated, unfunded** quote/receipt key through the approved secret mechanism as `MOTE_ETHEREUM_SEPOLIA_QUOTE_PRIVATE_KEY`. It must match the pinned quote signer and differ from the deployer, initial holder and merchant roles. Never enter its value in source, this guide, a shell command/history, logs or an uploaded artifact. No deployer/admin key, seed phrase, transaction-signing wallet or repository credential belongs in the web process.
6. Set `MOTE_MODE=ethereum-sepolia-public-synthetic-test`, `MOTE_CHAIN_CONFIG=/var/data/deployment.json`, `MOTE_DATABASE=/var/data/orders.sqlite`, the independently reviewed `MOTE_CONFIG_HASH`, canonical `MOTE_PUBLIC_ORIGIN` and `MOTE_RECOVERY_ONLY=false` for a fresh store. Change the start command to the final `node scripts/testnet-server.mjs` and manually deploy. Keep one instance, auto-deploy and Auto Sync off. A restored gate requires explicit recovery-only mode; it can never be enabled for new quotes by this switch.
7. Verify `/health`, `/ready`, `/.well-known/mote.json`, `/openapi.json` and one bounded **free** `/v1/audit` request. Inspect readiness mode and `newQuotesAllowed`, the chain/config pins and public-synthetic limits. Do not submit a payment or generate a new public transaction as part of this check. Readiness covers durable service state, with chain evidence refreshed by proof operations; it does not establish independent RPC consensus, external adoption or public-payment readiness.

The setup-to-pilot switch is a one-time installation step, not a human approval prompt for every future authorized request. The server itself cannot provision keys, reset state, purchase resources or broaden payer policy.

## Operation and recovery

Only `/var/data` persists. Render disk-backed deployments interrupt the old instance before starting the new one, and their shutdown delay cannot be customized. Do not configure replicas or autoscaling. A full disk must fail admission closed; do not silently enlarge it or delete historical obligations. Monitor actual storage use and plan approved retention. [Persistent disks](https://render.com/docs/disks).

Use the SQLite-consistent maintenance tool and quarantine restore process in [TESTNET-RECOVERY.md](TESTNET-RECOVERY.md). Daily platform snapshots are not an application-consistent recovery guarantee. Keeping every backup on the same disk is not protection from loss of that disk; an approved off-host destination and transfer remain unresolved. A restored snapshot must retain quarantine and recover the original signed offers/proofs without requesting repayment.

Apply the applicable [Render terms](https://render.com/terms) and [acceptable-use policy](https://render.com/acceptable-use) through the authorized provider workflow within the separately recorded hosting approval. This local runbook itself performs no purchase or acceptance, and no service was created or configured while researching it.
