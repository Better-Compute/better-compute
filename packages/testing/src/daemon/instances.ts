import { createHash } from 'node:crypto';
import type { MessageInitShape } from '@bufbuild/protobuf';
import {
  InstanceDesiredState,
  InstanceObservedState,
  SectionState,
  type InstanceSpec,
  type InstanceStatusSchema,
  type InstancesSection,
} from '@better-compute/protocol';

// The daemon's `instances` converger on a VPS host (PLAN.md §6, §7.3, §11.1; v0.3), with a fake
// hypervisor under it. bcd drives libvirt/cloud-hypervisor; this keeps the same bookkeeping in memory:
// domains, their overlay disks and NoCloud seeds, tap devices and the base-image cache, so a test can
// diff what the host holds against the database (the v0.3 no-leak acceptance).
//
// Rules bcd follows, mirrored here:
// - Every spec is converged idempotently by instance id: created (overlay, seed, taps), resized,
//   started or stopped; `DELETED` removes the domain and everything it owns.
// - A domain bcd created that no spec names any more is removed (the spec is the whole desired set;
//   the control plane keeps deleting instances in it until they are reported absent). A domain bcd did
//   not create is never touched: it is reported, and the control plane flags it as a leak.
// - User data is fetched with a SecretRequest for the instance's allocation before the domain is
//   defined; the spec never carries it.
// - The status report lists every domain the runtimes hold (`instances_complete`).
// - Domains outlive the daemon process; a host reboot stops them, and the converger starts the
//   ones that should run.

/** Domain states as the runtime reports them. */
export type FakeDomainState = 'running' | 'stopped' | 'error';

/** A VM (or container) the fake runtime holds. */
export interface FakeDomain {
  readonly id: string;
  /** Created by bcd for a spec (false: something else defined it; never touched, reported as a leak). */
  readonly managed: boolean;
  readonly runtime: string;
  state: FakeDomainState;
  vcpu: number;
  memoryBytes: bigint;
  diskBytes: bigint;
  /** Hex sha256 of the base image its overlay is backed by. */
  image: string;
  allocationId: string;
  gpus: string[];
  macs: string[];
  /** CIDR addresses the guest holds (IPAM, from the spec's NICs). */
  addresses: string[];
  /** The NoCloud user data it booted with. */
  userData: string;
  message?: string;
  /** Times it was started. */
  boots: number;
}

export interface FakeHypervisorOptions {
  /** Runtime driver ids this host runs (default `['libvirt-kvm']`); a spec naming another fails. */
  runtimes?: readonly string[];
  /** Host limits for running domains (default unlimited); a start beyond them fails the instance. */
  capacity?: { vcpu?: number; memoryBytes?: bigint };
}

/** What the converger asks its daemon to fetch (a SecretRequest for the instance's allocation). */
export interface UserDataFetch {
  instanceId: string;
  ref: string;
  allocationId: string;
}

/** The section outcome of one pass, plus the runtimes' full inventory for the StatusReport. */
export interface InstancesConvergeResult {
  state: SectionState;
  reason?: string;
  message?: string;
  statuses: MessageInitShape<typeof InstanceStatusSchema>[];
}

const STATE: Record<FakeDomainState, InstanceObservedState> = {
  running: InstanceObservedState.RUNNING,
  stopped: InstanceObservedState.STOPPED,
  error: InstanceObservedState.ERROR,
};
const INSTANCE_DIR = '/var/lib/bcd/instances/';
const IMAGE_FORMATS = new Set(['raw', 'qcow2', 'iso']);

/** Where an instance's overlay disk lives. */
export const overlayPath = (instanceId: string, format = 'qcow2'): string =>
  `${INSTANCE_DIR}${instanceId}/disk.${format === 'raw' ? 'raw' : 'qcow2'}`;
/** Where an instance's NoCloud seed lives. */
export const seedPath = (instanceId: string): string => `${INSTANCE_DIR}${instanceId}/seed.iso`;
/** The tap device of an instance's `index`-th NIC (IFNAMSIZ: at most 15 characters). */
export const tapName = (instanceId: string, index: number): string =>
  `bct${createHash('sha256').update(instanceId).digest('hex').slice(0, 10)}${index}`;

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/**
 * The fake hypervisor and the `instances` converger over it. Owned by one FakeDaemon (its host
 * outlives daemon crashes), or shared with a test that inspects and breaks it.
 */
