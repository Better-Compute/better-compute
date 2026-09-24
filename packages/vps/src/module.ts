import { notImplemented, type ComputeModule } from '@better-compute/core';

/** Options of `vps()`. */
export interface VpsOptions {
  /** Runtime driver ids pools may select, e.g. `['libvirt-kvm', 'cloud-hypervisor']`. */
  runtimes?: readonly string[];
}

/**
 * The VPS module: instance lifecycle, flavors, provider accounts, IPAM and the `instances`,
 * `flavors` and `providerAccounts` API groups (§3.6). Injected by the application
 * (`betterCompute({ modules: [vps({ runtimes: ['libvirt-kvm'] })] })`); the server never imports it.
 *
 * @throws `NOT_IMPLEMENTED` until v0.3.
 */
export function vps(options?: VpsOptions): ComputeModule<'vps'> {
  throw notImplemented('VPS', 'v0.3');
}
