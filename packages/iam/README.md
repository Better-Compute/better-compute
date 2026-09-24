# @better-compute/iam

The [better-iam](https://github.com/Better-IAM/better-iam) bridge for better-compute (PLAN.md §12). better-iam is compute's only identity provider, policy decision point and billing ledger. This package holds everything that connects the two:

| Piece                                                          | What it does                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buildComputeCatalog`                                          | Merges core's normative resource types (`compute-fleet`, `compute-pool`, …) with the catalogs of the modules and plugins in use, within better-iam's limits. Plugins may only declare `compute:<id>:*` actions.                                                                                                                                                                           |
| `computeIamPlugin`                                             | The `IamPlugin` every IAM host on compute's IAM database installs: the catalog, plus an `afterAudit` that forwards the events of the §12.8 table to compute's inbox. It **never throws**. A slow or failing inbox (2 s timeout) spills into a bounded buffer that is flushed after the next successful write.                                                                             |
| `sqlInbox`, `memoryInbox`                                      | Inbox writers that dedupe on the audit event id (`iam_inbox`, `ON CONFLICT DO NOTHING`).                                                                                                                                                                                                                                                                                                  |
| `createAuthzProjection`, `sqlProjectionSource`                 | The memory-resident view of `authz_projection`. It loads at start and then tails `authz_changes` by `(txid, seq)`, reading only transactions older than the snapshot's xmin, so no commit is skipped. A miss does one primary-key read bounded to 20 ms.                                                                                                                                  |
| `computeResolver`                                              | better-iam's `resolveResource`. It echoes the reference and adds the row's attributes, pending `extend` values, `ownerId` and the prefixed `parentType`/`parentId`. `compute-fleet/global` resolves only in the root tenant and `compute-tenant/{t}` only in `t`. A miss is `NOT_FOUND`. A timeout, or a projection that isn't loaded yet, denies. Other types go to the host's fallback. |
| `embeddedIam`                                                  | Core's `IamPort` over an in-process better-iam: `authenticate` → `Caller`, `require`/`authorize`, `authorizeMany` in chunks of 50 (any error fails the list), delegated confirmation, `billing.check`, usage, cached flags. better-iam errors become `ComputeError`s.                                                                                                                     |
| `recordUsageIsolated`                                          | Usage with poison isolation. It bisects a failing `recordMany` batch down to the bad event. A deleted identity is re-attributed to its successor, or tenant-attributed with `attribution=orphaned`. What still fails is dead-lettered. Transient errors are rethrown untouched.                                                                                                           |
| `createFlagCache`                                              | One `features.isEnabled` per `(tenant, key)`, invalidated by `feature:*` events. The 5 min TTL is only a backstop.                                                                                                                                                                                                                                                                        |
| `drainIamInbox`, `reconcileIamIdentities`, `flushUsageWindows` | The `iam` module's worker jobs: IamInbox (per tenant, in `sequence` order, level-triggered), IamReconcile (re-reads the owners of live reservations) and the hourly usage sink.                                                                                                                                                                                                           |
| `createComputeIamBridge`                                       | Wires all of the above for embedded mode, including the `iam` module (migration `iam/0001_successors`; reconcilers `iam.inbox`, `iam.reconcile` and `iam.usage`).                                                                                                                                                                                                                         |

```ts
import { betterIam } from '@better-iam/server';
import { betterCompute } from 'better-compute';
import { createComputeIamBridge } from 'better-compute/iam';
import { metal } from 'better-compute/metal';

const bridge = createComputeIamBridge({ modules: [metal()] });
const iam = betterIam({
  database: iamDb,
  secret,
  baseURL,
  plugins: [bridge.plugin()], // catalog + afterAudit → iam_inbox
  resolveResource: bridge.resolveResource(), // memory-resident projection
});
const compute = betterCompute({
  database,
  secret,
  baseURL,
  modules: [metal(), ...bridge.modules],
  iam: bridge.embedded(iam, { rootTenantId }),
});
await compute.initialize(); // the iam module's start() loads the projection and binds the inbox
```

Until the projection is loaded, every compute decision is denied and inbox writes spill. `bridge.bind({ sql })` does the same as the module's `start()` for hosts that construct better-iam outside compute.

`@better-compute/iam/plugin` exports only what an IAM host installs: the catalog, the plugin and the inbox writers.

Peer dependencies: `@better-iam/core` (required), `@better-iam/server` and `@better-iam/client` (optional). Remote mode (`remoteIam`, `computeIamHost`, `replicaProjection`, `postgresInbox`) arrives in v0.4.

## License

[Apache License 2.0](LICENSE)