export class FakeHypervisor {
  /** Domains by id (instance id, or the foreign name of an unmanaged one). */
  readonly domains = new Map<string, FakeDomain>();
  /** Files the runtimes own (overlays, seeds) → the domain they belong to. */
  readonly files = new Map<string, string>();
  /** Tap devices → the domain they belong to. */
  readonly taps = new Map<string, string>();
  /** Base images cached on the host: hex sha256 → URL. */
  readonly imageCache = new Map<string, string>();
  readonly runtimes: readonly string[];
  private readonly capacity: NonNullable<FakeHypervisorOptions['capacity']>;
  /** Fetched user data by ref: the value, or the broker's refusal. */
  private readonly userData = new Map<string, { value: string } | { error: string }>();
  /** Refs asked for and not answered yet. */
  private readonly fetching = new Set<string>();
  /** The last pass waited for user data (sent or not). */
  private waiting = false;
  /** Instances the test made fail (e.g. a guest crash), with the message the runtime reports. */
  private readonly faults = new Map<string, string>();
  /** Specs that failed before a domain existed (unknown runtime, bad image, refused user data). */
  private readonly specErrors = new Map<string, { runtime: string; message: string }>();

  constructor(options: FakeHypervisorOptions = {}) {
    this.runtimes = [...(options.runtimes ?? ['libvirt-kvm'])];
    this.capacity = { ...options.capacity };
  }

  /**
   * One converger pass over the section (undefined: nothing desired). `fetch` sends a SecretRequest
   * and returns false when it cannot right now (no session); the pass is then PROGRESSING.
   */
  converge(
    section: InstancesSection | undefined,
    fetch?: (request: UserDataFetch) => boolean,
  ): InstancesConvergeResult {
    const specs = section?.instances ?? [];
    const named = new Set(specs.map((spec) => spec.instanceId));
    for (const domain of [...this.domains.values()])
      if (domain.managed && !named.has(domain.id)) this.destroy(domain.id);
    this.specErrors.clear();
    let progressing = false;
    const failures: string[] = [];
    const fail = (spec: InstanceSpec, message: string) => {
      failures.push(`${spec.instanceId}: ${message}`);
      const domain = this.domains.get(spec.instanceId);
      if (domain?.managed) {
        domain.state = 'error';
        domain.message = message;
      } else this.specErrors.set(spec.instanceId, { runtime: spec.runtime, message });
    };

    for (const spec of specs) {
      const id = spec.instanceId;
      if (spec.desiredState === InstanceDesiredState.DELETED) {
        if (this.domains.get(id)?.managed !== false) this.destroy(id);
        continue;
      }
      const existing = this.domains.get(id);
      if (existing && !existing.managed) {
        fail(spec, `a domain named ${id} exists that bcd did not create`);
        continue;
      }
      if (!this.runtimes.includes(spec.runtime)) {
        fail(spec, `runtime ${spec.runtime} is not installed on this host`);
        continue;
      }
      const format = spec.image?.format ?? '';
      if (!IMAGE_FORMATS.has(format) || !spec.image?.url || !spec.image.sha256.length) {
        fail(spec, `image ${spec.image?.ref || spec.image?.url || '(none)'} is not a raw, qcow2 or iso image`);
        continue;
      }
      let userData = '';
      if (spec.userDataRef) {
        const fetched = this.userData.get(spec.userDataRef);
        if (!fetched) {
          if (existing) userData = existing.userData;
          else {
            if (!this.fetching.has(spec.userDataRef)) {
              const sent =
                fetch?.({ instanceId: id, ref: spec.userDataRef, allocationId: spec.allocationId }) ??
                false;
              if (sent) this.fetching.add(spec.userDataRef);
            }
            progressing = true;
            continue;
          }
        } else if ('error' in fetched) {
          fail(spec, `user data refused: ${fetched.error}`);
          continue;
        } else userData = fetched.value;
      }
      this.imageCache.set(hex(spec.image.sha256), spec.image.url);
      const addresses = spec.nics.flatMap((nic) => nic.addresses);
      const macs = spec.nics.map((nic) => nic.mac);
      let domain = existing;
      if (!domain) {
        domain = {
          id,
          managed: true,
          runtime: spec.runtime,
          state: 'stopped',
          vcpu: spec.vcpu,
          memoryBytes: spec.memoryBytes,
          diskBytes: spec.diskBytes,
          image: hex(spec.image.sha256),
          allocationId: spec.allocationId,
          gpus: [...spec.gpuDeviceIds],
          macs,
          addresses,
          userData,
          boots: 0,
        };
        this.domains.set(id, domain);
        this.files.set(overlayPath(id, format), id);
        this.files.set(seedPath(id), id);
        spec.nics.forEach((_, index) => this.taps.set(tapName(id, index), id));
      } else {
        if (spec.diskBytes < domain.diskBytes) {
          fail(spec, 'a disk cannot shrink');
          continue;
        }
        domain.vcpu = spec.vcpu;
        domain.memoryBytes = spec.memoryBytes;
        domain.diskBytes = spec.diskBytes;
        domain.gpus = [...spec.gpuDeviceIds];
        domain.addresses = addresses;
        domain.macs = macs;
        for (const [tap, owner] of [...this.taps]) if (owner === id) this.taps.delete(tap);
        spec.nics.forEach((_, index) => this.taps.set(tapName(id, index), id));
      }
      const fault = this.faults.get(id);
      if (fault !== undefined) {
        domain.state = 'error';
        domain.message = fault;
        continue;
      }
      if (spec.desiredState === InstanceDesiredState.RUNNING) {
        if (domain.state !== 'running') {
          if (!this.fits(domain)) {
            fail(spec, 'not enough free vCPU or memory on this host');
            continue;
          }
          domain.state = 'running';
          domain.boots++;
        }
      } else domain.state = 'stopped';
      delete domain.message;
    }

    const statuses = this.statuses();
    this.waiting = progressing;
    if (progressing)
      return { state: SectionState.PROGRESSING, reason: 'FetchingUserData', message: 'waiting for user data', statuses };
    if (failures.length)
      return { state: SectionState.FAILED, reason: 'InstanceFailed', message: failures.join('; ').slice(0, 1024), statuses };
    return { state: SectionState.CONVERGED, statuses };
  }

