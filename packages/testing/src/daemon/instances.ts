import { createHash } from 'node:crypto';
import type { MessageInitShape } from '@bufbuild/protobuf';
import {
  InstanceNetworkPolicy,
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

/** Domain states as the runtime reports them (`paused`, v0.5: vCPUs stopped, memory resident). */
export type FakeDomainState = 'running' | 'stopped' | 'error' | 'paused';

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
  /** Times it was started (a resume from `paused` is not a boot). */
  boots: number;
  /** (v0.5) Hex sha256 of the snapshot it was restored from (`InstanceSpec.restore_from`). */
  restoredFrom?: string;
  /** (v0.5) Snapshots taken of it (`instance.snapshot`). */
  snapshots?: number;
  /**
   * (v0.5) A stand-in for guest memory: whatever a test writes here is captured by a memory
   * snapshot and comes back in a domain restored from it (sandboxes, §3.7).
   */
  memory?: string;
  /**
   * (v0.5) What the host lets the guest reach (`InstanceSpec.network_policy`): `egress`, `private`
   * (the pool subnet and the host) or `none` (the host only). bcd enforces it on the taps.
   */
  networkPolicy: 'egress' | 'private' | 'none';
  /** (v1.1) The host volumes it attaches (`InstanceSpec.volumes`), open while it runs or is paused. */
  volumes: { volumeId: string; readOnly: boolean }[];
  /** What the guest used since it booted, as a test set it (`setUsage`); cleared at every boot. */
  usage?: Partial<FakeUsage>;
}

/**
 * One domain's live usage as bcd's runtimes read it (`runtime.UsageReader`; the `bcd.instance.*` OTLP series),
 * from the guest's side and cumulative since it booted, except `memoryBytes`, a gauge.
 */
export interface FakeUsage {
  cpuSeconds: number;
  memoryBytes: bigint;
  ioReadBytes: bigint;
  ioWriteBytes: bigint;
  /** What the guest received (its tap's transmitted bytes). */
  netRxBytes: bigint;
  netTxBytes: bigint;
}

/**
 * (v1.1, agent memory) A persistent volume the host keeps (`InstancesSection.volumes`): a sparse raw file
 * under the data directory that outlives the instances attaching it.
 */
export interface FakeVolume {
  readonly id: string;
  sizeBytes: bigint;
  serial: string;
  /** What guests wrote so far (a sparse file takes only this much of the filesystem). */
  writtenBytes: bigint;
  /** A stand-in for the data on it: what `writeVolume` last wrote, kept across instances and power loss. */
  content?: string;
}

/** Where a host volume's file lives. */
export const volumePath = (volumeId: string): string => `/var/lib/bcd/volumes/${volumeId}.raw`;

const NETWORK_POLICY: Partial<Record<InstanceNetworkPolicy, FakeDomain['networkPolicy']>> = {
  [InstanceNetworkPolicy.PRIVATE]: 'private',
  [InstanceNetworkPolicy.NONE]: 'none',
};

/** What `FakeHypervisor.snapshot` captured: the upload an `instance.snapshot` command reports. */
export interface FakeSnapshot {
  bytes: Uint8Array;
  /** Hex sha256 of `bytes`. */
  sha256: string;
  runtime: string;
  includeMemory: boolean;
}

export interface FakeHypervisorOptions {
  /** Runtime driver ids this host runs (default `['libvirt-kvm']`); a spec naming another fails. */
  runtimes?: readonly string[];
  /** Host limits for running domains (default unlimited); a start beyond them fails the instance. */
  capacity?: { vcpu?: number; memoryBytes?: bigint };
  /**
   * (v0.5) The object store snapshots go to and restores come from, by hex sha256: share one map
   * between hosts so a snapshot taken on one restores on another (default: this host's own).
   */
  snapshotStore?: Map<string, Uint8Array>;
  /**
   * (v1.1) The filesystem volumes live on, for `StatusReport.volume_storage` (`volumeStorage()`); without it
   * the host reports none. `reservedBytes` defaults to bcd's: 5% of the total, at least 2 GiB.
   */
  volumeStore?: { totalBytes: bigint; reservedBytes?: bigint };
  /**
   * The node runs unprivileged under `bcd helper` (config.toml `[helper]`), whose root side checks what the node
   * asks for: an instance NIC joins only a bridge of `instanceBridges` (`[helper] instance_bridges`; empty refuses
   * every NIC). A NIC on another network fails its instance with the helper's refusal: `libvirt-kvm`'s checked
   * definition before the domain exists, `cloud-hypervisor`'s `ch.taps` when it starts. See `helperVpsHost`.
   */
  helper?: { instanceBridges: readonly string[] };
}

