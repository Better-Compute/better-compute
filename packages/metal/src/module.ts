import { defineModule, type ComputeModule, type ReconcileContext, type Reconciler } from '@better-compute/core';
import type { ImageUseOptions } from '@better-compute/provision';
import { metalApi, type MetalApi } from './api.js';
import type { BmcDriverCapabilities } from './capabilities.js';
import { metalCommandKinds } from './commands.js';
import { metalDiscoveryStatusHandler } from './discovery.js';
import { metalFindings } from './findings.js';
import { teardownTenantMetal } from './tenancy.js';
import { metalMigrations } from './migrations.js';
import type { HardwareProfile } from './module-types.js';
import { metalProfiles } from './profiles.js';
import { metalNodeSpec } from './proxy-targets.js';
import { metalWorkKind, reconcileMetalNode } from './reconcile.js';
import { metalSteps, type AttestationVerifier } from './steps.js';

export type { HardwareProfile } from './module-types.js';

/** Options of `metal()`. */
export interface MetalOptions {
  /** Hardware profiles by name; a pool picks one with `policy.hardwareProfile`. */
  hardwareProfiles?: Record<string, HardwareProfile>;
  /** Verifies node-signed results (wipe, diagnostics); pki's verifier plugs in here (§13). */
  verifyAttestation?: AttestationVerifier;
  /**
   * Deploy-time image checks (§11.5): pass the verifier given to `provisionModule({ imageVerifier })`
   * when it is not the default allowlist. `allowUnsigned: true` is for development only.
   */
  images?: ImageUseOptions;
  /**
   * BMC drivers beyond the built-in ones (`redfish`, `ipmi`), or replacements: driver id → the BMC
   * operations it serves (`bmcOperationNames`, plus `inspect.macs` when its inspection reports the PXE
   * MACs). A verb whose workflows need an operation the node's driver lacks is refused up front
   * (`UNSUPPORTED`, reason `bmc-driver-unsupported`). Drivers in neither list are not checked in advance.
   */
  bmcDrivers?: BmcDriverCapabilities;
}

/**
 * The bare-metal module (PLAN.md §3.5, §11.1): the `metal` API group, the metal reconciler that
 * runs each provision state's workflow, the site and ramdisk command kinds, and the steps and
 * profiles those workflows use. Built on the provision workflow engine, which must know metal's
 * steps and profiles:
 *
 * ```ts
 * const bareMetal = metal({ hardwareProfiles });
 * const compute = betterCompute({ modules: [provisionModule({ modules: [bareMetal] }), bareMetal], ... });
 * ```
 */
export function metal(options: MetalOptions = {}): ComputeModule<'metal', MetalApi> {
  const hardwareProfiles = options.hardwareProfiles ?? {};
  const capabilities = { hardwareProfiles, ...(options.bmcDrivers ? { bmcDrivers: options.bmcDrivers } : {}) };
  const reconciler: Reconciler = {
    name: metalWorkKind,
    shardBy: 'node',
    async run(context: ReconcileContext, nodeId: string) {
      await reconcileMetalNode(context, nodeId, capabilities);
      return 'DONE';
    },
  };
  return Object.freeze(
    defineModule({
      name: 'metal',
      requires: ['provision'],
      migrations: [...metalMigrations],
      extensions: metalSteps({
        hardwareProfiles,
        ...(options.verifyAttestation ? { verifyAttestation: options.verifyAttestation } : {}),
        ...(options.images ? { images: options.images } : {}),
        ...(options.bmcDrivers ? { bmcDrivers: options.bmcDrivers } : {}),
      }),
      profiles: [...metalProfiles],
      commandKinds: [...metalCommandKinds],
      reconcilers: [reconciler],
      selfCheck: (context) => metalFindings(context.sql),
      // Site agents: the agentless machines site.httpProxy may reach, and nothing else.
      nodeSpec: metalNodeSpec,
      // Site agents' PXE discovery lists (StatusReport.discovered): stored, never bound (discovery.ts).
      statusHandlers: [metalDiscoveryStatusHandler()],
      // A deleted tenant's machines are retired, one legal transition per sweep, until none is left.
      async tenantDeleted(context, tenantId) {
        return (await teardownTenantMetal(context, tenantId)).remaining > 0 ? 'SYNC_AGAIN' : 'DONE';
      },
      api: () => metalApi(hardwareProfiles, options.bmcDrivers),
    }),
  );
}
