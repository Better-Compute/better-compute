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
  },
  'cloud-hypervisor': {
    isolation: 'microvm',
    multiTenant: true,
    gpuPassthrough: true,
    imageFormats: ['raw', 'qcow2'],
  },
  firecracker: {
    isolation: 'microvm',
    multiTenant: true,
    gpuPassthrough: false,
    imageFormats: ['raw'],
  },
  containerd: {
    isolation: 'container',
    multiTenant: false,
    gpuPassthrough: true,
    imageFormats: ['raw'],
  },
});

/** An instance as the runtime reports it on its host. */
export interface RuntimeInstanceStatus {
  id: string;
  state: 'running' | 'stopped' | 'error';
  addresses: string[];
  message?: string;
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
   * Converges one instance to `spec` (desired state `running` or `stopped`): caches the base image,
   * builds the overlay and NoCloud seed, then starts, stops or resizes it.
   */
  apply(spec: InstanceSpec): Promise<RuntimeInstanceStatus>;
  reboot(instanceId: string): Promise<void>;
  /** Deletes the instance and everything it owns; an absent instance counts as deleted. */
  remove(instanceId: string): Promise<void>;
  /** The serial console, for tunnels (v0.3). */
  console?(instanceId: string): Promise<DuplexStream>;
}

declare module '@better-compute/core' {
  interface DriverKinds {
    runtime: RuntimeDriver;
  }
}
