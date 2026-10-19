import {
  ComputeError,
  defineMethod,
  defineModule,
  describedBy,
  draftId,
  fleetResourceId,
  isComputeError,
  newId,
  type ComputeModule,
  type Duration,
  type Instance,
  type MethodAdmission,
  type MethodContext,
  type MethodDefinition,
  type ModuleContext,
  type Offer,
  type OfferQuery,
  type ProviderDefinition,
  type SecretResolver,
  type WorkloadIssuerPort,
} from '@better-compute/core';
import {
  checkAccountConfig,
  createAccount,
  deleteAccount,
  listAccounts,
  parseAccountBilling,
  parseCreateAccount,
  passThroughMeterCheck,
  parseTenantVaultPaths,
  ProviderClients,
  readAccount,
  sameAccountRequest,
  updateAccount,
  type AccountBilling,
  type ClientDeps,
  type CreateAccountInput,
  type ProviderAccount,
  type TenantVaultPaths,
} from './accounts.js';
import {
  createFlavor,
  deleteFlavor,
  parseFlavorInput,
  readFlavorByName,
  readFlavors,
  updateFlavor,
  type FlavorInput,
  type FlavorRecord,
} from './flavors.js';
import {
  EstimateCache,
  flavorEstimates,
  parseEstimateInstance,
  type EstimateDeps,
  type EstimateInstanceInput,
  type FlavorEstimate,
  type InstanceEstimate,
} from './estimates.js';
import { id, int, name, object, optional, tenant } from './input.js';
import { isRootCaller } from './billing.js';
import {
  billingApi,
  defaultCurrency,
  flavorMeterSpec,
  type BillingApi,
  type BillingOptions,
  type BillingProviders,
} from './pricing.js';
import {
  grantsReconciler,
  reservationGrantsApi,
  type GrantDeps,
  type ReservationGrantsApi,
} from './reservation-grants.js';
import {
  completeCreateInstance,
  deleteInstance,
  denyCreateInstance,
  assertOwnerMember,
  ownerNotMember,
  instanceSettled,
  instanceView,
  isSecretRef,
  instanceWork,
  listInstances,
  parseCreateInstance,
  parseInstanceRef,
  parseListInstances,
  parseResize,
  prepareCreateInstance,
  readInstance,
  resizeInstance,
  setPower,
  visibleVpsPool,
  type CreateInstanceInput,
  type ImageResolver,
  type CertifyHostKey,
  type InstanceDeps,
  type InstanceRef,
  type ListInstancesInput,
} from './instances.js';
import { budgetAdmissionCheck } from '@better-compute/capacity';
import { attachBudgetCheck, networkBudgetCheck } from './budget-admission.js';
import { sweepSuspendedOffers } from './budget-suspend.js';
import { instanceSpecs, reconcileInstance } from './lifecycle.js';
import {
  bootstrapWork,
  parseBootstrap,
  reconcileBootstrap,
  startBootstrap,
  type BootstrapDeps,
  type BootstrapInput,
  type BootstrapOptions,
  type ProviderBootstrap,
} from './bootstraps.js';
import {
  bindReservation,
  listProviderReservations,
  parseBindReservation,
  parseReservations,
  parseUnbindReservation,
  providerReservationsReconciler,
  unbindReservation,
  type BindReservationInput,
  type ProviderReservationView,
  type ReservationDeps,
  type ReservationsInput,
  type ReservationsOptions,
  type UnbindReservationInput,
} from './provider-reservations.js';
import {
  attachMachine,
  attachSchemas,
  detachInstance,
  parseReboot,
  rebootInstance,
  rebootSchema,
  type RebootInstanceInput,
  forgetAttach,
  parseAttach,
  prepareAttach,
  type AttachDeps,
  type AttachInstanceInput,
} from './attach.js';
import {
  discoverPoll,
  discoveryReconciler,
  discoverySchemas,
  listMachines,
  parseDiscover,
  parseListMachines,
  requestDiscovery,
  type DiscoverInput,
  type DiscoveryOptions,
  type ListMachinesInput,
  type ProviderMachineView,
} from './discovery.js';
import { costsReconciler, defaultCloseGraceHours, type CostsOptions } from './costs.js';
import { vpsMigrations } from './migrations.js';
import { builtinRuntimeTraits, type RuntimeTraits } from './runtime.js';
import {
  describeCreateInstance,
  describeCreateSandbox,
  describeExtendSandbox,
} from './describe.js';
import {
  hostReserve,
  hostResourcesWork,
  syncHostResources,
  vpsSelfCheck,
  wakeInstancesOnLostHosts,
  type HostReserve,
} from './hosts.js';
import { meterInstances } from './usage.js';
import { meterAncillaries } from './ancillary-usage.js';
import { meterIntervals } from './instance-usage.js';
import { schemas } from './schemas.js';
import {
  completeCreateSandbox,
  createTemplate,
  deleteSandbox,
  deleteTemplate,
  denyCreateSandbox,
  denyExtendSandbox,
  extendSandbox,
  getSandbox,
  getTemplate,
  listSandboxes,
  listTemplates,
  parseCreateSandbox,
  parseExtendSandbox,
  parseListSandboxes,
  parseSandboxRef,
  parseTemplateInput,
  parseTemplateRef,
  parseTemplateUpdate,
  prepareCreateSandbox,
  prepareExtendSandbox,
  budgetExtendSandboxCheck,
  reconcileSandboxes,
  sandboxSelfCheck,
  sandboxSettled,
  sandboxWork,
  templatePool,
  templateSecretRefs,
  updateTemplate,
  type CreateSandboxInput,
  type ExtendSandboxInput,
  type ListSandboxesInput,
  type Sandbox,
  type SandboxRef,
  type SandboxTemplate,
  type TemplateInput,
  type TemplateRef,
  type TemplateUpdate,
} from './sandboxes.js';
import { vpsTenantDeleted } from './tenancy.js';
import {
  createVolume,
  deleteVolume,
  finishVolumeDeletions,
  getVolume,
  hostVolumeSpecs,
  listVolumes,
  meterVolumes,
  parseCreateVolume,
  parseListVolumes,
  parseResizeVolume,
  parseVolumeRef,
  denyCreateVolume,
  prepareCreateVolume,
  prepareResizeVolume,
  releaseResizeHold,
  resizeVolume,
  templateVolumeDecisions,
  templateVolumesOf,
  volumeWork,
  type CreateVolumeInput,
  type DecidedVolume,
  type ListVolumesInput,
  type ResizeVolumeInput,
  type SandboxVolume,
  type VolumeRef,
} from './volumes.js';
import { volumeStorageSelfCheck, volumeStorageStatusHandler } from './volume-storage.js';
import {
  addSubnet,
  clearStagedNetwork,
  createNetwork,
  createRule,
  deleteNetwork,
  deleteRule,
  getNetwork,
  listNetworks,
  listRules,
  networkSchemas,
  networksReconciler,
  parseAddSubnet,
  parseCreateNetwork,
  parseCreateRule,
  parseListNetworks,
  parseNetworkRef,
  parseRemoveSubnet,
  parseRuleRef,
  parseUpdateNetwork,
  parseUpdateRule,
  prepareCreateNetwork,
  removeSubnet,
  updateNetwork,
  updateRule,
  type AddSubnetInput,
  type CreateNetworkInput,
  type CreateRuleInput,
  type FirewallRuleView,
  type ListNetworksInput,
  type NetworkDeps,
  type NetworkRef,
  type NetworkView,
  type RemoveSubnetInput,
  type RuleRef,
  type UpdateNetworkInput,
  type UpdateRuleInput,
} from './networks.js';
import {
  deleteSnapshot,
  getSnapshot,
  instanceSnapshotKind,
  listSnapshots,
  parseListSnapshots,
  parseSnapshotRef,
  parseSnapshotSandbox,
  settleSnapshots,
  snapshotSandbox,
  type ListSnapshotsInput,
  type SandboxSnapshot,
  type SnapshotRef,
  type SnapshotSandboxInput,
  type SnapshotStore,
} from './snapshots.js';

