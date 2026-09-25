import { PROTOCOL_VERSION, type InventorySectionName, type ProtocolRange } from '@better-compute/protocol';

// Daemon builds for version-skew tests (PLAN.md §7.6: N−1 minors before 1.0, N−2 from v1.0). A
// profile makes a FakeDaemon behave like an older bcd: the protocol range and version it announces,
// the capabilities it advertises, and what that build does not know yet (command kinds it rejects
// UNSUPPORTED, spec sections it reports SectionUnsupported, inventory sections it never collects,
// Hello fields it never sends). A FakeDaemon without a profile is the current build.

/** Spec sections a profile can lack (`devices` has existed since v0.1). */
export type ProfileSpecSection = 'host' | 'instances' | 'access' | 'telemetry' | 'daemon' | 'site';

/** Hello fields added after v0.1, which an older build leaves unset. */
export type ProfileHelloField = 'trustVersion' | 'drivers';

export interface DaemonProfile {
  /** A name for test reports, e.g. `N-2 (v0.3)`. */
  name: string;
  daemonVersion: string;
  protocol: ProtocolRange;
  /** The capabilities it advertises; absent: the current defaults. */
  capabilities?: readonly string[];
  /** Command kinds that build does not know: rejected UNSUPPORTED. */
  withoutKinds?: readonly string[];
  /** Spec sections it does not converge: a non-empty one is UNSUPPORTED (`SectionUnsupported`). */
  withoutSections?: readonly ProfileSpecSection[];
  /** Inventory sections it does not collect. */
  withoutInventory?: readonly InventorySectionName[];
  /** Hello fields it does not send. */
  withoutHello?: readonly ProfileHelloField[];
}

/**
 * The skew window, newest first: what each supported daemon line lacks relative to the current one.
 * A release adds a row on top and drops the one that leaves the window; `belowMinimum` is the first
 * build outside it.
 */
export const daemonSkewProfiles: readonly DaemonProfile[] = Object.freeze<DaemonProfile[]>([
  { name: 'N (current)', daemonVersion: '0.5.0', protocol: PROTOCOL_VERSION },
  {
    // v0.4: no sandbox snapshots (v0.5), no instance-dial tunnels.
    name: 'N-1 (v0.4)',
    daemonVersion: '0.4.0',
    protocol: PROTOCOL_VERSION,
    capabilities: ['cdi', 'nvml'],
    withoutKinds: ['instance.snapshot'],
  },
  {
    // v0.3: additionally no self-update section and no trust_version in Hello (both v0.4).
    name: 'N-2 (v0.3)',
    daemonVersion: '0.3.0',
    protocol: PROTOCOL_VERSION,
    capabilities: ['cdi', 'nvml'],
    withoutKinds: ['instance.snapshot'],
    withoutSections: ['daemon'],
    withoutHello: ['trustVersion'],
  },
]);

/** A build below the server's `proto_min`: it gets `upgrade_required` and only `daemon.upgrade`. */
export const belowMinimumProfile: DaemonProfile = Object.freeze<DaemonProfile>({
  name: 'below proto_min',
  daemonVersion: '0.0.9',
  protocol: { min: PROTOCOL_VERSION.min - 1, max: PROTOCOL_VERSION.min - 1 },
  capabilities: [],
  withoutSections: ['host', 'instances', 'access', 'telemetry', 'daemon', 'site'],
  withoutInventory: ['images'],
  withoutHello: ['trustVersion', 'drivers'],
});