  /** Everything the runtimes hold, managed or not, plus specs that failed before a domain existed. */
  statuses(): MessageInitShape<typeof InstanceStatusSchema>[] {
    const out: MessageInitShape<typeof InstanceStatusSchema>[] = [];
    for (const domain of [...this.domains.values()].sort((a, b) => (a.id < b.id ? -1 : 1)))
      out.push({
        instanceId: domain.id,
        state: STATE[domain.state],
        addresses: [...domain.addresses],
        runtime: domain.runtime,
        ...(domain.message ? { message: domain.message } : {}),
      });
    for (const [instanceId, error] of this.specErrors)
      if (!this.domains.has(instanceId))
        out.push({ instanceId, state: InstanceObservedState.ERROR, runtime: error.runtime, message: error.message });
    return out;
  }

  /** The broker's answer to a fetch: the user data, or its refusal. */
  provideUserData(ref: string, result: { value: string } | { error: string }): void {
    this.fetching.delete(ref);
    this.userData.set(ref, result);
  }

  /**
   * Forgets unanswered fetches (the session they went out on closed); true when the last pass was
   * waiting for user data, so the daemon should converge again on its new session.
   */
  retryFetches(): boolean {
    this.fetching.clear();
    return this.waiting;
  }

  // ---- faults and inspection ---------------------------------------------------------------------

  /** Defines a domain bcd did not create (a leak the control plane must report). */
  leakDomain(id: string, options: { runtime?: string; state?: FakeDomainState } = {}): void {
    this.domains.set(id, {
      id,
      managed: false,
      runtime: options.runtime ?? this.runtimes[0] ?? 'libvirt-kvm',
      state: options.state ?? 'running',
      vcpu: 1,
      memoryBytes: 1n << 30n,
      diskBytes: 10n << 30n,
      image: '',
      allocationId: '',
      gpus: [],
      macs: [],
      addresses: [],
      userData: '',
      boots: 1,
    });
  }

  /** The instance's guest fails (reported ERROR) until `clearFault`. */
  failInstance(instanceId: string, message = 'guest crashed'): void {
    this.faults.set(instanceId, message);
  }

  clearFault(instanceId: string): void {
    this.faults.delete(instanceId);
  }

  /** A host power loss or reboot: every domain stops; definitions and disks stay. */
  powerLoss(): void {
    for (const domain of this.domains.values()) if (domain.state === 'running') domain.state = 'stopped';
  }

  /** The host is reinstalled: every domain, disk, tap and cached image is gone. */
  wipe(): void {
    this.domains.clear();
    this.files.clear();
    this.taps.clear();
    this.imageCache.clear();
    this.userData.clear();
    this.fetching.clear();
  }

  /** Removes a domain and everything it owns (idempotent). */
  destroy(id: string): void {
    this.domains.delete(id);
    for (const [path, owner] of [...this.files]) if (owner === id) this.files.delete(path);
    for (const [tap, owner] of [...this.taps]) if (owner === id) this.taps.delete(tap);
  }

  private fits(domain: FakeDomain): boolean {
    let vcpu = domain.vcpu;
    let memory = domain.memoryBytes;
    for (const other of this.domains.values())
      if (other !== domain && other.state === 'running') {
        vcpu += other.vcpu;
        memory += other.memoryBytes;
      }
    return (
      (this.capacity.vcpu === undefined || vcpu <= this.capacity.vcpu) &&
      (this.capacity.memoryBytes === undefined || memory <= this.capacity.memoryBytes)
    );
  }
}
