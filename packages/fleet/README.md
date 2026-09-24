# @better-compute/fleet

FleetConfig as code for better-compute (PLAN.md §9.2 `fleet`, v0.2), in the style of better-iam's `TenantConfig`. A FleetConfig document describes one tenant's platform objects by name:

- sites
- provider accounts
- pools, with their owner quota and the offers made to other tenants
- VPS flavors

```yaml
version: 1
sites:
  - { name: fra, kind: shared, region: eu-central }
providerAccounts:
  - { name: cloud, provider: hetzner-cloud, config: { token: secret://hetzner } }
pools:
  - name: vps-fra
    site: fra
    class: vps-host
    gpuModel: L40S
    ownerQuota: { gpu: 8 }
    offers:
      - { tenant: acme, quota: { vcpu: 64, gpu: 2 }, priority: 5 }
  - { name: burst, site: fra, class: provider, providerAccount: cloud }
flavors:
  - { pool: vps-fra, name: g1.small, vcpu: 2, memoryGiB: 4, diskGiB: 40 }
```

## Methods

Every method decides `compute:fleet:admin` on the `fleet` scope (`global`, which resolves only in the root tenant):

- **`fleet.export`** writes the current state as a document. Objects fleet did not create are named by their id.
- **`fleet.plan`** diffs a document against the current state.
  - It returns human-readable `changes` (create, update, delete or unchanged, with the changed fields).
  - It returns the exact `calls` that apply would make, and a `planHash`.
  - Changes that cannot be applied are marked `blocked`. These include sites (they never change and are never deleted), a pool's site, class, sharing, agent or provider account, dangling references, and an offer to the pool's owner.
  - Deletes happen only with `prune: true`:
    - Pools are archived, and live bookings keep running.
    - Flavors are deleted.
    - Offers are withdrawn.
    - A provider account is deleted only once no pool uses it.
- **`fleet.apply`** runs the plan through the owning modules' own methods (`sites.create`, `pools.*`, `quotas.set`, `flavors.*`, `providerAccounts.*`). It is a composite method with `transaction: 'manual'`, and runs in two phases:
  1. Each call is decided for the caller with `ctx.check`, with no transaction open. The caller therefore needs each underlying permission as well as `fleet:admin`.
  2. Inside one transaction, fleet re-reads the state and plans again. If the call list changed, the state moved between the phases: nothing is applied and apply fails with `CONFLICT` and `details.reason = 'CONFIG_DRIFT'`. Otherwise every call runs through `ctx.invoke`.

  Pass the reviewed `planHash` to apply exactly the plan that was shown. If the state has moved since then, apply fails with the same drift error.

Created objects get deterministic ids. The idempotency key is `fleet:<tenant>:<kind>:<name>`, and the id is `draftId(prefix, tenant, caller, key)`, so a retried apply converges instead of duplicating. The module's table `fleet_names` (migration `fleet/0001_names`) maps names to ids.

```ts
import { fleetModule } from 'better-compute/fleet';

const compute = betterCompute({ ..., modules: [fleetModule()] });
```

## License

[Apache License 2.0](LICENSE)