/** Options of `vps()`. */
export interface VpsOptions {
  /**
   * Runtime driver ids hosted pools run, e.g. `['libvirt-kvm', 'cloud-hypervisor']`; the first is the
   * default and a pool picks another with `policy.runtime`. A container runtime (`containerd`) is
   * single-tenant: pools that run it need `policy.singleTenant` (§13).
   */
  runtimes?: readonly string[];
  /** Traits of runtimes bcd does not build in (bcx plugins, §5.5), by id; built-ins may be overridden. */
  runtimeTraits?: Readonly<Record<string, RuntimeTraits>>;
  /** Provider definitions accounts may use (`provider-hetzner`, …). */
  providers?: readonly ProviderDefinition[];
  /** Resolves images for tenants; required for hosted pools (§3.6: compute checks visibility itself). */
  images?: ImageResolver;
  /** Resolves provider credentials; defaults to the host's secret broker. */
  secrets?: SecretResolver;
  /**
   * The `vault://` paths each tenant's provider accounts may name, by tenant id (an entry ending
   * in `/` allows every path under it). Without an entry a tenant's accounts use only
   * `secret://<tenant>/…` refs; `env://` (the control plane's environment) stays the platform's.
   */
  tenantVaultPaths?: TenantVaultPaths;
  /** What each VPS host keeps for itself (default 2 vCPU, 8 GiB, 100 GiB disk). */
  hostReserve?: Partial<HostReserve>;
  /** How often host capacity is re-derived from inventory (default `30s`). */
  hostSyncEvery?: Duration;
  /** The host bridge hosted instances' NIC attaches to (default `br0`). */
  hostNetwork?: string;
  /**
   * Platform-owned provider machines (§3.6): where the bcd a bootstrapped machine installs comes
   * from. Without it `providerAccounts.bootstrap` is INVALID_CONFIG.
   */
  bootstrap?: BootstrapOptions;
  /**
   * Provider capacity reservations: how often each account's provider is asked for its reservations
   * (default `5m`). Accounts whose provider has no `listReservations` are skipped.
   */
  reservations?: ReservationsOptions;
  /**
   * The `vps.discovery` worker (R5): how often provider accounts whose provider can `discover` are
   * listed into `provider_machines` (default `5m`), and opt-in label-driven auto-attach.
   */
  discovery?: DiscoveryOptions;
  /**
   * The `vps.costs` worker (platform compute billing, D10): how often provider accounts whose client reads costs
   * (`ProviderImpl.costs`, e.g. GCP's billing export) are read into `provider_costs` (default `6h`), how many days
   * back (default 3); costs are counted in the deployment currency (`billing.currency`).
   */
  costs?: CostsOptions;
  /**
   * Where sandbox snapshots are stored (§3.7): presigned uploads for `instance.snapshot` and the URL
   * restores fetch. Without it `sandboxes.snapshot` is INVALID_CONFIG.
   */
  snapshots?: SnapshotStore;
  /**
   * `sandboxes.exec` without an in-guest agent (§3.7): sandbox instances trust this SSH user CA (the
   * tunnels module's `sandboxSsh` CA) for `<account>@<instanceId>`, `account` default `sandbox`.
   */
  sandboxExec?: {
    caPublicKey: string;
    account?: string;
    /**
     * Certifies each sandbox guest's SSH host key with the same CA (tunnels' `sandboxSsh`
     * `issueHostCertificate`), so exec clients pin guests (`@cert-authority`) instead of trusting
     * on first use. Needs the secret broker (the private key travels in sealed user data).
     */
    certifyHostKey?: CertifyHostKey;
  };
  /** The IAM resource-type prefix (`ComputeOptions.typePrefix`, default `compute-`), for decisions vps adds. */
  typePrefix?: string;
  /** The meter catalog the root-only `billing` group manages (platform compute billing); see `BillingOptions`. */
  billing?: BillingOptions;
}

type PoolInput = { tenantId: string; poolId: string };
type FlavorRef = PoolInput & { name: string };
type AccountRef = { tenantId: string; accountId: string };

/** A provider account as the API shows it: the config holds SecretRefs only, never values. */
export type ProviderAccountView = ProviderAccount;

export type VpsApi = {
  /** Root-only: the meters and prices on the IAM root tenant (pricing.ts). */
  billing: BillingApi;
  /** Reservation grants (D7): root commits reservation slots to a tenant for a term. */
  reservationGrants: ReservationGrantsApi;
  instances: {
    create: MethodDefinition<CreateInstanceInput, Instance>;
    /** The hourly price of a flavor for the tenant, decided as reading the pool's flavors (estimates.ts). */
    estimate: MethodDefinition<EstimateInstanceInput, InstanceEstimate>;
    list: MethodDefinition<ListInstancesInput, { items: Instance[]; cursor?: string }>;
    get: MethodDefinition<InstanceRef, Instance>;
    start: MethodDefinition<InstanceRef, Instance>;
    stop: MethodDefinition<InstanceRef, Instance>;
    resize: MethodDefinition<InstanceRef & { flavor: string }, Instance>;
    delete: MethodDefinition<InstanceRef, Instance>;
    attach: MethodDefinition<AttachInstanceInput, Instance>;
    detach: MethodDefinition<InstanceRef, Instance>;
    reboot: MethodDefinition<RebootInstanceInput, Instance>;
  };
  flavors: {
    list: MethodDefinition<PoolInput, { items: (FlavorRecord & { estimate?: FlavorEstimate })[] }>;
    create: MethodDefinition<FlavorInput, FlavorRecord>;
    update: MethodDefinition<FlavorInput, FlavorRecord>;
    delete: MethodDefinition<FlavorRef, { deleted: boolean; archived: boolean }>;
  };
  providerAccounts: {
    create: MethodDefinition<CreateAccountInput, ProviderAccountView>;
    list: MethodDefinition<{ tenantId: string }, { items: ProviderAccountView[] }>;
    get: MethodDefinition<AccountRef, ProviderAccountView>;
    offers: MethodDefinition<AccountRef & { query: OfferQuery }, { items: Offer[] }>;
    update: MethodDefinition<
      AccountRef & { config: unknown; billing?: AccountBilling },
      ProviderAccountView
    >;
    delete: MethodDefinition<AccountRef, { deleted: true }>;
    bootstrap: MethodDefinition<BootstrapInput, ProviderBootstrap>;
    reservations: MethodDefinition<ReservationsInput, { items: ProviderReservationView[] }>;
    bindReservation: MethodDefinition<BindReservationInput, { poolId: string; flavorId: string }>;
    unbindReservation: MethodDefinition<UnbindReservationInput, { reservationId: string }>;
    machines: MethodDefinition<
      ListMachinesInput,
      { items: ProviderMachineView[]; cursor?: string; discoveredAt?: number }
    >;
    discover: MethodDefinition<DiscoverInput, { queued: true; discoveredAt?: number }>;
  };
  sandboxes: {
    create: MethodDefinition<CreateSandboxInput, Sandbox>;
    list: MethodDefinition<ListSandboxesInput, { items: Sandbox[]; cursor?: string }>;
    get: MethodDefinition<SandboxRef, Sandbox>;
    extend: MethodDefinition<ExtendSandboxInput, Sandbox>;
    snapshot: MethodDefinition<SnapshotSandboxInput, SandboxSnapshot>;
    delete: MethodDefinition<SandboxRef, Sandbox>;
  };
  sandboxTemplates: {
    create: MethodDefinition<TemplateInput, SandboxTemplate>;
    list: MethodDefinition<{ tenantId: string }, { items: SandboxTemplate[] }>;
    get: MethodDefinition<TemplateRef, SandboxTemplate>;
    update: MethodDefinition<TemplateUpdate, SandboxTemplate>;
    delete: MethodDefinition<TemplateRef, { deleted: true }>;
  };
  sandboxSnapshots: {
    list: MethodDefinition<ListSnapshotsInput, { items: SandboxSnapshot[]; cursor?: string }>;
    get: MethodDefinition<SnapshotRef, SandboxSnapshot>;
    delete: MethodDefinition<SnapshotRef, { deleted: true }>;
  };
  /** Agent memory: persistent volumes sandboxes attach across runs (volumes.ts). */
  sandboxVolumes: {
    create: MethodDefinition<CreateVolumeInput, SandboxVolume>;
    list: MethodDefinition<ListVolumesInput, { items: SandboxVolume[] }>;
    get: MethodDefinition<VolumeRef, SandboxVolume>;
    resize: MethodDefinition<ResizeVolumeInput, SandboxVolume>;
    delete: MethodDefinition<VolumeRef, SandboxVolume>;
  };
  /** Tenant networks (VPCs) and their subnets on a provider account (networks.ts). */
  networks: {
    create: MethodDefinition<CreateNetworkInput, NetworkView>;
    list: MethodDefinition<ListNetworksInput, { items: NetworkView[] }>;
    get: MethodDefinition<NetworkRef, NetworkView>;
    update: MethodDefinition<UpdateNetworkInput, NetworkView>;
    delete: MethodDefinition<NetworkRef, NetworkView>;
    addSubnet: MethodDefinition<AddSubnetInput, NetworkView>;
    removeSubnet: MethodDefinition<RemoveSubnetInput, NetworkView>;
  };
  firewallRules: {
    create: MethodDefinition<CreateRuleInput, FirewallRuleView>;
    list: MethodDefinition<NetworkRef, { items: FirewallRuleView[] }>;
    update: MethodDefinition<UpdateRuleInput, FirewallRuleView>;
    delete: MethodDefinition<RuleRef, FirewallRuleView>;
  };
};

function tenantResource<I extends { tenantId: string }>(input: I) {
  return { type: 'tenant', id: input.tenantId };
}
function poolResource<I extends { poolId: string }>(input: I) {
  return { type: 'pool', id: input.poolId };
}
/**
 * `flavors.create/update` and a flavor's `billing.meter` (platform compute billing, ruling F8-1): only the platform
 * adds, changes or clears one, because the meter is defined on the IAM root tenant and decides what the flavor's
 * instances are billed. The request is compared with the stored flavor, as `policy.billing` is for pools: anyone
 * may resend the stored meter or omit `billing`; any other difference from a non-root caller is `ACCESS_DENIED`,
 * before the decision. Once IAM allowed the call, and with no transaction open, the meter is created when the port
 * can (`ensureMeters`); a port that cannot accepts the flavor and `billing.meters` reports the meter missing.
 */
