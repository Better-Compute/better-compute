// The `runtime` driver kind (PLAN.md §5.2, §11.3), merged into @better-compute/core's `DriverKinds`.
// Runtimes run on VPS hosts (`runsOn: 'node'`): libvirt-kvm and cloud-hypervisor are built into
// `bcd` (v0.3); others come as bcx plugins (v0.5). The daemon's `instances` converger calls them;
// the API never does, it only changes `desiredState`.
import type { DuplexStream, ImageFormat, InstanceSpec } from '@better-compute/core';

/** How strongly a runtime separates instances. */
export type RuntimeIsolation = 'vm' | 'microvm' | 'container';

/** What a runtime can host; checked when pools select runtimes and when offers are validated. */
export interface RuntimeTraits {
  isolation: RuntimeIsolation;
  /**
   * Whether instances of different tenants may share a host. Container runtimes are single-tenant,
   * so pools that use them cannot be offered to more than one tenant.
   */
  multiTenant: boolean;
  /** Whole-GPU atoms passed through with VFIO (never overcommitted). */
  gpuPassthrough: boolean;
  /** Image formats it boots. */
  imageFormats: readonly ImageFormat[];
  /**
   * (v0.5) It implements `pause`/`resume`: sandbox warm pools keep its instances `paused` (memory
   * resident, fastest claim) instead of `stopped`.
   */
  pause?: boolean;
  /**
   * (v0.5) It implements `snapshot` (`instance.snapshot`): without it `sandboxes.snapshot` is
   * `UNSUPPORTED` up front rather than a command the host fails.
   */
  snapshot?: boolean;
}

/**
 * Traits of the runtimes bcd builds in or ships as known bcx plugins (§11.3). Containers share the
 * host kernel, so they are single-tenant (§13): a pool running them must set `policy.singleTenant`.
 */
export const builtinRuntimeTraits: Readonly<Record<string, RuntimeTraits>> = Object.freeze({
  'libvirt-kvm': {
    isolation: 'vm',
    multiTenant: true,
    gpuPassthrough: true,
    imageFormats: ['qcow2', 'raw', 'iso'],
    pause: true,
    snapshot: true,
  },
  'cloud-hypervisor': {
    isolation: 'microvm',
    multiTenant: true,
    gpuPassthrough: true,
    imageFormats: ['raw', 'qcow2'],
    pause: true,
    snapshot: true,
  },
  firecracker: {
    isolation: 'microvm',
    multiTenant: true,
    gpuPassthrough: false,
    imageFormats: ['raw'],
    pause: true,
    snapshot: true,
  },
  containerd: {
    isolation: 'container',
    multiTenant: false,
    gpuPassthrough: true,
    imageFormats: ['raw'],
  },
});

/** The runtimes every `bcd` builds in (v0.3); any other comes as a bcx plugin some hosts have. */
export const bcdBuiltinRuntimes: ReadonlySet<string> = new Set(['libvirt-kvm', 'cloud-hypervisor']);

/**
 * The node labels a host must carry to run `runtime` (§5.6 walkthrough 4): none for bcd's built-ins;
 * for a plugin runtime, the driver label the gateway writes from Hello.drivers
 * (`bc.dev/driver.<id>=<version>`), any version.
 */
export function runtimeNodeLabels(runtime: string): Record<string, string> | undefined {
  return bcdBuiltinRuntimes.has(runtime) ? undefined : { [`bc.dev/driver.${runtime}`]: '*' };
}

/** An instance as the runtime reports it on its host (`paused`: v0.5, a runtime with `pause`). */
export interface RuntimeInstanceStatus {
  id: string;
  state: 'running' | 'stopped' | 'error' | 'paused';
  addresses: string[];
  message?: string;
}

/** Where `RuntimeDriver.snapshot` uploads the captured state (`instance.snapshot`, v0.5). */
export interface RuntimeSnapshotTarget {
  /** Presigned HTTPS PUT URL. */
  uploadUrl: string;
  uploadHeaders?: Record<string, string>;
  /** Capture memory state too (a restorable running snapshot); false: disk only. */
  includeMemory: boolean;
}

/** What a snapshot upload wrote. */
export interface RuntimeSnapshotResult {
  uploadedBytes: number;
  /** Hex sha256 of the uploaded object. */
  sha256: string;
  /** The host CPU model the memory state depends on; absent for disk-only snapshots. */
  cpuModel?: string;
}

/** One VPS runtime on one host. Every operation is idempotent by instance id. */
export interface RuntimeDriver {
  readonly traits: RuntimeTraits;
  /**
   * Every instance the runtime holds on this host, including ones no spec names any more, so leaks
   * (domains, overlays, taps) are found by diffing against the database.
   */
  list(): Promise<RuntimeInstanceStatus[]>;
  /**
   * Converges one instance to `spec` (desired state `running`, `stopped` or, v0.5, `paused`): caches
   * the base image (or verifies `spec.restoreFrom`), builds the overlay and NoCloud seed, then
   * starts, stops, pauses or resizes it. A runtime without `pause` treats `paused` as `stopped`.
   */
  apply(spec: InstanceSpec): Promise<RuntimeInstanceStatus>;
  reboot(instanceId: string): Promise<void>;
  /** Deletes the instance and everything it owns; an absent instance counts as deleted. */
  remove(instanceId: string): Promise<void>;
  /** The serial console, for tunnels (v0.3). */
  console?(instanceId: string): Promise<DuplexStream>;
  /** (v0.5, sandboxes §3.7) Stops the vCPUs and keeps memory resident; idempotent. */
  pause?(instanceId: string): Promise<void>;
  /** (v0.5) Resumes a paused instance; idempotent. */
  resume?(instanceId: string): Promise<void>;
  /**
   * (v0.5) Captures disk (and memory) state and uploads it (`instance.snapshot`). Absent: the
   * command fails `UNSUPPORTED`.
   */
  snapshot?(instanceId: string, target: RuntimeSnapshotTarget): Promise<RuntimeSnapshotResult>;
}

declare module '@better-compute/core' {
  interface DriverKinds {
    runtime: RuntimeDriver;
  }
}
