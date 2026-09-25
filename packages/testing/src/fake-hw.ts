import { createHash } from 'node:crypto';
import { create, toBinary, type MessageInitShape } from '@bufbuild/protobuf';
import {
  BootMode,
  CgroupVersion,
  DiskTransport,
  GpuLinkType,
  INVENTORY_SECTIONS,
  LinkState,
  MigMode,
  NodeInventorySchema,
  RdmaType,
  inventorySectionSchemas,
  type Gpu,
  type HardwareClaimsSchema,
  type InventorySectionName,
  type NodeInventory,
} from '@better-compute/protocol';

// A deterministic fake of the node hardware the daemon inventories (PLAN.md §6 `sim`, §15). The
// `hgx-h100` variant mirrors daemon/internal/fakehw field for field, including how identifiers are
// derived from the seed (SHA-256 of "bcd-fakehw/<seed>/<parts>"), so the TypeScript FakeDaemon and a
// `bcd -tags fakehw` with the same seed report the same inventory and section hashes.

/** The shapes of node the generator knows. */
export type FakeHardwareVariant =
  /** 8× H100 SXM5 80GB on NVSwitch, 2 NUMA nodes (daemon/internal/fakehw). */
  | 'hgx-h100'
  /** The same board with one GPU gone (7 visible): raises `GpuCountMismatch` against 8 expected. */
  | 'hgx-h100-gpu-missing'
  /** 4× L40S 48GB on PCIe, no NVLink, no MIG. */
  | 'l40s'
  /** No GPUs and no NVML: the `gpus` section is absent. */
  | 'cpu';

export interface FakeHardwareOptions {
  /** Seeds serials, UUIDs and MACs (Go formats it with %d; any string works here). Default 0. */
  seed?: number | bigint | string;
  variant?: FakeHardwareVariant;
  /** `hgx-h100-gpu-missing`: which board position (0–7) is gone (default: derived from the seed). */
  missingGpu?: number;
}

/** A fake node's hardware. */
export interface FakeHardware {
  readonly variant: FakeHardwareVariant;
  readonly seed: string;
  /** NodeInventory v1, canonicalized. `collectedAt` is unset, as in Go. */
  readonly inventory: NodeInventory;
  /** The GPU count the board was built with (8 for both HGX variants). */
  readonly expectedGpuCount: number;
  /** UUIDs of the GPUs NVML sees, in index order. */
  readonly gpuUuids: readonly string[];
  /** What the daemon would claim at join (`HardwareClaims`). */
  readonly claims: MessageInitShape<typeof HardwareClaimsSchema>;
}

/** One encoded inventory section, as `InventorySection` carries it. */
export interface EncodedSection {
  name: InventorySectionName;
  /** Protobuf binary of the canonicalized section message. */
  content: Uint8Array;
  /** SHA-256 of `content`. */
  sha256: Uint8Array;
}

// Board constants (daemon/internal/fakehw).
const GPU_COUNT = 8;
const NVLINKS_PER_GPU = 18;
const NVSWITCHES = 4;
const NUMA_NODES = 2;
const OS_DISKS = 2;
const DATA_DISKS = 8;
/** The NVML name every fake H100 reports. */
export const H100_GPU_NAME = 'NVIDIA H100 80GB HBM3';
/** The NVML name every fake L40S reports. */
export const L40S_GPU_NAME = 'NVIDIA L40S';

const MiB = 1n << 20n;
const GiB = 1n << 30n;
const H100_VRAM = 81559n * MiB;
const L40S_VRAM = 46068n * MiB;
const MEMORY_PER_NUMA = 1n << 40n;
const DIMM_BYTES = 64n * GiB;
const OS_DISK_BYTES = 1_920_383_410_176n;
const DATA_DISK_BYTES = 3_840_755_982_336n;

