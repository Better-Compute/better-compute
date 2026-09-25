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
```

The bundle (`.better-compute/pki.json`) turns on JoinService, the audit module and the gateway role. Its node CA carries the revocation set the gateway enforces. `better-compute pki show` prints the pins that install scripts carry.

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
const bridge = createComputeIamBridge(); // @better-compute/iam
const iam = betterIam({
  database: postgresAdapter({ url }),
  secret,
  baseURL,
  plugins: [bridge.plugin()],
  resolveResource: bridge.resolveResource(),
});
// then in the options: iam: bridge.embedded(iam, { rootTenantId }), modules: [...bridge.modules, ...]
```

## 5. Join machines

```sh
better-compute daemon install-script --pool pool_… --site site_… \
  --gateway-url https://gw.eu-1.compute.example.com:8443 --base-url https://compute.example.com \
  --bcd-version 0.1.0 --out install.sh
```

The script pins the serving CA and JoinService's keys from the bundle. Give each server its join token (`better-compute api joinTokens.create …`) out of band; `bcd` only ever dials out to the gateway.
