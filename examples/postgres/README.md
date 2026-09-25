# PostgreSQL: api, worker and gateway processes

The production shape of better-compute: every process runs the same `better-compute.config.ts` with a different `--roles`, against one PostgreSQL. Leases and shard ownership keep each job single-writer, so you can run several of each.

> Not exercised in this repository's CI beyond `doctor`: running it needs PostgreSQL 16+ (Docker Compose below) and, for the gateway, a PKI bundle.

## 1. Database and secrets

```sh
cd examples/postgres
docker compose up -d --wait
export BETTER_COMPUTE_DATABASE_URL=postgres://compute:compute@localhost:5432/compute
export BETTER_COMPUTE_SECRET=$(openssl rand -base64 48)    # the same for every process
```

## 2. Machine PKI and the gateway certificate

```sh
better-compute pki init --trust-domain compute.example.com
better-compute pki issue-gateway --san gw.eu-1.compute.example.com --out .better-compute/gateway
export BETTER_COMPUTE_GATEWAY_CERT=.better-compute/gateway/gateway.crt
export BETTER_COMPUTE_GATEWAY_KEY=.better-compute/gateway/gateway.key
export BETTER_COMPUTE_REGION=eu-1
export BETTER_COMPUTE_GATEWAY_URL=https://gw.eu-1.compute.example.com:8443   # published for `bcd join --server`
```

The bundle (`.better-compute/pki.json`) turns on JoinService, signed intent (commands and node specs signed under its command-signing root), the audit module and the gateway role. Its node CA carries the revocation set the gateway enforces. `better-compute pki show` prints the pins that install scripts carry; with `BETTER_COMPUTE_SECRET` set it checks them against the seal first. `BETTER_COMPUTE_GATEWAY_URL` (and `_SERVER_NAME` when the TLS name differs) is published in `/.well-known/better-compute` with the serving CA's pin. Prefer install scripts or user data that carry the pins: the well-known document is only as trustworthy as the control plane's TLS certificate.

A bundle sealed before the public parts were authenticated is refused: run `better-compute pki reseal`, compare the pins it prints with your records, then `pki reseal --accept-unauthenticated`. Bundles made before sandboxes get their sandbox SSH CA with `pki add-sandbox-ca`.

## 3. Run the roles

```sh
better-compute migrate                                                   # once per deploy
better-compute serve --roles api --port 3000 --no-migrate                # HTTP API (L7 load balancer)
better-compute serve --roles controllers,scheduler,sinks,iam --no-migrate # workers
better-compute serve --roles gateway --no-migrate                        # daemons, mTLS on :8443 (L4 passthrough)
better-compute doctor
```