const flavorBillingAdmission: MethodAdmission<FlavorInput, FlavorRecord> = {
  async prepare(context, input, tx) {
    if (input.billing !== undefined) {
      // The stored meter, of a flavor in a pool this tenant owns (anything else is not compared).
      const { rows } = await tx.query<{ meter: string | null }>(
        `SELECT f.billing->>'meter' AS meter FROM flavors f JOIN pools p ON p.id = f.pool_id
          WHERE f.pool_id = $1 AND f.name = $2 AND p.owner_tenant_id = $3`,
        [input.poolId, input.name, input.tenantId],
      );
      const stored = rows[0]?.meter ?? undefined;
      if (
        input.billing.meter !== stored &&
        !isRootCaller(context.caller, (context.iam as MethodContext['iam']).rootTenantId)
      )
        throw new ComputeError(
          'ACCESS_DENIED',
          'Only the platform adds, changes or clears a flavor meter',
          undefined,
          { reason: 'flavor-meter-not-platform' },
        );
    }
    return { status: 'decide', resource: poolResource(input) };
  },
  async check(context, input) {
    const key = input.billing?.meter;
    if (key === undefined || typeof context.iam.ensureMeters !== 'function') return;
    await context.iam.ensureMeters([flavorMeterSpec(key)]);
  },
};
function instanceResource<I extends { instanceId: string }>(input: I) {
  return { type: 'instance', id: input.instanceId };
}
function accountResource<I extends { accountId: string }>(input: I) {
  return { type: 'provider-account', id: input.accountId };
}
function sandboxResource<I extends { sandboxId: string }>(input: I) {
  return { type: 'sandbox', id: input.sandboxId };
}
function templateResource<I extends { templateId: string }>(input: I) {
  return { type: 'sandbox-template', id: input.templateId };
}
function snapshotResource<I extends { snapshotId: string }>(input: I) {
  return { type: 'sandbox-snapshot', id: input.snapshotId };
}
function volumeResource<I extends { volumeId: string }>(input: I) {
  return { type: 'sandbox-volume', id: input.volumeId };
}
function networkResource<I extends { networkId: string }>(input: I) {
  return { type: 'network', id: input.networkId };
}

function parsePool(raw: unknown): PoolInput {
  const input = object(raw, ['tenantId', 'poolId']);
  return { tenantId: tenant(input.tenantId), poolId: id(input.poolId, 'pool', 'poolId') };
}
function parseAccountRef(
  raw: unknown,
  extra: readonly string[] = [],
): AccountRef & Record<string, unknown> {
  const input = object(raw, ['tenantId', 'accountId', ...extra]);
  return {
    ...input,
    tenantId: tenant(input.tenantId),
    accountId: id(input.accountId, 'pacct', 'accountId'),
  };
}
function parseOfferQuery(raw: unknown): OfferQuery {
  if (raw === undefined) return {};
  const input = object(raw, ['kind', 'region', 'gpuModel', 'minGpus', 'minVcpu', 'minMemoryGiB']);
  const query: OfferQuery = {};
  if (input.kind !== undefined) {
    if (input.kind !== 'metal' && input.kind !== 'vps')
      throw new ComputeError('INVALID_INPUT', 'kind must be metal or vps');
    query.kind = input.kind;
  }
  if (input.region !== undefined) query.region = name(input.region, 'region');
  if (input.gpuModel !== undefined) {
    if (typeof input.gpuModel !== 'string' || !/^[A-Za-z0-9-]{1,32}$/.test(input.gpuModel))
      throw new ComputeError('INVALID_INPUT', 'gpuModel is invalid');
    query.gpuModel = input.gpuModel;
  }
  const minGpus = optional(input.minGpus, (value) => int(value, 'minGpus', 0, 64));
  if (minGpus !== undefined) query.minGpus = minGpus;
  const minVcpu = optional(input.minVcpu, (value) => int(value, 'minVcpu', 0, 1024));
  if (minVcpu !== undefined) query.minVcpu = minVcpu;
  const minMemoryGiB = optional(input.minMemoryGiB, (value) =>
    int(value, 'minMemoryGiB', 0, 16_384),
  );
  if (minMemoryGiB !== undefined) query.minMemoryGiB = minMemoryGiB;
  return query;
}