const H100_BUS_IDS = [
  '00000000:18:00.0',
  '00000000:2a:00.0',
  '00000000:3a:00.0',
  '00000000:5d:00.0',
  '00000000:9a:00.0',
  '00000000:ab:00.0',
  '00000000:ba:00.0',
  '00000000:db:00.0',
] as const;
const NVSWITCH_BUS_IDS = [
  '00000000:05:00.0',
  '00000000:06:00.0',
  '00000000:07:00.0',
  '00000000:08:00.0',
] as const;
const L40S_BUS_IDS = [
  '00000000:17:00.0',
  '00000000:31:00.0',
  '00000000:b1:00.0',
  '00000000:ca:00.0',
] as const;

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** Stable per-node identifiers derived from the seed (fakehw `generator`). */
class Generator {
  constructor(readonly seed: string) {}
  digest(...parts: string[]): Uint8Array {
    return createHash('sha256')
      .update(`bcd-fakehw/${this.seed}/${parts.join('/')}`)
      .digest();
  }
  uuid(...parts: string[]): string {
    const h = hex(this.digest(...parts).subarray(0, 16));
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  }
  serial(prefix: string, ...parts: string[]): string {
    return prefix + hex(this.digest(...parts).subarray(0, 5)).toUpperCase();
  }
  /** A locally administered unicast MAC (02:bc:…). */
  mac(...parts: string[]): string {
    const d = this.digest(...parts);
    const b = (i: number) => d[i]!.toString(16).padStart(2, '0');
    return `02:bc:${b(0)}:${b(1)}:${b(2)}:${b(3)}`;
  }
}

type InventoryInit = MessageInitShape<typeof NodeInventorySchema>;
type GpuInit = Exclude<Exclude<InventoryInit['gpus'], undefined>['gpus'], undefined>[number];

function migProfilesH100() {
  return [
    { id: 0, name: '7g.80gb', maxInstances: 1, memoryBytes: 80n * GiB },
    { id: 5, name: '4g.40gb', maxInstances: 1, memoryBytes: 40n * GiB },
    { id: 9, name: '3g.40gb', maxInstances: 2, memoryBytes: 40n * GiB },
    { id: 14, name: '2g.20gb', maxInstances: 3, memoryBytes: 20n * GiB },
    { id: 15, name: '1g.20gb', maxInstances: 4, memoryBytes: 20n * GiB },
    { id: 19, name: '1g.10gb', maxInstances: 7, memoryBytes: 10n * GiB },
  ];
}

