# @better-compute/core

Browser-safe contracts that every other better-compute package builds on: ids, errors, state
tables, domain types, the config `manifest` builder, extension contracts (`define*`), the
`SqlExecutor`, `Clock` and `IamPort` ports, the IAM catalog, and the normative method → action
table. It has no dependencies and imports nothing from Node.js.

The contracts freeze at the end of P0. After that they change only by additive, reviewed edits
(PLAN.md §5.1, `.claude/coordination.md`).

```ts
import { field, manifest, newId, reservationStateTable, transition } from '@better-compute/core';

const config = manifest({
  token: field.secret().describe('API token'),
  timeout: field.duration().default('10m'),
});
type Config = manifest.Infer<typeof config>; // { token: SecretRef; timeout: number }

const next = transition(reservationStateTable, 'draft', 'place'); // 'placed'
const id = newId('rsv'); // 'rsv_01…'
```

The conformance helpers have their own subpath, so the root entry carries no test code:

```ts
import { runConformance, type ConformanceCase } from '@better-compute/core/conformance';
```

## Contracts

- **errors**: `ComputeError(code, message, status?, details?)`, `ErrorCode`, `defaultStatus`
  (§9.1), `isComputeError`, `notImplemented(feature, phase)`.
- **ids**: `newId(prefix)` (monotonic lower-case ULIDs), `createIdGenerator({ now, random })` for
  the simulator, `idPrefixes`, `parseId`, `isId`, `draftId(prefix, tenantId, identityId, key)`
  (§3.4 step 5), `base32`.
- **duration**: `parseDuration('8h' | '1h30m' | ms)`, `formatDuration`, `Duration`.
- **clock**: `Clock`, `systemClock`, `manualClock(start)`.
- **states**: data-driven tables with `transition`, `canTransition`, `targets` and `exits` for
  provision (§11.1, with `failedFrom` and `metalRecoverTargets`), connectivity (§7.5),
  reservations (§10.5), commands (§7.4), instances (§11.1), and workflows and steps (§11.2).
- **domain**: regions, sites, pools, offerings, nodes, devices and atoms, reservation requests and
  records, allocations, bookings, instances, images, profiles, workflows and steps, command kinds
  and envelopes, NodeSpec sections, admission context, events, projects.
- **manifest**: `field.*` builders with `.optional()`, `.default()`, `.describe()`, `.suggest()`,
  `.disabledWhen()` and `.masked`. `manifest({...})` is a Standard Schema v1 with `.jsonSchema()`
  (2020-12 plus `x-bc` hints), `.parse()` and `.redact()`; also `manifest.Infer`, `SecretRef`, and
  `validateManifest`, which accepts any Standard Schema.
- **extension**: `DriverKinds` (open to declaration merging), `defineDriver`,
  `defineSchedulerPlugin`, `Placer`, `defineAttestor`, `defineSink`, `Notifier`, `LeaseProvider`,
  `BlobStore`, `SecretStore`, `CertificateAuthority`, `ImageSource`, `NodeAdapter`, the
  `ProviderDefinition` and `StepDefinition` types (their helpers live in vps and provision),
  `ComputeModule`, `defineModule`, `definePlugin`, `ModuleContext`, `defineMethod`, `ModuleApis`,
  `PluginApis`.
- **sql**: `SqlTx`, `SqlExecutor` (implemented by postgres and pglite), `Migration`
  (`<owner>/<nnnn>_<slug>`), `assertMigrations`.
- **iam**: `IamPort` (§12.1), `Credential`, `Caller`, `Decision`, `Check`, `SpendCheck`,
  `UsageEvent` (§12.7), `UsageResult`, `IamCapabilities`.
- **catalog**: `computeResourceTypes(prefix)` and `computeActions` (§12.3), and `apiSurface`, the
  §9.2 table as data with one row per method.
- **conformance** (subpath): `ConformanceCase<T>`, `ConformanceFailure`, `check`, `checkEqual`,
  `checkRejects`, `runConformance`.
