# @better-compute/provision

Provisioning for better-compute: workflow steps, profiles, and the workflow engine that expands a
profile into persisted steps for one node or instance (PLAN.md §11.2). It depends on
`@better-compute/core`, `@better-compute/protocol` and `@better-compute/inventory`.

**Status: v0.2 workflow engine.**

- Implemented: `defineStep`, `defineProfile`, `provisionModule()` (the workflow engine, its
  tables, the Workflow reconciler), `ctx.workflows`, the image catalog, and the `profiles`,
  `workflows` and `images` API groups.
- Also implemented:
  - **Health remediation.** The `health` reconciler runs `remediate-reboot` (XID 79/95) and
    `remediate-gpu-reset` (pending row remap) once the node has drained. It stays within the pool's
    `policy.disruptionBudget` (default 5%) and pauses a pool when more than 10% of its nodes turn
    unhealthy within 10 minutes (the circuit breaker). A failed, cancelled or exhausted remediation
    puts the node in maintenance.
  - **User data renderers** (`userdata.render`). They render cloud-init (`bcd-host.yaml.hbs`) or
    Ignition (`bcd-host.ign`), embedding a single-use `provisioned` join token minted through
    `ctx.pki`. The document is stored through `ctx.secrets`, and the deploy carries only its
    `userDataRef`. Template values must be single lines, so a value can never inject lines.
  - **Config units.** `nvidia-driver`, `container-toolkit`, `mig-layout`, `fabric-manager`,
    `sysctl`, `hugepages`, `kernel-modules`, `gpu-sharing` and `k8s-join`, each validated before any
    node gets it:
    - `sysctl` refuses the keys bcd refuses (`forbiddenSysctls`: `kernel.core_pattern`,
      `kernel.modprobe`, `user.*` and others that run programs as root or lower the host's defenses);
    - `hugepages` takes `{ pages2m?, pages1g?, transparent?, perNuma? }`. bcd allocates 2 MiB pages at
      runtime and 1 GiB pages through the kernel command line, reporting when a reboot is pending;
    - `kernel-modules` takes `{ load?, options? }`, e.g. `kvm_intel` with `nested=1` for VM hosts;
    - `gpu-sharing` takes `{ mode: mps | timeslice, replicas? }`;
    - `cpu` takes `{ governor?, isolate? }`. `isolate` is a cpulist of CPUs isolated from the scheduler, never
      CPU 0, and takes effect after a reboot;
    - `iommu` takes `{ passthrough? }`, for GPU passthrough to VMs (effective after a reboot);
    - `gpu-settings` takes `{ powerLimitWatts?, ecc? }`, each GPU's power cap and ECC mode;
    - `k8s-join` takes `{ server, caCertSha256, tokenRef, kubernetesVersion?, nodeLabels?, taints?, gpu?, gpuApi? }`.
      `gpuApi` is `device-plugin` (default) or `dra`. The kubeadm bootstrap token is only ever a
      `secret://` reference that bcd fetches through the broker, never in the spec. Labels and taints use Kubernetes syntax, without the
      `kubernetes.io`/`k8s.io` prefixes.

    `when:` is checked against the node's labels, and `mig-layout` can take `from: 'pool'`. The units
    are served as the NodeSpec `host` section from the last succeeded workflow's `hostConfig`. The
    engine invalidates desired state when such a workflow succeeds.

    A pool's policy adds units to every one of its machines, adopted ones included, and they win over
    the profile's (`poolHostConfig`):
    - `policy.kubernetes` with `apiServer`, `caCertSha256` and `joinTokenRef` gives `k8s-join`. A hosted
      pool gives none of the three, because bcd runs inside the cluster as a DaemonSet
      (provider-kubernetes);
    - `policy.hugepages` `{ size, count, perNuma }` gives `hugepages`;
    - `policy.kernelModules` gives `kernel-modules`;
    - `policy.cpu`, `policy.iommu` and `policy.gpu` give `cpu`, `iommu` and `gpu-settings`;
    - a pool shared by `mps` or `timeslice` gives `gpu-sharing`.

    The pools API checks a policy with `validatePoolHostPolicy`. A pool's layout reaches a node only
    once capacity granted the change (`provision_gated_mig_layout`, reading `capacity_mig_layouts` when
    capacity is installed), so booked MIG instances are never repartitioned under a reservation.
  - **`driver.invoke`**, the command kind of profile steps that name a driver operation
    (destructive, so always signed; `driverInvokeCommandKind`).
  - **Workflows** can be aborted, retried from a step, paused and resumed (`workflows.*`).
  - **Doctor findings** (`selfCheck`): steps past their deadline that no worker advances
    (`workflows-stuck`), and workflows that failed in the last day.

## Image catalog (PLAN.md §11.5)

- **Migration.** `provision/0002_images` creates `images`, `image_signers` and `image_locations`.
- **`images.register`** records an image by `ref` (`name@version`), `sha256`, `format`,
  `compression` and `source` (`https://` or `oci://`).
  - A `signature` (base64, over `imageSigningInput(...)`) must verify against `signerId` on the
    tenant's allowlist or the platform's (Ed25519, or ECDSA P-256 over SHA-256). A verified image
    carries `verified: true`.
  - Unsigned images are private forever (a table CHECK enforces it).
  - Ramdisks must be signed by a platform signer.
  - Signers are managed with `addImageSigner` / `revokeImageSigner`.
- **`images.promote`** makes a verified image public by writing a wildcard (`tenantId: '*'`)
  authz row.
- **`images.get` / `images.list`** return the tenant's own images and public ones.
  `resolveImageRef(tx, tenantId, ref)` prefers the tenant's own image.
- **At use.** `verifyImageForUse` re-verifies the stored signature against the signer allowlist it
  was verified with. metal's `deploy.deploy` calls it, so an unsigned image, one whose signer was
  revoked, or a tampered catalog row is never written to a disk. `allowUnsigned` is for development
  only.
- **Site caches.**
  - Pre-warm: a pool names refs in `policy.prewarmImages`, and the site agents of its site get the
    verified ones as desired state (`site.cacheImages`, `siteCacheImagesFor`). Registering or
    promoting an image invalidates the affected site agents.
  - In use: metal's `deploy.deploy` pins its image at the node's site for its workflow
    (`pinImageForWorkflow`, table `provision_image_pins` from `provision/0005_image_pins`). The
    image joins the site agents' `cacheImages`, which is the set they keep, and its location is
    never dropped or evicted. The engine calls `releaseImagePins` when the workflow ends. Each pin
    belongs to one workflow, so concurrent deploys never unpin each other.
  - `recordImageLocation` and `touchImageLocation` (which can also pin an image by hand) track what
    each site holds.
  - `imagesCachedAt(siteId)` lists the ready images at a site.
  - `evictionCandidates(siteId, bytes, inUse)` picks least-recently-used ready images, never
    pinned or in-use ones.

## The workflow engine (PLAN.md §11.2)

```ts
import { provisionModule } from 'better-compute/provision';

const provision = provisionModule({ steps: [dcgm, renderIso], profiles: [ubuntuGpuHost] });
// The host sets ModuleContext.workflows = provision.workflowEngine(context); modules then start
// workflows in their own transaction:
await context.workflows!.start(tx, { tenantId, profileId: 'ubuntu-24.04-gpu-host', profileVersion: 1, nodeId });
```

- **Expansion.** `start` pins the profile version, expands it (`expandProfile`) and persists the
  workflow with every step. Each `use:` resolves to a registered step or, when the profile says
  `on:`, to a driver operation `<concern>.<operation>` sent as a `driver.invoke` command.
  `fallback:` is used when `use:` does not resolve. Acceptance steps follow the main steps, and
  on-failure and cleanup steps are their own rows. A profile version is immutable once used.
- **Persistence.** The `provision/0001_workflows` migration creates `profiles`, `workflows` and
  `workflow_steps`. Partial unique indexes allow one active workflow and one in-flight step per
  node, so the worker that next owns the node's shard resumes a crashed workflow.
- **Execution.** The `workflow` reconciler (sharded by node) runs one transition per transaction,
  with the workflow row locked.
  - A `control-plane` step runs in the worker between two transactions, with idempotency key
    `wf:<id>:<stepId>`. A crash re-runs it. It may throw `stepNotReady(ms)` to be run again later.
  - Every other step is exactly one command. Its key is `wf:<id>:<stepId>`, then `#<attempt>` for
    retries.
  - An `await: 'rejoin'` step completes when the agent is back with a new `boot_id` or role. Its
    command's own fate is ignored, and only its timeout fails it.
- **Options.**
  - `timeout` cancels the command and fails the step.
  - `retries` re-runs the step with the next attempt.
  - `onFailure` takes one of: `fail` (the default: the rest of the main phase is cancelled,
    cleanup runs, and the workflow ends `failed`), `rescue` (the same, with `error.rescue`),
    `continue`, or a step that runs before the workflow fails.
  - `when:` is a small expression over the node's labels, e.g. `nvswitch && gpu.model=H100` or
    `!mig.capable`. A false one skips the step.
- **Verbs.**
  - `abortWorkflow` cancels the in-flight command and pending steps, runs cleanup, and ends
    `cancelled`.
  - `pauseWorkflow` lets the in-flight step finish but starts nothing new, and `resumeWorkflow`
    continues.
  - `retryWorkflow` re-arms a failed workflow from a step with the next attempt numbers.
- **Events.** It emits `workflow.created|started|succeeded|failed|cancelled|paused|resumed|retried`
  and `workflow.step.started|succeeded|failed|retrying|skipped`.
- **Built-in steps.** `wait.agentJoined` (optionally for a `role`) and `wait.generationObserved`.

API (§9.2, v0.2 rows):

- `profiles.create|get|validate|render|list|update|delete`. `validate` lists every unresolved
  `use:` and rejected `with:`, and `render` returns the expanded steps.
- `workflows.get|list|abort|retry`. These are decided on the node.

```ts
import { field, manifest } from 'better-compute/core';
import { defineProfile, defineStep } from 'better-compute/provision';

export const dcgm = defineStep({
  id: 'diag.dcgm',
  runsOn: 'ramdisk',
  timeout: '30m',
  retrySafe: true,
  input: manifest({ level: field.int({ min: 1, max: 4 }) }),
  command: 'diag.dcgm',
});

export const adopt = defineProfile({
  id: 'adopt-existing',
  version: 1,
  target: 'metal',
  entry: 'adopt',
  acceptance: [{ use: 'diag.dcgm', with: { level: 1 }, fallback: 'diag.nvml' }],
  hostConfig: { 'container-toolkit': { cdi: true } },
});
```

## `defineStep`

`defineStep(step)` returns a frozen `StepDefinition` stamped with `extension: 'step'`.

- A `control-plane` step needs `run(input, context)`. One that builds a command and relays it to an
  agent itself (`awaitCommand`) names the places in `relays` (so profiles may write `on: site`) and
  every kind it may send in `sends`. The engine refuses any other kind, so a profile's full command set
  is known before it runs: `profileCommandKinds(profile, steps)`, the approval scope of a §13 batch.
- A step that runs on a `site`, `node` or `ramdisk` agent is exactly one `command`, for example
  `driver.invoke` for driver operations. It may also set `await: 'rejoin'`.
- `input` may be any Standard Schema.
- Step ids are dotted, for example `power.setPower`.

## `defineProfile`

`defineProfile(document)` returns a deeply frozen copy. It rejects:

- unknown fields;
- malformed steps, durations or ids;
- values that are not JSON;
- fields that belong to the other target;
- an image, user data or steps on an `adopt` profile.

The `profiles.validate` method (v0.2) checks that every `use:` resolves to a registered step.

## Errors and re-exports

Errors are `ComputeError('INVALID_CONFIG')`. `details.path` names the first field that failed, for
example `steps[2].timeout`.

The contracts are declared in `@better-compute/core` and re-exported here as types:
`StepDefinition`, `StepInput`, `StepContext`, `ProfileDocument`, `ProfileStep`, `Workflow`,
`WorkflowStep`, `WorkflowEngine`, `WorkflowState` and `StepState`.

License: Apache-2.0.