function hgxH100(g: Generator): InventoryInit {
  const uuids = Array.from({ length: GPU_COUNT }, (_, i) => `GPU-${g.uuid('gpu', String(i))}`);
  const gpus: GpuInit[] = uuids.map((uuid, i) => ({
    index: i,
    uuid,
    pciBusId: H100_BUS_IDS[i]!,
    name: H100_GPU_NAME,
    architecture: 'hopper',
    vramBytes: H100_VRAM,
    serial: g.serial('165', 'gpu-serial', String(i)),
    vbiosVersion: '96.00.74.00.0B',
    boardPartNumber: '692-2G520-0200-000',
    numaNode: Math.floor(i / (GPU_COUNT / NUMA_NODES)),
    powerLimitMw: 700_000,
    persistenceMode: true,
    computeMode: 'default',
    cudaComputeCapabilityMajor: 9,
    cudaComputeCapabilityMinor: 0,
    mig: { capable: true, current: MigMode.DISABLED, profiles: migProfilesH100() },
    // NVSwitch connects every pair of GPUs: each sees the other seven as NV18 peers.
    nvlinks: Array.from({ length: NVLINKS_PER_GPU }, (_, l) => ({
      link: l,
      state: LinkState.UP,
      peer: `nvswitch:${NVSWITCH_BUS_IDS[l % NVSWITCHES]!}`,
      version: 4,
    })),
    topology: uuids
      .filter((_, j) => j !== i)
      .map((peerUuid) => ({ peerUuid, link: GpuLinkType.NV, nvlinks: NVLINKS_PER_GPU })),
    ecc: { enabled: true, volatileCounts: {}, aggregateCounts: {} },
    rowRemap: {},
  }));
  return {
    schemaVersion: 1,
    system: {
      vendor: 'Fake Systems',
      product: 'HGX H100 8-GPU (fakehw)',
      serial: g.serial('FK', 'system'),
      productUuid: g.uuid('system'),
      boardVendor: 'Fake Systems',
      boardProduct: 'HGX H100 baseboard',
      boardSerial: g.serial('FB', 'board'),
      chassisSerial: g.serial('FC', 'chassis'),
      biosVendor: 'fakehw',
      biosVersion: '1.0.0',
      bootMode: BootMode.UEFI,
      secureBoot: false,
      tpm: { version: '2.0', manufacturer: 'fakehw' },
    },
    cpu: {
      vendor: 'GenuineIntel',
      model: 'Intel(R) Xeon(R) Platinum 8480+',
      architecture: 'x86_64',
      sockets: 2,
      cores: 112,
      threads: 224,
      flags: [
        'amx_bf16',
        'amx_int8',
        'amx_tile',
        'avx2',
        'avx512_bf16',
        'avx512_fp16',
        'avx512f',
        'vmx',
      ],
      numaNodes: [
        { id: 0, cpus: '0-55,112-167', memoryBytes: MEMORY_PER_NUMA },
        { id: 1, cpus: '56-111,168-223', memoryBytes: MEMORY_PER_NUMA },
      ],
    },
    memory: {
      totalBytes: BigInt(NUMA_NODES) * MEMORY_PER_NUMA,
      hugepages: [{ pageSizeBytes: 2n * MiB }, { pageSizeBytes: GiB }],
      dimms: Array.from({ length: 32 }, (_, i) => ({
        slot: `DIMM${String(i).padStart(2, '0')}`,
        sizeBytes: DIMM_BYTES,
        speedMts: 4800,
        type: 'DDR5',
        ecc: true,
      })),
      edac: {},
    },
    disks: {
      disks: Array.from({ length: OS_DISKS + DATA_DISKS }, (_, i) => {
        const id = String(i);
        const os = i < OS_DISKS;
        return {
          name: `nvme${id}n1`,
          model: os ? 'SAMSUNG MZ1L21T9HCLS-00A07' : 'SAMSUNG MZQL23T8HCLS-00A07',
          serial: g.serial('S6', 'disk-serial', id),
          wwn: `eui.${hex(g.digest('disk', id).subarray(0, 8))}`,
          sizeBytes: os ? OS_DISK_BYTES : DATA_DISK_BYTES,
          transport: DiskTransport.NVME,
          smart: { healthy: true },
        };
      }),
    },
    nics: {
      nics: [
        {
          name: 'ens1f0np0',
          mac: g.mac('nic', '0'),
          driver: 'mlx5_core',
          firmware: '28.39.1002',
          speedMbps: 100_000,
          pciAddress: '0000:0c:00.0',
          numaNode: 0,
          rdma: RdmaType.NONE,
          link: LinkState.UP,
          mtu: 1500,
        },
        {
          name: 'ens2np0',
          mac: g.mac('nic', '1'),
          driver: 'mlx5_core',
          firmware: '28.39.1002',
          speedMbps: 400_000,
          pciAddress: '0000:8c:00.0',
          numaNode: 1,
          sriovTotalVfs: 16,
          rdma: RdmaType.ROCE,
          link: LinkState.UP,
          mtu: 9000,
        },
      ],
    },
    gpus: {
      driverVersion: '550.90.07',
      cudaDriverVersion: '12.4',
      nvmlVersion: '12.550.90.07',
      gpus,
    },
    bmc: {
      mac: g.mac('bmc'),
      vendor: 'fakehw',
      firmwareVersion: '1.0.0',
      redfish: true,
      ipmi: true,
    },
    os: {
      distro: 'ubuntu',
      distroVersion: '24.04',
      kernel: '6.8.0-45-generic',
      cgroup: CgroupVersion.V2,
      kvm: true,
      iommu: true,
      runtimes: ['containerd'],
      hostname: 'fakehw',
    },
  };
}

/** NVML enumerates what is left: the missing GPU vanishes and the others are re-indexed. */
function removeGpu(inventory: NodeInventory, position: number): void {
  const section = inventory.gpus!;
  const gone = section.gpus[position]!.uuid;
  section.gpus = section.gpus
    .filter((_, i) => i !== position)
    .map((gpu, index) => {
      gpu.index = index;
      gpu.topology = gpu.topology.filter((peer) => peer.peerUuid !== gone);
      return gpu;
    });
}