/** `StatusReport.volume_storage`, as bcd computes it for its data directory. */
export interface FakeVolumeStorage {
  totalBytes: bigint;
  availableBytes: bigint;
  reservedBytes: bigint;
  committedBytes: bigint;
  outstandingBytes: bigint;
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
  paused: InstanceObservedState.PAUSED,
};
const INSTANCE_DIR = '/var/lib/bcd/instances/';
/**
 * What bcd's host admission puts before an instance's status message when it refused its start
 * (`agent.ResourcesExhausted`): the instance stays stopped and the section retries.
 */
export const RESOURCES_EXHAUSTED = 'ResourcesExhausted';
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
  /** (v0.5) Snapshot objects by hex sha256 (`FakeHypervisorOptions.snapshotStore`). */
  readonly snapshotStore: Map<string, Uint8Array>;
  /** (v1.1) Host volumes by id (`InstancesSection.volumes`); their files are `volumePath(id)`. */
  readonly volumes = new Map<string, FakeVolume>();
  /** `[helper] instance_bridges` when the node runs under bcd helper (`FakeHypervisorOptions.helper`). */
  readonly helper: FakeHypervisorOptions['helper'];
  private readonly volumeStore: FakeHypervisorOptions['volumeStore'];
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
    this.snapshotStore = options.snapshotStore ?? new Map();
    this.volumeStore = options.volumeStore;
    this.helper = options.helper ? { instanceBridges: [...options.helper.instanceBridges] } : undefined;
  }

  /** The helper's refusal of the spec's NICs, in its runtime's words (undefined: allowed, or no helper). */
  private helperRefusal(spec: InstanceSpec): string | undefined {
    if (!this.helper) return undefined;
    const bridge = spec.nics.find((nic) => !this.helper!.instanceBridges.includes(nic.network))?.network;
    if (bridge === undefined) return undefined;
    return spec.runtime === 'cloud-hypervisor'
      ? `ch.taps: ${JSON.stringify(bridge)} is not an instance bridge of this host ([helper] instance_bridges)`
      : `domain: bridge ${JSON.stringify(bridge)} is not an instance network`;
  }

  /**
   * One converger pass over the section (undefined: nothing desired). `fetch` sends a SecretRequest
   * and returns false when it cannot right now (no session); the pass is then PROGRESSING.
   */
  converge(
    section: InstancesSection | undefined,
    fetch?: (request: UserDataFetch) => boolean,
  ): InstancesConvergeResult {
    // Stops (and deletes) before starts, as bcd orders a pass: a volume handed from one instance to
    // another is closed before it is opened again.
    const wantsUp = (spec: InstanceSpec) =>
      spec.desiredState === InstanceDesiredState.RUNNING || spec.desiredState === InstanceDesiredState.PAUSED;
    const specs = [...(section?.instances ?? [])].sort((a, b) => Number(wantsUp(a)) - Number(wantsUp(b)));
    const named = new Set(specs.map((spec) => spec.instanceId));
    for (const domain of [...this.domains.values()])
      if (domain.managed && !named.has(domain.id)) this.destroy(domain.id);
    this.specErrors.clear();
    let progressing = false;
    const failures: string[] = [];
    /** Starts host admission refused this pass (`ResourcesExhausted`). */
    const exhausted: string[] = [];
    // (v1.1) Host volumes: created or grown when the store has room (bcd refuses otherwise, and the
    // volume keeps its size); never shrunk.
    const listed = new Map((section?.volumes ?? []).map((volume) => [volume.volumeId, volume]));
    const volumeErrors = new Map<string, string>();
    for (const wanted of listed.values()) {
      const existing = this.volumes.get(wanted.volumeId);
      if (!existing) {
        if (!this.volumeRoom(wanted.sizeBytes)) {
          volumeErrors.set(wanted.volumeId, `no room in the volume store for volume ${wanted.volumeId}`);
          continue;
        }
        // Its file is volumePath(id); kept apart from `files`, which are the domains' own.
        this.volumes.set(wanted.volumeId, { id: wanted.volumeId, sizeBytes: wanted.sizeBytes, serial: wanted.serial, writtenBytes: 0n });
      } else if (wanted.sizeBytes > existing.sizeBytes) {
        if (!this.volumeRoom(wanted.sizeBytes - existing.sizeBytes))
          volumeErrors.set(wanted.volumeId, `no room in the volume store to grow volume ${wanted.volumeId}`);
        else existing.sizeBytes = wanted.sizeBytes;
      } else if (wanted.sizeBytes < existing.sizeBytes) volumeErrors.set(wanted.volumeId, `volume ${wanted.volumeId} cannot shrink`);
    }
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
      const restore = spec.restoreFrom?.url ? spec.restoreFrom : undefined;
      if (restore && !restore.sha256.length) {
        fail(spec, `snapshot ${restore.ref || restore.url} has no sha256 to verify`);
        continue;
      }
      const format = restore ? 'raw' : (spec.image?.format ?? '');
      if (!restore && (!IMAGE_FORMATS.has(format) || !spec.image?.url || !spec.image.sha256.length)) {
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
      if (spec.image?.sha256.length) this.imageCache.set(hex(spec.image.sha256), spec.image.url);
      const addresses = spec.nics.flatMap((nic) => nic.addresses);
      const macs = spec.nics.map((nic) => nic.mac);
      let domain = existing;
      // Under bcd helper, root checks libvirt's definition before the domain exists.
      const refused = this.helperRefusal(spec);
      if (refused && spec.runtime !== 'cloud-hypervisor') {
        fail(spec, refused);
        continue;
      }
      if (!domain) {
        domain = {
          id,
          managed: true,
          runtime: spec.runtime,
          state: 'stopped',
          vcpu: spec.vcpu,
          memoryBytes: spec.memoryBytes,
          diskBytes: spec.diskBytes,
          image: spec.image ? hex(spec.image.sha256) : '',
          allocationId: spec.allocationId,
          gpus: [...spec.gpuDeviceIds],
          macs,
          addresses,
          userData,
          boots: 0,
          networkPolicy: NETWORK_POLICY[spec.networkPolicy] ?? 'egress',
          volumes: [],
          ...(restore ? { restoredFrom: hex(restore.sha256) } : {}),
        };
        // A memory snapshot brings its guest memory back (when the store holds the object).
        const memory = restore ? this.restoredMemory(hex(restore.sha256)) : undefined;
        if (memory !== undefined) domain.memory = memory;
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
        domain.networkPolicy = NETWORK_POLICY[spec.networkPolicy] ?? 'egress';
        for (const [tap, owner] of [...this.taps]) if (owner === id) this.taps.delete(tap);
        spec.nics.forEach((_, index) => this.taps.set(tapName(id, index), id));
      }
      const fault = this.faults.get(id);
      if (fault !== undefined) {
        domain.state = 'error';
        domain.message = fault;
        continue;
      }
      const wanted = spec.desiredState;
      if (wanted === InstanceDesiredState.RUNNING || wanted === InstanceDesiredState.PAUSED) {
        // A paused domain resumes (or stays paused) in place; anything else boots first.
        if (domain.state !== 'running' && domain.state !== 'paused') {
          if (!this.fits(domain)) {
            // bcd's host admission: not an error; it stays stopped with the reason, and the next pass tries again.
            domain.message = `${RESOURCES_EXHAUSTED}: not enough free vCPU or memory on this host`;
            exhausted.push(id);
            continue;
          }
          // cloud-hypervisor's taps are root's (ch.taps), made when the VMM starts.
          if (refused) {
            fail(spec, refused);
            continue;
          }
          // Its volumes open at boot: each on this host, and one writer at a time (checked against what
          // running and paused domains really have open, not what their specs say now).
          const attach = spec.volumes.map((volume) => ({ volumeId: volume.volumeId, readOnly: volume.readOnly }));
          const refusal = this.volumeRefusal(domain.id, attach, volumeErrors);
          if (refusal) {
            fail(spec, refusal);
            continue;
          }
          domain.volumes = attach;
          domain.boots++;
          delete domain.usage;
        }
        domain.state = wanted === InstanceDesiredState.PAUSED ? 'paused' : 'running';
      } else domain.state = 'stopped';
      delete domain.message;
    }

    // An unlisted volume is a deleted one: its file goes once no running or paused domain has it open.
    for (const id of [...this.volumes.keys()])
      if (!listed.has(id) && !this.openBy(id).length) this.volumes.delete(id);
    for (const [id, message] of volumeErrors) if (!failures.some((failure) => failure.includes(id))) failures.push(message);

    const statuses = this.statuses();
    this.waiting = progressing;
    if (progressing)
      return { state: SectionState.PROGRESSING, reason: 'FetchingUserData', message: 'waiting for user data', statuses };
    if (failures.length)
      return { state: SectionState.FAILED, reason: 'InstanceFailed', message: failures.join('; ').slice(0, 1024), statuses };
    if (exhausted.length)
      return {
        state: SectionState.PROGRESSING,
        reason: 'Retrying',
        message: `${RESOURCES_EXHAUSTED}: this host cannot start ${exhausted.sort().join(', ')} now`.slice(0, 1024),
        statuses,
      };
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
      networkPolicy: 'egress',
      volumes: [],
    });
  }

  // ---- volumes (v1.1) ----------------------------------------------------------------------------

  /** The running or paused domains that have `volumeId` open, and how. */
  openBy(volumeId: string): { domainId: string; readOnly: boolean }[] {
    const out: { domainId: string; readOnly: boolean }[] = [];
    for (const domain of this.domains.values())
      if (domain.state === 'running' || domain.state === 'paused')
        for (const volume of domain.volumes) if (volume.volumeId === volumeId) out.push({ domainId: domain.id, readOnly: volume.readOnly });
    return out;
  }

  /** Why `domainId` cannot open `attach` now, or undefined. */
  private volumeRefusal(
    domainId: string,
    attach: readonly { volumeId: string; readOnly: boolean }[],
    volumeErrors: ReadonlyMap<string, string>,
  ): string | undefined {
    for (const volume of attach) {
      const error = volumeErrors.get(volume.volumeId);
      if (error && !this.volumes.has(volume.volumeId)) return error;
      if (!this.volumes.has(volume.volumeId)) return `volume ${volume.volumeId} is not on this host`;
      const others = this.openBy(volume.volumeId).filter((open) => open.domainId !== domainId);
      const writer = others.find((open) => !open.readOnly);
      if (writer) return `volume ${volume.volumeId} is open read-write by ${writer.domainId}`;
      if (!volume.readOnly && others.length) return `volume ${volume.volumeId} is open read-only by ${others[0]!.domainId}`;
    }
    return undefined;
  }

  /** Whether the store can promise `need` more bytes: available − reserved − outstanding, as bcd checks. */
  private volumeRoom(need: bigint): boolean {
    const storage = this.volumeStorage();
    if (!storage) return true;
    return need <= storage.availableBytes - storage.reservedBytes - storage.outstandingBytes;
  }

  /** `StatusReport.volume_storage` for the data directory, or undefined without `volumeStore`. */
  volumeStorage(): FakeVolumeStorage | undefined {
    if (!this.volumeStore) return undefined;
    const totalBytes = this.volumeStore.totalBytes;
    const floor = 2n << 30n;
    const reservedBytes = this.volumeStore.reservedBytes ?? (totalBytes / 20n > floor ? totalBytes / 20n : floor);
    let written = 0n;
    let committed = 0n;
    for (const volume of this.volumes.values()) {
      written += volume.writtenBytes;
      committed += volume.sizeBytes;
    }
    const availableBytes = totalBytes > written ? totalBytes - written : 0n;
    return { totalBytes, availableBytes, reservedBytes, committedBytes: committed, outstandingBytes: committed - written };
  }

  /**
   * The guest of `instanceId` writes `bytes` (default 1 MiB, at most the volume's size) to a volume it has
   * open read-write; `content` stands in for the data and outlives the instance. Throws otherwise.
   */
  writeVolume(instanceId: string, volumeId: string, content: string, bytes: bigint = 1n << 20n): void {
    const domain = this.domains.get(instanceId);
    const volume = this.volumes.get(volumeId);
    if (!domain || (domain.state !== 'running' && domain.state !== 'paused')) throw new Error(`instance ${instanceId} is not running here`);
    if (!volume || !domain.volumes.some((open) => open.volumeId === volumeId && !open.readOnly))
      throw new Error(`instance ${instanceId} has no read-write volume ${volumeId} open`);
    volume.content = content;
    const written = volume.writtenBytes + bytes;
    volume.writtenBytes = written > volume.sizeBytes ? volume.sizeBytes : written;
  }

  /** What a guest reading `volumeId` would find (`writeVolume`'s last content), if the host has it. */
  volumeContent(volumeId: string): string | undefined {
    return this.volumes.get(volumeId)?.content;
  }

  // ---- live usage ---------------------------------------------------------------------------------

  /**
   * Live usage of the domains whose runtime reads it, as bcd's `runtime.UsageReader`s do: `cloud-hypervisor`'s
   * managed domains that run or are paused (the VMM unit's cgroup and the taps' counters, which the node reads as
   * its own user under bcd helper too), `libvirt-kvm`'s running domains, managed or not (`virsh domstats
   * --state-running`). Other runtimes (plugins) report none. A guest's numbers are what `setUsage` gave it since it
   * booted, over bcd's fakehw synthetic usage: half its memory and a CPU second per boot.
   */
  usage(): Map<string, FakeUsage> {
    const out = new Map<string, FakeUsage>();
    for (const domain of [...this.domains.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const read =
        domain.runtime === 'cloud-hypervisor'
          ? domain.managed && (domain.state === 'running' || domain.state === 'paused')
          : domain.runtime === 'libvirt-kvm' && domain.state === 'running';
      if (!read) continue;
      out.set(domain.id, {
        cpuSeconds: domain.boots,
        memoryBytes: domain.memoryBytes / 2n,
        ioReadBytes: 0n,
        ioWriteBytes: 0n,
        netRxBytes: 0n,
        netTxBytes: 0n,
        ...domain.usage,
      });
    }
    return out;
  }

  /** What the guest of `instanceId` used since it booted (merged over earlier calls); its next boot clears it. */
  setUsage(instanceId: string, usage: Partial<FakeUsage>): void {
    const domain = this.domains.get(instanceId);
    if (!domain) throw new Error(`no instance ${instanceId} on this host`);
    domain.usage = { ...domain.usage, ...usage };
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
    for (const domain of this.domains.values())
      if (domain.state === 'running' || domain.state === 'paused') domain.state = 'stopped';
  }

  /**
   * (v0.5) What an `instance.snapshot` command captures: disk (and memory) state of a managed
   * domain, deterministic per domain and snapshot count, so a restore can be checked by sha256.
   * Throws for an unknown or foreign domain, or one in error.
   */
  snapshot(instanceId: string, includeMemory = true): FakeSnapshot {
    const domain = this.domains.get(instanceId);
    if (!domain?.managed) throw new Error(`no instance ${instanceId} on this host`);
    if (domain.state === 'error') throw new Error(`instance ${instanceId} is in error`);
    domain.snapshots = (domain.snapshots ?? 0) + 1;
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        instanceId,
        image: domain.image,
        restoredFrom: domain.restoredFrom ?? null,
        memory: includeMemory ? `${domain.memoryBytes}` : null,
        guest: includeMemory ? (domain.memory ?? null) : null,
        n: domain.snapshots,
      }),
    );
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    this.snapshotStore.set(sha256, bytes);
    return { bytes, sha256, runtime: domain.runtime, includeMemory };
  }

  /** The guest memory a stored snapshot carries, if the store holds it and it has any. */
  private restoredMemory(sha256: string): string | undefined {
    const bytes = this.snapshotStore.get(sha256);
    if (!bytes) return undefined;
    try {
      const captured = JSON.parse(new TextDecoder().decode(bytes)) as { guest?: string | null };
      return typeof captured.guest === 'string' ? captured.guest : undefined;
    } catch {
      return undefined;
    }
  }

  /** The host is reinstalled: every domain, disk, tap and cached image is gone. */
  wipe(): void {
    this.domains.clear();
    this.files.clear();
    this.taps.clear();
    this.imageCache.clear();
    this.volumes.clear();
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
      // A paused domain keeps its memory resident and its vCPUs reserved.
      if (other !== domain && (other.state === 'running' || other.state === 'paused')) {
        vcpu += other.vcpu;
        memory += other.memoryBytes;
      }
    return (
      (this.capacity.vcpu === undefined || vcpu <= this.capacity.vcpu) &&
      (this.capacity.memoryBytes === undefined || memory <= this.capacity.memoryBytes)
    );
  }
}
