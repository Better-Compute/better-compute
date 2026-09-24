# @better-compute/provider-hetzner

Hetzner providers for better-compute (PLAN.md D8, §3.6). **`hetznerCloud`** serves Hetzner Cloud
servers as the instances of `class: 'provider'` pools. Hetzner Robot, for dedicated servers
bootstrapped into `metal-host` pools, follows.

The package sits outside the umbrella, so install it directly. It depends on
`@better-compute/core` and `@better-compute/vps`.

```ts
import { vps } from 'better-compute/vps';
import { hetznerCloud } from '@better-compute/provider-hetzner';

betterCompute({ modules: [vps({ providers: [hetznerCloud] })] });

// An account is data, validated by the provider's manifest. The token is a SecretRef, never a value.
await client.providerAccounts.create({
  tenantId,
  provider: 'hetzner-cloud',
  name: 'main',
  config: { token: 'vault://kv/hcloud', location: 'fsn1' },
});
```

## Behaviour

- **Config** is `{ token: SecretRef, location: 'fsn1' | 'nbg1' | 'hel1' | 'ash' | 'hil' | 'sin' }`.
  The token is resolved through the host's secret resolver on each request.
- **Idempotent create.** The Hetzner API has no idempotency keys. Instead, each server carries
  `better-compute.io/idempotency-key=<instance id>` and `better-compute.io/managed=true` labels.
  `create` first looks the key up. If a concurrent create wins the unique server name, it returns
  the winner.
- **Server names** are hostname-safe (`inst_01…` → `inst-01…`, at most 63 characters).
- **Offers** come from `/server_types` and `/datacenters`, both paginated.
  - They include gross hourly prices in EUR for the account's location, or the queried `region`.
  - `available` comes from that location's datacenters.
  - Deprecated types are skipped.
  - GPU and metal queries return nothing, since Hetzner Cloud has neither.
- **Power:** `on` → `poweron`, `off` → `poweroff`, `graceful-off` → `shutdown`,
  `reset`/`cycle` → `reset`, `graceful-restart` → `reboot`.
- **Other operations:** `reinstall` → `rebuild`. `list` yields only the servers this provider
  manages.
- **Errors**
  - A 404 is absent: `get` answers `undefined`, and `delete` and `power` throw `NOT_FOUND`.
  - A 429 is `RATE_LIMITED`, with `retryAfterMs` taken from `RateLimit-Reset`.
  - Everything else is `PROVIDER_ERROR`, with `details: { status, code }` holding Hetzner's
    error code.
- **Transport:** `hetznerCloudProvider({ fetch, endpoint })` swaps the transport. The tests use an
  in-memory emulator of the API, and the same hook can record or replay real traffic.

The package passes `providerConformanceCases()` from `@better-compute/vps`
(`tests/provider-hetzner.test.ts`).