function l40s(g: Generator): InventoryInit {
  const count = 4;
  const uuids = Array.from({ length: count }, (_, i) => `GPU-${g.uuid('gpu', String(i))}`);
  const numaOf = (i: number) => (i < count / 2 ? 0 : 1);
  const gpus: GpuInit[] = uuids.map((uuid, i) => ({
    index: i,
    uuid,
    pciBusId: L40S_BUS_IDS[i]!,
    name: L40S_GPU_NAME,
    architecture: 'ada',
    vramBytes: L40S_VRAM,
    serial: g.serial('132', 'gpu-serial', String(i)),
    vbiosVersion: '95.02.66.00.02',
    boardPartNumber: '900-2G133-0080-000',
    numaNode: numaOf(i),
    powerLimitMw: 350_000,
    persistenceMode: true,
    computeMode: 'default',
    cudaComputeCapabilityMajor: 8,
    cudaComputeCapabilityMinor: 9,
    mig: { capable: false },
    // PCIe only: across host bridges on one socket, across the SMP link otherwise.
    topology: uuids
      .map((peerUuid, j) => ({ peerUuid, j }))
      .filter(({ j }) => j !== i)
      .map(({ peerUuid, j }) => ({
        peerUuid,
        link: numaOf(j) === numaOf(i) ? GpuLinkType.NODE : GpuLinkType.SYS,
      })),
    ecc: { enabled: true, volatileCounts: {}, aggregateCounts: {} },
    rowRemap: {},
  }));
  const numa = 384n * GiB;
  return {
    schemaVersion: 1,
    system: {
      vendor: 'Fake Systems',
      product: 'L40S 4-GPU (fakehw)',
      serial: g.serial('FK', 'system'),
      productUuid: g.uuid('system'),
      boardVendor: 'Fake Systems',
      boardProduct: 'PCIe GPU server board',
      boardSerial: g.serial('FB', 'board'),
      chassisSerial: g.serial('FC', 'chassis'),
      biosVendor: 'fakehw',
      biosVersion: '1.0.0',
      bootMode: BootMode.UEFI,
      secureBoot: false,
      tpm: { version: '2.0', manufacturer: 'fakehw' },
    },
    cpu: {
      vendor: 'AuthenticAMD',
      model: 'AMD EPYC 9354 32-Core Processor',
      architecture: 'x86_64',
      sockets: 2,
      cores: 64,
      threads: 128,
      flags: ['avx2', 'avx512f', 'svm'],
      numaNodes: [
        { id: 0, cpus: '0-31,64-95', memoryBytes: numa },
        { id: 1, cpus: '32-63,96-127', memoryBytes: numa },
      ],
    },
    memory: {
      totalBytes: 2n * numa,
      hugepages: [{ pageSizeBytes: 2n * MiB }, { pageSizeBytes: GiB }],
      dimms: Array.from({ length: 24 }, (_, i) => ({
        slot: `DIMM${String(i).padStart(2, '0')}`,
        sizeBytes: 32n * GiB,
        speedMts: 4800,
        type: 'DDR5',
        ecc: true,
      })),
      edac: {},
    },
    disks: {
      disks: Array.from({ length: 6 }, (_, i) => {
        const id = String(i);
        const os = i < 2;
        return {
          name: `nvme${id}n1`,
          model: os ? 'SAMSUNG MZ1L2960HCJR-00A07' : 'SAMSUNG MZQL27T6HBLA-00A07',
          serial: g.serial('S6', 'disk-serial', id),
          wwn: `eui.${hex(g.digest('disk', id).subarray(0, 8))}`,
          sizeBytes: os ? 960_197_124_096n : 7_681_501_126_656n,
          transport: DiskTransport.NVME,
          smart: { healthy: true },
        };
      }),
    },
    nics: {
      nics: [
        {
          name: 'eno1',
          mac: g.mac('nic', '0'),
          driver: 'bnxt_en',
          firmware: '227.0.131.0',
          speedMbps: 25_000,
          pciAddress: '0000:41:00.0',
          numaNode: 0,
          rdma: RdmaType.NONE,
          link: LinkState.UP,
          mtu: 1500,
        },
        {
          name: 'ens3np0',
          mac: g.mac('nic', '1'),
          driver: 'mlx5_core',
          firmware: '28.39.1002',
          speedMbps: 100_000,
          pciAddress: '0000:c1:00.0',
          numaNode: 1,
          sriovTotalVfs: 8,
          rdma: RdmaType.ROCE,
          link: LinkState.UP,
          mtu: 9000,
        },
      ],
    },
    gpus: {
      driverVersion: '550.90.07',
      cudaDriverVersion: '12.4',
      nvmlVersion: '12.550.90.07',
      gpus,
    },
    bmc: {
      mac: g.mac('bmc'),
      vendor: 'fakehw',
      firmwareVersion: '1.0.0',
      redfish: true,
      ipmi: true,
    },
    os: {
      distro: 'ubuntu',
      distroVersion: '24.04',
      kernel: '6.8.0-45-generic',
      cgroup: CgroupVersion.V2,
      kvm: true,
      iommu: true,
      runtimes: ['containerd'],
      hostname: 'fakehw',
    },
  };
}