/** The id `providerAccounts.create` uses: derived from the key when one is given. */
async function accountIdOf(
  context: ModuleContext & { caller?: { identityId: string } },
  input: CreateAccountInput,
): Promise<string> {
  if (input.idempotencyKey === undefined) return newId('pacct');
  if (!context.caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
  return draftId('pacct', input.tenantId, context.caller.identityId, input.idempotencyKey);
}
const noSecrets: SecretResolver = {
  resolve: async () => {
    throw new ComputeError(
      'INVALID_CONFIG',
      'No secret resolver: pass vps({ secrets }) or run a secret broker',
    );
  },
};

/**
 * The VPS module (§3.6): instances on hosted pools (placed through capacity, converged by the node's
 * runtime) and on provider pools (driven through `ProviderImpl`), flavors, provider accounts and
 * pool IPAM. Injected by the application; the server never imports it.
 *
 * ```ts
 * betterCompute({ modules: [vps({ runtimes: ['libvirt-kvm'], providers: [hetznerCloud], images })] });
 * ```
 */
export function vps(options: VpsOptions = {}): ComputeModule<'vps', VpsApi> {
  // One deployment currency (better-iam's) for proposals, estimates, provider costs and margins.
  const currency = (options.billing?.currency ?? defaultCurrency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency))
    throw new ComputeError(
      'INVALID_CONFIG',
      'vps({ billing: { currency } }) must be an ISO 4217 code such as USD',
    );
  const closeGraceHours = options.billing?.closeGraceHours ?? defaultCloseGraceHours;
  if (!Number.isFinite(closeGraceHours) || closeGraceHours < 0 || closeGraceHours > 72)
    throw new ComputeError(
      'INVALID_CONFIG',
      'vps({ billing: { closeGraceHours } }) must be a number of hours from 0 to 72',
    );
  const runtimes = options.runtimes ?? ['libvirt-kvm'];
  if (runtimes.length === 0 || !runtimes.every((runtime) => /^[a-z][a-z0-9-]{0,63}$/.test(runtime)))
    throw new ComputeError('INVALID_CONFIG', 'vps({ runtimes }) must list runtime driver ids');
  const runtimeTable = new Map<string, RuntimeTraits>();
  for (const runtime of runtimes) {
    const traits = options.runtimeTraits?.[runtime] ?? builtinRuntimeTraits[runtime];
    if (!traits)
      throw new ComputeError(
        'INVALID_CONFIG',
        `vps({ runtimes }) lists ${runtime}; give its traits in vps({ runtimeTraits })`,
      );
    runtimeTable.set(runtime, traits);
  }
  const reserve = hostReserve(options.hostReserve);
  if (options.bootstrap) {
    if (!/^https:\/\/[^\s]+$/.test(options.bootstrap.bcdUrl))
      throw new ComputeError('INVALID_CONFIG', 'vps({ bootstrap }).bcdUrl must be an https URL');
    if (!/^[0-9a-f]{64}$/.test(options.bootstrap.sha256))
      throw new ComputeError('INVALID_CONFIG', 'vps({ bootstrap }).sha256 must be a hex sha256');
    const { controlPlaneUrl } = options.bootstrap;
    if (controlPlaneUrl !== undefined && !/^https:\/\/[^\s'"%$`\\]+$/.test(controlPlaneUrl))
      throw new ComputeError(
        'INVALID_CONFIG',
        'vps({ bootstrap }).controlPlaneUrl must be an https URL without spaces, quotes, % or $',
      );
    const { pins } = options.bootstrap;
    if (
      pins !== undefined &&
      ![pins.servingCa, pins.joinSigning, pins.joinEncryption].every((pin) =>
        /^sha256\/[A-Za-z0-9+/]{43}=$/.test(pin),
      )
    )
      throw new ComputeError(
        'INVALID_CONFIG',
        'vps({ bootstrap }).pins must be sha256/<base64> SPKI pins (servingCa, joinSigning, joinEncryption)',
      );
  }
  /** The IAM root tenant, whose provider accounts are the platform's (ruling F1); betterCompute() always names it. */
  const rootOf = (context: ModuleContext): { rootTenantId?: string } => {
    const rootTenantId = (context.iam as ModuleContext['iam'] | undefined)?.rootTenantId;
    return rootTenantId !== undefined ? { rootTenantId } : {};
  };
  /** The host's workload issuer, from which provider accounts get their identity (GCP WS1). */
  const workloadOf = (context: ModuleContext): { workload?: WorkloadIssuerPort } => {
    const workload = context.pki?.workload;
    return workload ? { workload } : {};
  };
  const bootstrapDeps = (context: ModuleContext): BootstrapDeps => ({
    clock: context.clock,
    events: context.events,
    work: context.work,
    log: context.log,
    secrets: options.secrets ?? context.secrets ?? noSecrets,
    clients,
    ...rootOf(context),
    ...workloadOf(context),
    ...(context.pki ? { pki: context.pki } : {}),
    ...(options.bootstrap ? { options: options.bootstrap } : {}),
  });
  const reservationDeps = (context: ModuleContext): ReservationDeps => ({
    clock: context.clock,
    events: context.events,
    work: context.work,
    log: context.log,
    secrets: options.secrets ?? context.secrets ?? noSecrets,
    clients,
    ...rootOf(context),
    ...workloadOf(context),
  });
  /** Reservation grants (D7): the API and the `vps.grants` reconciler, which also reopens a grant's instances. */
  const grantDeps = (context: ModuleContext): GrantDeps => ({
    events: context.events,
    ...rootOf(context),
    ...(options.billing?.gpuModels ? { meterGpuModels: options.billing.gpuModels } : {}),
  });
  if (options.hostNetwork !== undefined && !/^[A-Za-z0-9_.-]{1,15}$/.test(options.hostNetwork))
    throw new ComputeError('INVALID_CONFIG', 'vps({ hostNetwork }) must be an interface name');
  const providers = new Map<string, ProviderDefinition>();
  for (const provider of options.providers ?? []) {
    if (provider?.extension !== 'provider')
      throw new ComputeError(
        'INVALID_CONFIG',
        'vps({ providers }) takes defineProvider() definitions',
      );
    if (providers.has(provider.id))
      throw new ComputeError('INVALID_CONFIG', `Provider ${provider.id} is listed twice`);
    providers.set(provider.id, provider);
  }
  const tenantVaultPaths =
    options.tenantVaultPaths !== undefined
      ? parseTenantVaultPaths(options.tenantVaultPaths)
      : undefined;
  const clients = new ProviderClients(providers, tenantVaultPaths);
  /** What `providerAccounts.create/update` check an account's config with. */
  const accountCheck = (context: ModuleContext): ClientDeps => ({
    ...depsOf(context),
    ...(tenantVaultPaths ? { tenantVaultPaths } : {}),
  });
  /**
   * The id of a `providerAccounts.create` request, drawn once per request (its parsed input), so the
   * admission check and the handler see the same account id also when no key derives it.
   */
  const requestAccountIds = new WeakMap<CreateAccountInput, string>();
  const createAccountId = async (
    context: ModuleContext & { caller?: { identityId: string } },
    input: CreateAccountInput,
  ): Promise<string> => {
    let accountId = requestAccountIds.get(input);
    if (accountId === undefined) {
      accountId = await accountIdOf(context, input);
      requestAccountIds.set(input, accountId);
    }
    return accountId;
  };
  /** `providerAccounts.create/update` admission `check`: the provider's network checks, no transaction open. */
  const accountAdmissionCheck = (
    context: MethodContext,
    input: { provider: string; config: unknown },
    account: Pick<ProviderAccount, 'id' | 'tenantId' | 'name'>,
  ): Promise<void> =>
    checkAccountConfig(
      providers,
      input,
      account,
      accountCheck(context),
      context.signal ?? new AbortController().signal,
    );
  const typePrefix = options.typePrefix ?? 'compute-';

  // --- Platform compute billing: price proposals and tenant estimates (D14, D15) ---
  /** Estimates are kept five minutes per (tenant, pool). */
  const estimateCache = new EstimateCache();
  const estimateDeps = (context: MethodContext): EstimateDeps => ({
    iam: context.iam,
    clock: context.clock,
    log: context.log,
    cache: estimateCache,
    currency,
    gpuModels: options.billing?.gpuModels,
  });
  /** The list prices of a platform provider account, read through its cached client. */
  const billingProviders: BillingProviders = {
    async listPrices(context, accountId, query) {
      const account = await readAccount(context.sql, accountId);
      const root = context.iam.rootTenantId;
      // Proposals act as the platform: a tenant's account is never read with its own credentials for root.
      if (!account || root === undefined || account.tenantId !== root)
        throw new ComputeError(
          'NOT_FOUND',
          `Provider account ${accountId} not found among the platform's accounts`,
        );
      const client = await clients.client(account, depsOf(context));
      if (typeof client.listPrices !== 'function')
        throw new ComputeError(
          'UNSUPPORTED',
          `Provider ${account.provider} does not list prices`,
          undefined,
          { provider: account.provider },
        );
      const timeout = AbortSignal.timeout(55_000);
      return client.listPrices(query, {
        idempotencyKey: `prices:${accountId}`,
        signal: context.signal ? AbortSignal.any([context.signal, timeout]) : timeout,
        clock: context.clock,
        secrets: options.secrets ?? context.secrets ?? noSecrets,
        log: context.log,
      });
    },
  };
  /**
   * A template that names secrets hands them to every sandbox's guest, which can read them: the
   * caller must also hold `compute:secrets:manage` on the tenant (secrets are write-only, §6).
   * Decided outside any transaction (admission `check`), with the caller's own credential.
   */
  const secretsCheck = async (
    context: MethodContext,
    tenantId: string,
    input: { env?: Readonly<Record<string, string>>; userData?: string | null },
  ): Promise<void> => {
    if (templateSecretRefs(input).length === 0) return;
    if (!context.credential)
      throw new ComputeError(
        'ACCESS_DENIED',
        'A sandbox template that uses secrets is decided on the caller’s own credential',
        undefined,
        { reason: 'credential-required' },
      );
    // The deployment's own prefix (betterCompute() sets it), else vps({ typePrefix }).
    const prefix = context.typePrefix ?? typePrefix;
    await context.iam.require(context.credential, {
      tenantId,
      action: 'compute:secrets:manage',
      resource: { type: `${prefix}tenant`, id: tenantId },
    });
    // Fleet secrets (BMC credentials of shared sites) live in the root tenant too, with nothing in
    // `secret_refs` telling them apart: there, naming any secret takes the fleet's own decision.
    if (context.iam.rootTenantId !== undefined && tenantId === context.iam.rootTenantId)
      await context.iam.require(context.credential, {
        tenantId,
        action: 'compute:secrets:manage',
        resource: { type: `${prefix}fleet`, id: fleetResourceId },
      });
  };
  /**
   * User data given as a secret ref hands that secret to the guest, which reads it: the caller must
   * also hold `compute:secrets:manage` on the tenant (and on the fleet in the root tenant, whose
   * store also holds fleet secrets). Decided outside any transaction, on the caller's credential.
   */
  const userDataSecretCheck = async (context: MethodContext, tenantId: string): Promise<void> => {
    if (!context.credential)
      throw new ComputeError(
        'ACCESS_DENIED',
        'An instance whose user data is a secret is decided on the caller’s own credential',
        undefined,
        { reason: 'credential-required' },
      );
    const prefix = context.typePrefix ?? typePrefix;
    await context.iam.require(context.credential, {
      tenantId,
      action: 'compute:secrets:manage',
      resource: { type: `${prefix}tenant`, id: tenantId },
    });
    if (context.iam.rootTenantId !== undefined && tenantId === context.iam.rootTenantId)
      await context.iam.require(context.credential, {
        tenantId,
        action: 'compute:secrets:manage',
        resource: { type: `${prefix}fleet`, id: fleetResourceId },
      });
  };
  /**
   * A template hands its volumes to every sandbox it starts, whose guest reads (and unless read-only
   * writes) them: each volume is decided on its own IAM resource with the caller's credential, as
   * `compute:sandboxes:manage` (read-write) or `compute:sandboxes:read` (read-only), not only the
   * template (review 2, MED 1). Outside any transaction; returns what was decided, which the handler
   * holds the resolved list to.
   */
  const volumesCheck = async (
    context: MethodContext,
    tenantId: string,
    volumes: readonly { volumeId?: string; name?: string; readOnly?: boolean }[],
  ): Promise<DecidedVolume[]> => {
    if (volumes.length === 0) return [];
    if (!context.credential)
      throw new ComputeError(
        'ACCESS_DENIED',
        'A sandbox template that mounts volumes is decided on the caller’s own credential',
        undefined,
        { reason: 'credential-required' },
      );
    const prefix = context.typePrefix ?? typePrefix;
    const decided = await templateVolumeDecisions(context.sql, tenantId, volumes);
    for (const volume of decided)
      await context.iam.require(context.credential, {
        tenantId,
        action: volume.write ? 'compute:sandboxes:manage' : 'compute:sandboxes:read',
        resource: { type: `${prefix}sandbox-volume`, id: volume.volumeId },
      });
    return decided;
  };
  /**
   * An update that changes what the guest runs (image, flavor, user data, env, network) hands the
   * template's secrets to new code, even when it names none itself: decided on the resulting
   * template's secrets. Read outside any transaction (this is the admission `check`). Its volumes
   * likewise: a new list, or the current one when new code inherits it, is decided volume by volume.
   */
  const templateUpdateSecretsCheck = async (
    context: MethodContext,
    input: TemplateUpdate,
  ): Promise<void> => {
    const reshapes =
      input.flavor !== undefined ||
      input.imageId !== undefined ||
      input.userData !== undefined ||
      input.env !== undefined ||
      input.network !== undefined;
    if (!reshapes && input.volumes === undefined) return;
    const { rows } = await context.sql.query<{
      env: Record<string, string> | string;
      user_data: string | null;
      volumes: unknown;
    }>(`SELECT env, user_data, volumes FROM sandbox_templates WHERE id = $1 AND tenant_id = $2`, [
      input.templateId,
      input.tenantId,
    ]);
    const current = rows[0];
    if (!current) return;
    input.decidedVolumes = await volumesCheck(
      context,
      input.tenantId,
      input.volumes ?? templateVolumesOf(current.volumes),
    );
    if (!reshapes) return;
    const env = typeof current.env === 'string' ? JSON.parse(current.env) : current.env;
    const resulting = {
      env: input.env ?? env,
      userData: input.userData === undefined ? current.user_data : input.userData,
    };
    await secretsCheck(context, input.tenantId, resulting);
    // What this decision covered: the handler refuses secrets added since (read under its lock).
    input.decidedSecrets = templateSecretRefs(resulting);
  };
  let sandboxExec: InstanceDeps['sandboxExec'];
  if (options.sandboxExec) {
    const { caPublicKey, account = 'sandbox', certifyHostKey } = options.sandboxExec;
    // Written into every sandbox's sshd config: one printable OpenSSH key line, nothing else.
    if (
      typeof caPublicKey !== 'string' ||
      // pki's rule: a comment may hold spaces (`<org> sandbox ssh ca`), never a line break.
      !/^(ssh-ed25519|ecdsa-sha2-nistp256) [A-Za-z0-9+/]+={0,2}( [\x21-\x7e][\x20-\x7e]{0,63})?$/.test(
        caPublicKey,
      )
    )
      throw new ComputeError(
        'INVALID_CONFIG',
        'vps({ sandboxExec }).caPublicKey must be one OpenSSH ed25519 or ecdsa-p256 key line',
      );
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(account))
      throw new ComputeError(
        'INVALID_CONFIG',
        'vps({ sandboxExec }).account must be a Unix account name',
      );
    if (certifyHostKey !== undefined && typeof certifyHostKey !== 'function')
      throw new ComputeError(
        'INVALID_CONFIG',
        'vps({ sandboxExec }).certifyHostKey must be a function',
      );
    sandboxExec = { caPublicKey, account, ...(certifyHostKey ? { certifyHostKey } : {}) };
  }

  // Warm pools ask a tenant's budget at most once a minute: a drain offer with warm instances
  // would otherwise cost an IAM call every 15 s pass. (IAM caches budget standing briefly too.)
  const warmBudgets = new Map<string, { at: number; allowed: boolean }>();
  const warmBudget = async (context: ModuleContext, tenantId: string): Promise<boolean> => {
    const now = context.clock.now();
    const known = warmBudgets.get(tenantId);
    if (known && now - known.at < 60_000) return known.allowed;
    const { allowed } = await context.iam.billingCheck({ tenantId });
    warmBudgets.set(tenantId, { at: now, allowed });
    return allowed;
  };

  const networkDeps = (context: ModuleContext): NetworkDeps => ({
    clock: context.clock,
    events: context.events,
    work: context.work,
    authz: context.authz,
    log: context.log,
    secrets: options.secrets ?? context.secrets ?? noSecrets,
    clients,
    ...rootOf(context),
    ...workloadOf(context),
  });

  const depsOf = (context: ModuleContext): InstanceDeps => {
    const deps: InstanceDeps = {
      clock: context.clock,
      events: context.events,
      work: context.work,
      authz: context.authz,
      desired: context.desired,
      capacity: context.capacity,
      log: context.log,
      secrets: options.secrets ?? context.secrets ?? noSecrets,
      clients,
      ...rootOf(context),
      ...workloadOf(context),
      runtime: runtimes[0]!,
      runtimes: runtimeTable,
    };
    if (typeof context.secrets?.put === 'function') deps.broker = context.secrets;
    if (options.images) deps.images = options.images;
    if (sandboxExec) deps.sandboxExec = sandboxExec;
    if (options.billing?.gpuModels) deps.meterGpuModels = options.billing.gpuModels;
    return deps;
  };

  const attachDeps = (context: ModuleContext): AttachDeps => {
    const deps = depsOf(context);
    return {
      events: deps.events,
      work: deps.work,
      authz: deps.authz,
      runtime: deps.runtime,
      ...(context.iam.rootTenantId !== undefined ? { rootTenantId: context.iam.rootTenantId } : {}),
    };
  };

  const api = (): VpsApi => ({
    billing: billingApi({ ...options.billing, currency }, billingProviders),
    reservationGrants: reservationGrantsApi(grantDeps),
    instances: {
      create: defineMethod<CreateInstanceInput, Instance>({
        action: 'compute:instances:create',
        kind: 'mutation',
        // The envelope decides on the draft `prepare` returns.
        resource: (input) => ({ type: 'instance', id: `draft:${input.idempotencyKey}` }),
        validate: describedBy(schemas.createInstance, parseCreateInstance),
        admission: {
          prepare: (context, input, tx) =>
            prepareCreateInstance(depsOf(context), context, input, tx),
          describe: (input) => describeCreateInstance(input),
          denied: (context, input, tx) => denyCreateInstance(context, input, tx),
          // An owner refused as no member of the tenant (R2) leaves no draft of theirs; other
          // refusals of the check (budgets) keep the draft, so the same key can succeed later.
          abandoned: async (context, input, tx, error) => {
            if (isComputeError(error) && error.details?.reason === ownerNotMember)
              await denyCreateInstance(context, input, tx);
          },
          // A pool's budget policy (stop-new/drain offers, `budgetCheck: 'meter'`) covers
          // instances as it covers reservations: SPEND_LIMIT_REACHED, with the draft kept.
          check: async (context, input) => {
            await assertOwnerMember(context, input);
            if (isSecretRef(input.userData)) await userDataSecretCheck(context, input.tenantId);
            await budgetAdmissionCheck(context, input.tenantId, input.poolId);
          },
        },
        handler: (context, input) => completeCreateInstance(depsOf(context), context, input),
        // §9.1 async-with-wait: `wait` holds the answer until the instance is placed and started
        // (or failed), refreshed from its row.
        poll: {
          done: instanceSettled,
          refresh: async (context, input, output) => {
            const row = await readInstance(context.sql, output.id, { tenantId: input.tenantId });
            return row && !row.draft ? instanceView(row) : output;
          },
        },
      }),
      // (D15) What one hour of a flavor would cost the tenant: decided as reading the pool's flavors, so a principal
      // that may only see flavors can ask. Nothing is created, drafted, charged or projected for authz.
      estimate: defineMethod<EstimateInstanceInput, InstanceEstimate>({
        action: 'compute:flavors:read',
        kind: 'read',
        // The estimate asks IAM to quote, which never happens inside a compute transaction.
        transaction: 'manual',
        resource: poolResource,
        validate: describedBy(schemas.estimateInstance, parseEstimateInstance),
        handler: async (context, input) => {
          await visibleVpsPool(context.sql, input.tenantId, input.poolId);
          const flavor = await readFlavorByName(context.sql, input.poolId, input.flavor);
          if (!flavor || flavor.archived)
            throw new ComputeError(
              'NOT_FOUND',
              `Flavor ${input.flavor} not found in pool ${input.poolId}`,
            );
          const estimates = await flavorEstimates(
            estimateDeps(context),
            context.sql,
            input.tenantId,
            input.poolId,
            [flavor],
          );
          const estimate = estimates.get(flavor.id);
          return estimate ? { estimate } : {};
        },
      }),
      list: defineMethod({
        action: 'compute:instances:read',
        kind: 'read',
        resource: tenantResource,
        validate: describedBy(schemas.listInstances, parseListInstances),
        handler: (context, input) => listInstances(context.sql, input, context.caller?.identityId),
      }),
      get: defineMethod({
        action: 'compute:instances:read',
        kind: 'read',
        resource: instanceResource,
        validate: describedBy(schemas.instance, parseInstanceRef),
        handler: async (context, input) => {
          const row = await readInstance(context.sql, input.instanceId, {
            tenantId: input.tenantId,
          });
          if (!row || row.draft)
            throw new ComputeError('NOT_FOUND', `Instance ${input.instanceId} not found`);
          return instanceView(row);
        },
      }),
      start: defineMethod({
        action: 'compute:instances:update',
        kind: 'mutation',
        resource: instanceResource,
        validate: describedBy(schemas.instance, parseInstanceRef),
        handler: (context, input) => setPower(depsOf(context), context.sql, input, 'running'),
      }),
      stop: defineMethod({
        action: 'compute:instances:update',
        kind: 'mutation',
        resource: instanceResource,
        validate: describedBy(schemas.instance, parseInstanceRef),
        handler: (context, input) => setPower(depsOf(context), context.sql, input, 'stopped'),
      }),
      resize: defineMethod({
        action: 'compute:instances:update',
        kind: 'mutation',
        resource: instanceResource,
        validate: describedBy(schemas.resizeInstance, parseResize),
        handler: (context, input) => resizeInstance(depsOf(context), context.sql, input),
      }),
      delete: defineMethod({
        action: 'compute:instances:delete',
        kind: 'mutation',
        resource: instanceResource,
        validate: describedBy(schemas.instance, parseInstanceRef),
        handler: (context, input) => deleteInstance(depsOf(context), context.sql, input),
      }),
      // R1: a provider machine that already runs becomes a tenant's instance (decided on its id).
      attach: defineMethod<AttachInstanceInput, Instance>({
        action: 'compute:instances:attach',
        kind: 'mutation',
        resource: (input) => ({ type: 'instance', id: `draft:${input.idempotencyKey}` }),
        validate: describedBy(attachSchemas.attach, parseAttach),
        admission: {
          prepare: (context, input, tx) =>
            prepareAttach(context, input, tx, context.iam.rootTenantId),
          // R2: another owner must be an active identity of the tenant (outside transactions). Then the budget:
          // the offer's refusals, and the tenant's budget when the attached machine is billed (D16).
          check: async (context, input) => {
            await assertOwnerMember(context, input);
            await attachBudgetCheck(context, input);
          },
          denied: (context, input, tx) => forgetAttach(context, input, tx),
          abandoned: (context, input, tx) => forgetAttach(context, input, tx),
        },
        // The machine is expected in the pool's own provider account.
        handler: async (context, input) => {
          const pool = await visibleVpsPool(context.sql, input.tenantId, input.poolId);
          return attachMachine(context.sql, attachDeps(context), {
            ...input,
            caller: context.caller!,
            accountId: pool.providerAccountId ?? '',
          });
        },
      }),
      // D6: an attached instance goes, its machine stays (label released, quota refunded).
      detach: defineMethod({
        action: 'compute:instances:delete',
        kind: 'mutation',
        resource: instanceResource,
        validate: describedBy(schemas.instance, parseInstanceRef),
        handler: (context, input) => detachInstance(depsOf(context), context.sql, input),
      }),
      // R3: a restart (or reset) of a provider instance's machine, done once by the reconciler.
      reboot: defineMethod({
        action: 'compute:instances:update',
        kind: 'mutation',
        resource: instanceResource,
        validate: describedBy(rebootSchema, parseReboot),
        handler: (context, input) => rebootInstance(depsOf(context), context.sql, input),
      }),
    },
    flavors: {
      list: defineMethod({
        action: 'compute:flavors:read',
        kind: 'read',
        // Estimates ask IAM to quote, which never happens inside a compute transaction.
        transaction: 'manual',
        resource: poolResource,
        validate: describedBy(schemas.pool, parsePool),
        handler: async (context, input) => {
          const visible = await context.sql.query(
            `SELECT 1 FROM pools p WHERE p.id = $1 AND (p.owner_tenant_id = $2
               OR EXISTS (SELECT 1 FROM pool_offers o WHERE o.pool_id = p.id AND o.tenant_id = $2))`,
            [input.poolId, input.tenantId],
          );
          if (visible.rows.length === 0)
            throw new ComputeError('NOT_FOUND', `Pool ${input.poolId} not found`);
          const flavors = await readFlavors(context.sql, input.poolId);
          const estimates = await flavorEstimates(
            estimateDeps(context),
            context.sql,
            input.tenantId,
            input.poolId,
            flavors,
          );
          return {
            items: flavors.map((flavor) => {
              const estimate = estimates.get(flavor.id);
              return estimate ? { ...flavor, estimate } : flavor;
            }),
          };
        },
      }),
      create: defineMethod<FlavorInput, FlavorRecord>({
        action: 'compute:flavors:manage',
        kind: 'mutation',
        resource: poolResource,
        validate: describedBy(schemas.flavor, parseFlavorInput),
        admission: flavorBillingAdmission,
        handler: (context, input) => createFlavor(context.sql, input),
      }),
      update: defineMethod<FlavorInput, FlavorRecord>({
        action: 'compute:flavors:manage',
        kind: 'mutation',
        resource: poolResource,
        validate: describedBy(schemas.flavor, parseFlavorInput),
        admission: flavorBillingAdmission,
        handler: (context, input) => updateFlavor(context.sql, input),
      }),
      delete: defineMethod({
        action: 'compute:flavors:manage',
        kind: 'mutation',
        resource: poolResource,
        validate: describedBy(schemas.deleteFlavor, (raw) => {
          const input = object(raw, ['tenantId', 'poolId', 'name']);
          return {
            tenantId: tenant(input.tenantId),
            poolId: id(input.poolId, 'pool', 'poolId'),
            name: name(input.name),
          };
        }),
        handler: (context, input) => deleteFlavor(context.sql, input),
      }),
    },
    providerAccounts: {
      create: defineMethod({
        action: 'compute:providers:manage',
        kind: 'mutation',
        resource: tenantResource,
        validate: describedBy(schemas.createAccount, parseCreateAccount),
        // With an idempotency key, a finished request replays without a second decision.
        admission: {
          async prepare(context, input, tx) {
            const decide = { status: 'decide' as const, resource: tenantResource(input) };
            if (input.idempotencyKey === undefined) return decide;
            const existing = await readAccount(
              tx,
              await createAccountId(context, input),
              input.tenantId,
            );
            if (!existing) return decide;
            if (!sameAccountRequest(existing, input))
              throw new ComputeError(
                'CONFLICT',
                'This idempotency key was used for a different request',
              );
            return { status: 'replay', result: existing };
          },
          // The provider's network checks, before the account exists and with no transaction
          // open; a refusal stores nothing, so a retry with the same key decides again.
          check: async (context, input) => {
            await accountAdmissionCheck(context, input, {
              id: await createAccountId(context, input),
              tenantId: input.tenantId,
              name: input.name,
            });
            // D11: each pass-through meter is a reported meter on the root tenant (an IAM read).
            await passThroughMeterCheck(context.iam, input.billing);
          },
        },
        handler: async (context, input) => {
          const account = await createAccount(
            context.sql,
            providers,
            input,
            await createAccountId(context, input),
            accountCheck(context),
          );
          await context.authz.upsert(context.sql, {
            type: 'provider-account',
            id: account.id,
            tenantId: account.tenantId,
            attributes: { provider: account.provider },
          });
          return account;
        },
      }),
      list: defineMethod({
        action: 'compute:providers:read',
        kind: 'read',
        resource: tenantResource,
        validate: describedBy(schemas.tenant, (raw) => ({
          tenantId: tenant(object(raw, ['tenantId']).tenantId),
        })),
        handler: async (context, input) => ({
          items: await listAccounts(context.sql, input.tenantId),
        }),
      }),
      get: defineMethod({
        action: 'compute:providers:read',
        kind: 'read',
        resource: accountResource,
        validate: describedBy(schemas.account, (raw) => parseAccountRef(raw) as AccountRef),
        handler: async (context, input) => {
          const account = await readAccount(context.sql, input.accountId, input.tenantId);
          if (!account)
            throw new ComputeError('NOT_FOUND', `Provider account ${input.accountId} not found`);
          return account;
        },
      }),
      offers: defineMethod({
        action: 'compute:providers:read',
        kind: 'read',
        resource: accountResource,
        validate: describedBy(schemas.accountOffers, (raw) => {
          const input = parseAccountRef(raw, ['query']);
          return {
            tenantId: input.tenantId,
            accountId: input.accountId,
            query: parseOfferQuery(input.query),
          };
        }),
        handler: async (context, input) => {
          const account = await readAccount(context.sql, input.accountId, input.tenantId);
          if (!account)
            throw new ComputeError('NOT_FOUND', `Provider account ${input.accountId} not found`);
          const client = await clients.client(account, depsOf(context));
          return { items: await client.listOffers(input.query) };
        },
      }),
      update: defineMethod({
        action: 'compute:providers:manage',
        kind: 'mutation',
        resource: accountResource,
        validate: describedBy(schemas.updateAccount, (raw) => {
          const input = parseAccountRef(raw, ['config', 'billing']);
          return {
            tenantId: input.tenantId,
            accountId: input.accountId,
            config: input.config,
            ...(input.billing !== undefined ? { billing: parseAccountBilling(input.billing) } : {}),
          };
        }),
        admission: {
          prepare: async (_context, input) => ({
            status: 'decide' as const,
            resource: accountResource(input),
          }),
          // As create's: the new config, checked by the provider for the stored account (its
          // name and provider come from the row), with no transaction open.
          check: async (context, input) => {
            const account = await readAccount(context.sql, input.accountId, input.tenantId);
            if (!account)
              throw new ComputeError('NOT_FOUND', `Provider account ${input.accountId} not found`);
            await accountAdmissionCheck(
              context,
              { provider: account.provider, config: input.config },
              account,
            );
            await passThroughMeterCheck(context.iam, input.billing);
          },
        },
        handler: (context, input) =>
          updateAccount(context.sql, providers, input, accountCheck(context)),
      }),
      delete: defineMethod({
        action: 'compute:providers:manage',
        kind: 'mutation',
        resource: accountResource,
        validate: describedBy(schemas.account, (raw) => parseAccountRef(raw) as AccountRef),
        handler: async (context, input) => {
          await deleteAccount(context.sql, input);
          await context.authz.remove(context.sql, {
            type: 'provider-account',
            id: input.accountId,
          });
          return { deleted: true as const };
        },
      }),
      bootstrap: defineMethod({
        action: 'compute:providers:manage',
        kind: 'mutation',
        resource: accountResource,
        validate: describedBy(schemas.bootstrap, parseBootstrap),
        handler: (context, input) => startBootstrap(bootstrapDeps(context), context, input),
      }),
      reservations: defineMethod({
        action: 'compute:providers:read',
        kind: 'read',
        resource: accountResource,
        validate: describedBy(schemas.reservations, parseReservations),
        handler: (context, input) => listProviderReservations(context.sql, input),
      }),
      bindReservation: defineMethod({
        action: 'compute:providers:manage',
        kind: 'mutation',
        resource: accountResource,
        validate: describedBy(schemas.bindReservation, parseBindReservation),
        handler: (context, input) => bindReservation(context.sql, input),
      }),
      unbindReservation: defineMethod({
        action: 'compute:providers:manage',
        kind: 'mutation',
        resource: accountResource,
        validate: describedBy(schemas.unbindReservation, parseUnbindReservation),
        handler: (context, input) => unbindReservation(context.sql, input),
      }),
      // R5: what the vps.discovery worker last saw in the account.
      machines: defineMethod({
        action: 'compute:providers:read',
        kind: 'read',
        resource: accountResource,
        validate: describedBy(discoverySchemas.listMachines, parseListMachines),
        handler: (context, input) =>
          listMachines(context.sql, input, {
            platform:
              context.iam.rootTenantId !== undefined &&
              context.caller?.tenantId === context.iam.rootTenantId,
          }),
      }),
      discover: defineMethod({
        action: 'compute:providers:manage',
        kind: 'mutation',
        resource: accountResource,
        validate: describedBy(discoverySchemas.discover, parseDiscover),
        handler: (context, input) => requestDiscovery(depsOf(context), context.sql, input),
        poll: discoverPoll,
      }),
    },
    // §3.7 (D24): a sandbox drives one hosted instance; templates are per tenant.
    sandboxes: {
      create: defineMethod<CreateSandboxInput, Sandbox>({
        action: 'compute:sandboxes:create',
        kind: 'mutation',
        // The envelope decides on the draft `prepare` returns.
        resource: (input) => ({ type: 'sandbox', id: `draft:${input.idempotencyKey}` }),
        validate: describedBy(schemas.createSandbox, parseCreateSandbox),
        admission: {
          prepare: (context, input, tx) =>
            prepareCreateSandbox(depsOf(context), context, input, tx),
          describe: (input) => describeCreateSandbox(input),
          denied: (context, input, tx) => denyCreateSandbox(depsOf(context), context, input, tx),
          check: async (context, input) => {
            const poolId = await templatePool(context.sql, input);
            if (poolId !== undefined) await budgetAdmissionCheck(context, input.tenantId, poolId);
          },
        },
        handler: (context, input) => completeCreateSandbox(depsOf(context), context, input),
        poll: {
          done: sandboxSettled,
          refresh: (context, input, output) =>
            getSandbox(context.sql, { tenantId: input.tenantId, sandboxId: output.id }),
        },
      }),
      list: defineMethod({
        action: 'compute:sandboxes:read',
        kind: 'read',
        resource: tenantResource,
        validate: describedBy(schemas.listSandboxes, parseListSandboxes),
        handler: (context, input) => listSandboxes(context.sql, input, context.caller?.identityId),
      }),
      get: defineMethod({
        action: 'compute:sandboxes:read',
        kind: 'read',
        resource: sandboxResource,
        validate: describedBy(schemas.sandbox, parseSandboxRef),
        handler: (context, input) => getSandbox(context.sql, input),
      }),
      extend: defineMethod<ExtendSandboxInput, Sandbox>({
        action: 'compute:sandboxes:update',
        kind: 'mutation',
        resource: sandboxResource,
        validate: describedBy(schemas.extendSandbox, parseExtendSandbox),
        admission: {
          prepare: (context, input, tx) => prepareExtendSandbox(context, input, tx),
          describe: (input) => describeExtendSandbox(input),
          denied: (context, input, tx) => denyExtendSandbox(context, input, tx),
          check: (context, input) => budgetExtendSandboxCheck(context, input),
          // Transaction 2 threw (the sandbox or its template changed in between): its own
          // clearing rolled back.
          abandoned: (context, input, tx) => denyExtendSandbox(context, input, tx),
        },
        handler: (context, input) => extendSandbox(depsOf(context), context, input),
      }),
      snapshot: defineMethod({
        action: 'compute:sandboxes:update',
        kind: 'mutation',
        resource: sandboxResource,
        validate: describedBy(schemas.snapshotSandbox, parseSnapshotSandbox),
        handler: (context, input) =>
          snapshotSandbox(depsOf(context), options.snapshots, context, input),
      }),
      delete: defineMethod({
        action: 'compute:sandboxes:delete',
        kind: 'mutation',
        resource: sandboxResource,
        validate: describedBy(schemas.sandbox, parseSandboxRef),
        handler: (context, input) => deleteSandbox(depsOf(context), context.sql, input),
      }),
    },
    sandboxTemplates: {
      create: defineMethod({
        action: 'compute:sandboxes:manage',
        kind: 'mutation',
        resource: tenantResource,
        validate: describedBy(schemas.createTemplate, parseTemplateInput),
        admission: {
          prepare: async (_context, input) => ({
            status: 'decide',
            resource: tenantResource(input),
          }),
          check: async (context, input) => {
            await secretsCheck(context, input.tenantId, input);
            input.decidedVolumes = await volumesCheck(context, input.tenantId, input.volumes ?? []);
          },
        },
        handler: (context, input) => createTemplate(depsOf(context), context, input),
      }),
      list: defineMethod({
        action: 'compute:sandboxes:read',
        kind: 'read',
        resource: tenantResource,
        validate: describedBy(schemas.tenant, (raw) => ({
          tenantId: tenant(object(raw, ['tenantId']).tenantId),
        })),
        handler: (context, input) => listTemplates(context.sql, input.tenantId),
      }),
      get: defineMethod({
        action: 'compute:sandboxes:read',
        kind: 'read',
        resource: templateResource,
        validate: describedBy(schemas.template, parseTemplateRef),
        handler: (context, input) => getTemplate(context.sql, input),
      }),
      update: defineMethod({
        action: 'compute:sandboxes:manage',
        kind: 'mutation',
        resource: templateResource,
        validate: describedBy(schemas.updateTemplate, parseTemplateUpdate),
        admission: {
          prepare: async (_context, input) => ({
            status: 'decide',
            resource: templateResource(input),
          }),
          check: (context, input) => templateUpdateSecretsCheck(context, input),
        },
        handler: (context, input) => updateTemplate(depsOf(context), context.sql, input),
      }),
      delete: defineMethod({
        action: 'compute:sandboxes:manage',
        kind: 'mutation',
        resource: templateResource,
        validate: describedBy(schemas.template, parseTemplateRef),
        handler: (context, input) => deleteTemplate(depsOf(context), context.sql, input),
      }),
    },
    // Snapshots are their own resource: a kept one outlives its sandbox (§3.7).
    sandboxSnapshots: {
      list: defineMethod({
        action: 'compute:sandboxes:read',
        kind: 'read',
        resource: tenantResource,
        validate: describedBy(schemas.listSnapshots, parseListSnapshots),
        handler: (context, input) => listSnapshots(context.sql, input, context.caller?.identityId),
      }),
      get: defineMethod({
        action: 'compute:sandboxes:read',
        kind: 'read',
        resource: snapshotResource,
        validate: describedBy(schemas.snapshot, parseSnapshotRef),
        handler: (context, input) => getSnapshot(context.sql, input),
      }),
      delete: defineMethod({
        action: 'compute:sandboxes:delete',
        kind: 'mutation',
        resource: snapshotResource,
        validate: describedBy(schemas.snapshot, parseSnapshotRef),
        handler: (context, input) => deleteSnapshot(depsOf(context), context.sql, input),
      }),
    },
    sandboxVolumes: {
      create: defineMethod({
        action: 'compute:sandboxes:manage',
        kind: 'mutation',
        // The envelope decides on the volume `prepare` returns.
        resource: (input: CreateVolumeInput) => ({
          type: 'sandbox-volume',
          id: `draft:${input.idempotencyKey}`,
        }),
        validate: describedBy(schemas.createVolume, parseCreateVolume),
        // Decided on the volume, whose projection row carries the requested size (review 2, LOW 3).
        admission: {
          prepare: (context, input, tx) => prepareCreateVolume(context, input, tx),
          denied: (context, input, tx) => denyCreateVolume(context, input, tx),
        },
        handler: (context, input) => createVolume(depsOf(context), context, input),
      }),
      list: defineMethod({
        action: 'compute:sandboxes:read',
        kind: 'read',
        resource: tenantResource,
        validate: describedBy(schemas.listVolumes, parseListVolumes),
        handler: (context, input) => listVolumes(context.sql, input, context.caller?.identityId),
      }),
      get: defineMethod({
        action: 'compute:sandboxes:read',
        kind: 'read',
        resource: volumeResource,
        validate: describedBy(schemas.volume, parseVolumeRef),
        handler: (context, input) => getVolume(context.sql, input),
      }),
      resize: defineMethod({
        action: 'compute:sandboxes:manage',
        kind: 'mutation',
        resource: volumeResource,
        validate: describedBy(schemas.resizeVolume, parseResizeVolume),
        // The new size is decided as the volume's pending sizeGiB, as sandboxes.extend decides a lifetime.
        admission: {
          prepare: (context, input, tx) => prepareResizeVolume(context, input, tx),
          denied: async (context, input, tx) => {
            await releaseResizeHold(context.authz, tx, input);
          },
          // Transaction 2 threw (CAPACITY_UNAVAILABLE, QUOTA_EXCEEDED): its own clearing rolled back.
          abandoned: async (context, input, tx) => {
            await releaseResizeHold(context.authz, tx, input);
          },
        },
        handler: (context, input) => resizeVolume(depsOf(context), context.sql, input),
      }),
      delete: defineMethod({
        action: 'compute:sandboxes:manage',
        kind: 'mutation',
        resource: volumeResource,
        validate: describedBy(schemas.volume, parseVolumeRef),
        handler: (context, input) => deleteVolume(depsOf(context), context.sql, input),
      }),
    },
    networks: {
      create: defineMethod({
        action: 'compute:networks:create',
        kind: 'mutation',
        // The envelope decides on the network `prepare` returns.
        resource: (input: CreateNetworkInput) => ({
          type: 'network',
          id: `draft:${input.idempotencyKey}`,
        }),
        validate: describedBy(networkSchemas.createNetwork, parseCreateNetwork),
        admission: {
          prepare: (context, input, tx) =>
            prepareCreateNetwork(networkDeps(context), context, input, tx),
          denied: (context, input, tx) => clearStagedNetwork(context, input, tx),
          // Transaction 2 threw (CONFLICT on the name, UNSUPPORTED): the staged projection row goes.
          abandoned: (context, input, tx) => clearStagedNetwork(context, input, tx),
          // A metered pool's networks are billed: the tenant's budget (D16). A refusal leaves nothing staged (`abandoned` clears the projection row).
          check: (context, input) => networkBudgetCheck(context, input),
        },
        handler: (context, input) => createNetwork(networkDeps(context), context, input),
      }),
      list: defineMethod({
        action: 'compute:networks:read',
        kind: 'read',
        resource: tenantResource,
        validate: describedBy(networkSchemas.listNetworks, parseListNetworks),
        handler: (context, input) => listNetworks(context.sql, input),
      }),
      get: defineMethod({
        action: 'compute:networks:read',
        kind: 'read',
        resource: networkResource,
        validate: describedBy(networkSchemas.network, parseNetworkRef),
        handler: (context, input) => getNetwork(context.sql, input),
      }),
      update: defineMethod({
        action: 'compute:networks:update',
        kind: 'mutation',
        resource: networkResource,
        validate: describedBy(networkSchemas.updateNetwork, parseUpdateNetwork),
        handler: (context, input) => updateNetwork(context.sql, input),
      }),
      delete: defineMethod({
        action: 'compute:networks:delete',
        kind: 'mutation',
        resource: networkResource,
        validate: describedBy(networkSchemas.network, parseNetworkRef),
        handler: (context, input) => deleteNetwork(networkDeps(context), context.sql, input),
      }),
      addSubnet: defineMethod({
        action: 'compute:networks:update',
        kind: 'mutation',
        resource: networkResource,
        validate: describedBy(networkSchemas.addSubnet, parseAddSubnet),
        handler: (context, input) => addSubnet(networkDeps(context), context.sql, input),
      }),
      removeSubnet: defineMethod({
        action: 'compute:networks:update',
        kind: 'mutation',
        resource: networkResource,
        validate: describedBy(networkSchemas.removeSubnet, parseRemoveSubnet),
        handler: (context, input) => removeSubnet(networkDeps(context), context.sql, input),
      }),
    },
    firewallRules: {
      create: defineMethod({
        action: 'compute:networks:update',
        kind: 'mutation',
        resource: networkResource,
        validate: describedBy(networkSchemas.createRule, parseCreateRule),
        handler: (context, input) => createRule(networkDeps(context), context.sql, input),
      }),
      list: defineMethod({
        action: 'compute:networks:read',
        kind: 'read',
        resource: networkResource,
        validate: describedBy(networkSchemas.network, parseNetworkRef),
        handler: (context, input) => listRules(context.sql, input),
      }),
      update: defineMethod({
        action: 'compute:networks:update',
        kind: 'mutation',
        resource: networkResource,
        validate: describedBy(networkSchemas.updateRule, parseUpdateRule),
        handler: (context, input) => updateRule(networkDeps(context), context.sql, input),
      }),
      delete: defineMethod({
        action: 'compute:networks:update',
        kind: 'mutation',
        resource: networkResource,
        validate: describedBy(networkSchemas.rule, parseRuleRef),
        handler: (context, input) => deleteRule(networkDeps(context), context.sql, input),
      }),
    },
  });

  return defineModule({
    name: 'vps',
    requires: ['capacity'],
    migrations: [...vpsMigrations],
    extensions: [...providers.values()],
    api,
    reconcilers: [
      {
        name: instanceWork,
        shardBy: 'none',
        async run(context, key) {
          const next = await reconcileInstance(depsOf(context), context.sql, key, context.signal);
          if (next !== undefined)
            await context.sql.transaction((tx) =>
              context.work.enqueue(tx, instanceWork, key, { notBefore: next }),
            );
          return 'DONE';
        },
      },
      {
        // §10.2: vcpu/memoryGiB/diskGiB of vps-host nodes from their inventory, with pool overcommit;
        // and instances on hosts declared lost are woken (no report will mention them again).
        name: hostResourcesWork,
        shardBy: 'none',
        periodic: [{ key: 'all', every: options.hostSyncEvery ?? '30s' }],
        // `all` (the periodic pass) or one node id (inventory wakes a host it re-inventoried).
        async run(context, key) {
          if (key && key !== 'all') {
            await syncHostResources(context.sql, { reserve, nodeId: key });
            return 'DONE';
          }
          await syncHostResources(context.sql, { reserve });
          await wakeInstancesOnLostHosts(context.sql, context.work);
          return 'DONE';
        },
      },
      {
        // §3.6: platform-owned provider machines, claimed → identified → installed → joined.
        name: bootstrapWork,
        shardBy: 'none',
        async run(context, key) {
          const next = await reconcileBootstrap(
            bootstrapDeps(context),
            context.sql,
            key,
            context.signal,
          );
          if (next !== undefined)
            await context.sql.transaction((tx) =>
              context.work.enqueue(tx, bootstrapWork, key, { notBefore: next }),
            );
          return 'DONE';
        },
      },
      // Provider capacity reservations: provider_reservations per account, provider.reservation.* events.
      providerReservationsReconciler(options.reservations ?? {}, reservationDeps),
      // R5: provider_machines, listed per provider account (key `all` periodic, then per account).
      discoveryReconciler(options.discovery ?? {}, depsOf),
      // D10: provider_costs per provider account whose client reads costs (key `all` periodic, then per account).
      costsReconciler(
        options.costs ?? {},
        (context) => ({ ...depsOf(context), providers }),
        currency,
        closeGraceHours,
      ),
      {
        // §3.7: sandbox expiry, sandbox.ready/deleted events, and warm pools per template.
        name: sandboxWork,
        shardBy: 'none',
        periodic: [{ key: 'all', every: '15s' }],
        async run(context, key) {
          // A settled `instance.snapshot` wakes this reconciler with its snapshot id.
          if (key.startsWith('snap_'))
            await settleSnapshots(depsOf(context), context.sql, { onlyId: key });
          else
            await reconcileSandboxes(depsOf(context), context.sql, {
              ...(options.snapshots ? { store: options.snapshots } : {}),
              // No caller here: both IAM modes answer for the named tenant (remote as the root
              // service account, an ancestor of every tenant; [31c64a] c7a5312).
              budget: (tenantId) => warmBudget(context, tenantId),
            });
          return 'DONE';
        },
      },
      {
        // Budget `suspend` (D16), level-triggered: a suspended offer's running instances are set to stopped, whether
        // or not the host wired the budget reaction (which only makes it immediate).
        name: 'vps.suspension',
        shardBy: 'none',
        periodic: [{ key: 'all', every: '1m' }],
        async run(context) {
          await context.sql.transaction((tx) => sweepSuspendedOffers(tx, depsOf(context)));
          return 'DONE';
        },
      },
      {
        // §12.7: vps.vcpu.hours, vps.memory.gib.hours (and GPU hours) for hosted instances.
        name: 'vps.usage',
        shardBy: 'none',
        periodic: [{ key: 'all', every: '5m' }],
        async run(context) {
          await context.sql.transaction((tx) => meterInstances(tx, context.clock.now()));
          // Agent memory: vps.volume.gib.hours while a volume's disk is booked.
          await context.sql.transaction((tx) => meterVolumes(tx, context.clock.now()));
          return 'DONE';
        },
      },
      {
        // Platform compute billing (D3): provider instances' lifecycle intervals become hourly `instance`
        // usage windows, which `iam.usage` flushes to better-iam like every other window.
        name: 'vps.provider-usage',
        shardBy: 'none',
        periodic: [{ key: 'all', every: '5m' }],
        async run(context) {
          const deps = depsOf(context);
          await context.sql.transaction((tx) =>
            meterIntervals(tx, context.clock.now(), {
              ...(deps.meterGpuModels ? { meterGpuModels: deps.meterGpuModels } : {}),
              meterGraceMs: options.billing?.meterGraceMs,
            }),
          );
          return 'DONE';
        },
      },
      // Reservation grants (D7): grant states, and every committed slot-hour as `grant` usage windows.
      grantsReconciler(grantDeps),
      {
        // Platform compute billing (D9): tenant networks' hours (and snapshots' GiB-hours) as `network` and
        // `snapshot` sources. A public address and a disk are lines of the instance's own intervals instead.
        name: 'vps.ancillary-usage',
        shardBy: 'none',
        periodic: [{ key: 'all', every: '5m' }],
        async run(context) {
          const deps = depsOf(context);
          await context.sql.transaction((tx) =>
            meterAncillaries(tx, context.clock.now(), {
              ...(deps.rootTenantId !== undefined ? { rootTenantId: deps.rootTenantId } : {}),
              meterGraceMs: options.billing?.meterGraceMs,
            }),
          );
          return 'DONE';
        },
      },
      {
        // Agent memory: a deleted volume is gone (its disk booking released) once its host applied a
        // spec without it; a delete wakes it with the volume id, the periodic pass catches the rest.
        name: volumeWork,
        shardBy: 'none',
        periodic: [{ key: 'all', every: '30s' }],
        async run(context, key) {
          await context.sql.transaction((tx) =>
            finishVolumeDeletions(
              depsOf(context),
              tx,
              key.startsWith('vol_') ? { onlyId: key } : {},
            ),
          );
          return 'DONE';
        },
      },
      // Tenant networks: VPCs, subnets, firewall rules and instance tags converged through the provider.
      networksReconciler(networkDeps),
    ],
    selfCheck: async (context) => [
      ...(await vpsSelfCheck(context.sql, runtimeTable, runtimes[0]!)),
      ...(await sandboxSelfCheck(context.sql)),
      ...(await volumeStorageSelfCheck(context.sql)),
    ],
    // §12.8: hosted instances hold inline allocations, which capacity's teardown never reaches.
    tenantDeleted: (context, tenantId) =>
      vpsTenantDeleted(depsOf(context), context, tenantId, options.snapshots),
    commandKinds: [instanceSnapshotKind],
    // Runtime hosts' volume stores (StatusReport.volume_storage): what volumes are booked against.
    statusHandlers: [volumeStorageStatusHandler()],
    async nodeSpec(context, node) {
      const instances = await instanceSpecs(
        context.sql,
        node.id,
        options.hostNetwork ? { network: options.hostNetwork } : {},
      );
      // Agent memory: the volumes this host keeps (a deleted one is absent, so bcd destroys it).
      const volumes = await hostVolumeSpecs(context.sql, node.id);
      return {
        ...(instances.length > 0 ? { instances } : {}),
        ...(volumes.length > 0 ? { volumes } : {}),
      };
    },
  });
}