`doctor` reports the host wiring. With separate processes, set `host.gateway.internal` (the internal CA's mTLS control API) and `notifier: gatewayNotifier(…)`. The api can then wake gateways after an enqueue, open tunnels and push revocations; without them, dispatch falls back to the gateway's 1-second loop.

## 4. IAM

Until better-iam is wired, no credential authenticates. Embed it through the IAM bridge (see `better-compute iam setup`):

```ts
// @better-compute/iam; sandboxHolders (@better-compute/vps): IamReconcile also re-reads sandbox owners and agents
const bridge = createComputeIamBridge({ identityHolders: [sandboxHolders] });
const iam = betterIam({
  database: postgresAdapter({ url }),
  secret,
  baseURL,
  plugins: [bridge.plugin()],
  resolveResource: bridge.resolveResource(),
});
// then in the options: iam: bridge.embedded(iam, { rootTenantId }), modules: [...bridge.modules, ...]
// and in the host export:
//   iam: { bridge, streams: [watches], readTenants: iamTenantReader(iam, { credential: computeServiceKey }) }
//   (the examples' host already sets iamReactions: [sandboxIamReactions] and streams: [watches])
```

`host.iam` makes IAM events act on compute: a revoked delegation or suspended agent closes its tunnels (on every gateway) and `/watch` streams and withdraws its unstarted reservations; a sign-out or revoked session re-checks that person's tunnels and revokes their break-glass SSH certificates, as does offboarding; an offboarded owner's reservations and sandboxes go to the successor, and a revoked agent's sandboxes are withdrawn; a deactivated break-glass role revokes the SSH certificates it allowed (and every minute each outstanding certificate is re-decided for its session); a spent budget applies the offers' `onBudgetExceeded`; a suspended or deleted tenant is refused from then on, and a deleted one is torn down. `readTenants` (`iamTenantReader` from @better-compute/iam, with a credential of compute's service account in the IAM root tenant) lets a suspension or deletion reach the tenant's whole subtree; without it only deletions of the named tenant apply. Pass the same `createWatchRegistry()` to `handleWatch({ registry })` and `host.iam.streams`. With remote IAM that cannot share its database, add `webhook: { secret }` and subscribe better-iam's root to `POST /iam/events`.

## 5. Join machines

Serve the release from this deployment (goreleaser's `dist`: the bare `bcd` binaries and the plugin archives) by
setting `BETTER_COMPUTE_DOWNLOADS_DIR=dist` for the api role, then write the script against the signed release manifest:

```sh
better-compute daemon install-script --pool pool_… --site site_… \
  --gateway-url https://gw.eu-1.compute.example.com:8443 --base-url https://compute.example.com \
  --bcd-version 0.1.0 --release-manifest dist/manifest.json --release-pins sha256/… --out install.sh
better-compute join-tokens create --pool pool_… --ttl 2h --max-uses 8 --out join-token
```

The script pins the serving CA and JoinService's keys from the bundle, and the binary's digest from the manifest
(verified here under the release keys, which bcd then self-updates under). Give each server the join token out of
band (`BCD_JOIN_TOKEN` or standard input); `bcd` only ever dials out to the gateway. A site agent that drives IPMI
BMCs also takes `--install-plugins bcx-ipmi` (the plugin archive from the same release, pinned by the manifest);
`--unprivileged` runs `bcd node` as its own user beside a root `bcd helper`.

## 6. Operations

- **Gateway certificates** (30 days): give `host.gateway.tlsFiles: { key, cert }` (the files `pki issue-gateway` writes; keep `tls.ca` from the bundle) and rerun `pki issue-gateway` before expiry; the gateway picks the new files up for new handshakes without a restart. The internal control API takes `internal.tlsFiles` the same way (and always needs its `ca`).
- **CA certificates** (1 year; `doctor` warns 30 days ahead): `better-compute pki renew-ca --ca node|serving|internal [--root-key root.key]` renews under the root with the same key, so nothing is re-pinned and no node rejoins. Roll the bundle out to every process.
- **Command-signing root**: `better-compute pki rotate-command-root --stage add`, roll out; once every daemon has the new trust version, `--stage switch` (it refuses while a connected daemon still reports the old version; `doctor` shows the count); a day later, `--stage drop`.
- **Break-glass and sandbox access**: `better-compute ssh-cert --node … [--connect HOST]` for a node, `better-compute sandbox exec sbx_… [-- command]` for a sandbox, `console`/`exec`/`forward` over tunnels. The tunnel commands (and `sandbox exec`) need `--url`; certificates are short-lived, re-decided every minute and revoked when access ends.
- **Support**: `better-compute support bundle` writes diagnostics with every token and secret redacted.
- **Operators' CLI access**: `better-compute auth login --url https://compute.example.com < token` keeps a token (owner-only file) for that deployment only; `better-iam login` sessions are used too.
- **AI agents**: mount `host.mcp: { handler: computeMcpEndpoint({ compute, gate: createMcpGate({ …, confirmations: false }) }).handler }` for the MCP endpoint at `/mcp`. The gate only checks visibility; confirmations come from compute's own actions, so the gate files none (a confirm-listed wildcard would otherwise match its read actions too). `doctor` reports an endpoint that answers without a credential (`host.mcp.ungated`).