function cpuOnly(g: Generator): InventoryInit {
  const numa = 256n * GiB;
  return {
    schemaVersion: 1,
    system: {
      vendor: 'Fake Systems',
      product: 'CPU node (fakehw)',
      serial: g.serial('FK', 'system'),
      productUuid: g.uuid('system'),
      boardVendor: 'Fake Systems',
      boardProduct: 'Dual-socket board',
      boardSerial: g.serial('FB', 'board'),
      chassisSerial: g.serial('FC', 'chassis'),
      biosVendor: 'fakehw',
      biosVersion: '1.0.0',
      bootMode: BootMode.UEFI,
      secureBoot: false,
    },
    cpu: {
      vendor: 'GenuineIntel',
      model: 'Intel(R) Xeon(R) Gold 6430',
      architecture: 'x86_64',
      sockets: 2,
      cores: 64,
      threads: 128,
      flags: ['avx2', 'avx512f', 'vmx'],
      numaNodes: [
        { id: 0, cpus: '0-31,64-95', memoryBytes: numa },
        { id: 1, cpus: '32-63,96-127', memoryBytes: numa },
      ],
    },
    memory: {
      totalBytes: 2n * numa,
      hugepages: [{ pageSizeBytes: 2n * MiB }, { pageSizeBytes: GiB }],
      dimms: Array.from({ length: 16 }, (_, i) => ({
        slot: `DIMM${String(i).padStart(2, '0')}`,
        sizeBytes: 32n * GiB,
        speedMts: 4400,
        type: 'DDR5',
        ecc: true,
      })),
      edac: {},
    },
    disks: {
      disks: Array.from({ length: 4 }, (_, i) => {
        const id = String(i);
        return {
          name: `nvme${id}n1`,
          model: 'SAMSUNG MZQL23T8HCLS-00A07',
          serial: g.serial('S6', 'disk-serial', id),
          wwn: `eui.${hex(g.digest('disk', id).subarray(0, 8))}`,
          sizeBytes: DATA_DISK_BYTES,
          transport: DiskTransport.NVME,
          smart: { healthy: true },
        };
      }),
    },
    nics: {
      nics: [0, 1].map((n) => ({
        name: `ens${n + 1}f0`,
        mac: g.mac('nic', String(n)),
        driver: 'ice',
        firmware: '4.40',
        speedMbps: 25_000,
        pciAddress: `0000:${n === 0 ? '17' : '98'}:00.0`,
        numaNode: n,
        rdma: RdmaType.NONE,
        link: LinkState.UP,
        mtu: 1500,
      })),
    },
    bmc: {
      mac: g.mac('bmc'),
      vendor: 'fakehw',
      firmwareVersion: '1.0.0',
      redfish: true,
      ipmi: true,
    },
    os: {
      distro: 'ubuntu',
      distroVersion: '24.04',
      kernel: '6.8.0-45-generic',
      cgroup: CgroupVersion.V2,
      kvm: true,
      iommu: true,
      runtimes: ['containerd'],
      hostname: 'fakehw',
    },
  };
}

function sortBy<T>(items: T[] | undefined, key: (item: T) => string | number | bigint): void {
  if (!items) return;
  // Array.prototype.sort is stable, like Go's sort.SliceStable.
  items.sort((x, y) => {
    const a = key(x);
    const b = key(y);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Sorts every repeated field by its stable key, as inventory.proto requires before encoding (the
 * same rules as Go's `inventory.Canonicalize`). Mutates `inventory`.
 */
export function canonicalizeInventory(inventory: NodeInventory): void {
  const { cpu, memory, disks, nics, gpus, os } = inventory;
  if (cpu) {
    cpu.flags.sort(byCodeUnits);
    sortBy(cpu.numaNodes, (n) => n.id);
  }
  if (memory) {
    sortBy(memory.hugepages, (p) => p.pageSizeBytes);
    sortBy(memory.dimms, (d) => d.slot);
  }
  if (disks) sortBy(disks.disks, (d) => d.name);
  if (nics) sortBy(nics.nics, (n) => n.mac);
  if (gpus) {
    sortBy(gpus.gpus, (g) => g.index);
    for (const gpu of gpus.gpus as Gpu[]) {
      if (gpu.mig) {
        sortBy(gpu.mig.profiles, (p) => p.id);
        sortBy(gpu.mig.instances, (i) => (BigInt(i.giId) << 32n) | BigInt(i.ciId));
      }
      sortBy(gpu.nvlinks, (l) => l.link);
      sortBy(gpu.topology, (p) => p.peerUuid);
    }
  }
  if (os) os.runtimes.sort(byCodeUnits);
  if (inventory.images) sortBy(inventory.images.images, (image) => Buffer.from(image.sha256).toString('hex'));
}

/**
 * Encodes every section present in `inventory`, in `INVENTORY_SECTIONS` order: protobuf binary of
 * the canonicalized section message and its SHA-256 (Go's `inventory.EncodeSections`).
 * Canonicalizes `inventory` in place first.
 */
export function encodeInventorySections(inventory: NodeInventory): EncodedSection[] {
  canonicalizeInventory(inventory);
  const sections: EncodedSection[] = [];
  for (const name of INVENTORY_SECTIONS) {
    const value = inventory[name];
    if (value === undefined) continue;
    const content = toBinary(inventorySectionSchemas[name] as never, value as never);
    sections.push({
      name,
      content,
      sha256: new Uint8Array(createHash('sha256').update(content).digest()),
    });
  }
  return sections;
}

/** Section name → SHA-256, the map `Hello.inventory_hashes` and every 10th heartbeat carry. */
export function inventoryHashes(inventory: NodeInventory): Record<string, Uint8Array> {
  return Object.fromEntries(encodeInventorySections(inventory).map((s) => [s.name, s.sha256]));
}

/**
 * Builds a fake node. The same options always yield the same inventory (and section hashes);
 * different seeds yield different serials, UUIDs and MACs.
 */
export function fakeHardware(options: FakeHardwareOptions = {}): FakeHardware {
  const seed =
    typeof options.seed === 'string' ? options.seed : BigInt(options.seed ?? 0).toString();
  const variant = options.variant ?? 'hgx-h100';
  const g = new Generator(seed);
  let inventory: NodeInventory;
  let expectedGpuCount: number;
  switch (variant) {
    case 'hgx-h100':
      inventory = create(NodeInventorySchema, hgxH100(g));
      expectedGpuCount = GPU_COUNT;
      break;
    case 'hgx-h100-gpu-missing': {
      const position = options.missingGpu ?? g.digest('missing-gpu')[0]! % GPU_COUNT;
      if (!Number.isInteger(position) || position < 0 || position >= GPU_COUNT)
        throw new RangeError(`missingGpu must be 0..${GPU_COUNT - 1}`);
      inventory = create(NodeInventorySchema, hgxH100(g));
      removeGpu(inventory, position);
      expectedGpuCount = GPU_COUNT;
      break;
    }
    case 'l40s':
      inventory = create(NodeInventorySchema, l40s(g));
      expectedGpuCount = 4;
      break;
    case 'cpu':
      inventory = create(NodeInventorySchema, cpuOnly(g));
      expectedGpuCount = 0;
      break;
    default:
      throw new RangeError(`unknown fake hardware variant ${String(variant)}`);
  }
  canonicalizeInventory(inventory);
  const gpuUuids = (inventory.gpus?.gpus ?? []).map((gpu) => gpu.uuid);
  const system = inventory.system!;
  return {
    variant,
    seed,
    inventory,
    expectedGpuCount,
    gpuUuids,
    claims: {
      productUuid: system.productUuid,
      productSerial: system.serial,
      boardSerial: system.boardSerial,
      chassisSerial: system.chassisSerial,
      sysVendor: system.vendor,
      productName: system.product,
      permanentMacs: (inventory.nics?.nics ?? []).map((nic) => nic.mac).sort(byCodeUnits),
      gpuUuids: [...gpuUuids].sort(byCodeUnits),
      bmcMac: inventory.bmc?.mac ?? '',
      hostname: inventory.os?.hostname ?? '',
    },
  };
}
