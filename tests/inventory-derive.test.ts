import { create } from '@bufbuild/protobuf';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DiskSchema,
  DisksSectionSchema,
  GpuLinkType,
  GpuSchema,
  GpusSectionSchema,
  MigMode,
  NicSchema,
  NicsSectionSchema,
  OsSectionSchema,
  SystemSectionSchema,
  CpuSectionSchema,
} from '@better-compute/protocol';
import {
  devicesFromGpus,
  diffInventory,
  gpuLinks,
  isPartitionPending,
  poolSharing,
  slotDeviceId,
  hardwareKey,
  hardwareKeyFromClaims,
  inventoryConditions,
  cpuModelLabelValue,
  inventoryLabels,
  majorVersion,
  mergeNoScheduleReasons,
  permanentMac,
  planDevices,
  usableDmiValue,
  usableProductUuid,
} from '@better-compute/inventory';

const GiB = 1024n ** 3n;
const h100 = (index: number, extra: Partial<Parameters<typeof create<typeof GpuSchema>>[1]> = {}) =>
  create(GpuSchema, {
    index,
    uuid: `GPU-${index.toString().padStart(4, '0')}`,
    name: 'NVIDIA H100 80GB HBM3',
    vramBytes: 80n * GiB,
    numaNode: index < 4 ? 0 : 1,
    pciBusId: `0000:${(0x18 + index).toString(16)}:00.0`,
    topology: [{ peerUuid: 'GPU-x', link: GpuLinkType.NV, nvlinks: 18 }],
    ...extra,
  });
const board = (count = 8, extra: Partial<Parameters<typeof create<typeof GpusSectionSchema>>[1]> = {}) =>
  create(GpusSectionSchema, {
    driverVersion: '550.90.07',
    cudaDriverVersion: '12.4',
    gpus: Array.from({ length: count }, (_, i) => h100(i)),
    ...extra,
  });

describe('devicesFromGpus', () => {
  it('turns every GPU into one bookable atom with selector attributes', () => {
    const devices = devicesFromGpus('node_1', board(8));
    expect(devices).toHaveLength(8);
    expect(devices[0]).toEqual({
      id: 'GPU-0000',
      nodeId: 'node_1',
      class: 'gpu',
      bookable: true,
      healthy: true,
      attributes: {
        gpuProduct: 'H100-SXM5-80GB',
        gpuModel: 'H100',
        vramGiB: 80,
        index: 0,
        pciBusId: '0000:18:00.0',
        numaNode: 0,
        driverVersion: '550.90.07',
        nvlinkPeers: 1,
      },
    });
  });

  it('applies the atom rule: a MIG GPU is an unbookable parent of its instances', () => {
    const section = board(1);
    section.gpus[0]!.mig = {
      $typeName: 'bettercompute.agent.v1.GpuMig',
      capable: true,
      current: MigMode.ENABLED,
      pending: MigMode.ENABLED,
      profiles: [],
      instances: [
        { $typeName: 'bettercompute.agent.v1.MigInstance', giId: 2, ciId: 0, profile: '3g.40gb', uuid: 'MIG-b' },
        { $typeName: 'bettercompute.agent.v1.MigInstance', giId: 1, ciId: 0, profile: '3g.40gb', uuid: 'MIG-a' },
      ],
    };
    const devices = devicesFromGpus('node_1', section);
    expect(devices.map((d) => [d.id, d.class, d.bookable, d.parentId])).toEqual([
      ['GPU-0000', 'gpu', false, undefined],
      ['GPU-0000/gi1/ci0', 'gpu.mig', true, 'GPU-0000'],
      ['GPU-0000/gi2/ci0', 'gpu.mig', true, 'GPU-0000'],
    ]);
  });

  it('keeps a failed-row-remap GPU visible but unhealthy, and skips GPUs without a UUID', () => {
    const section = board(3);
    section.gpus[1]!.rowRemap = {
      $typeName: 'bettercompute.agent.v1.GpuRowRemap',
      correctable: 0,
      uncorrectable: 3,
      pending: false,
      failure: true,
    };
    section.gpus[2]!.uuid = '';
    const devices = devicesFromGpus('n', section);
    expect(devices.map((d) => [d.id, d.healthy])).toEqual([
      ['GPU-0000', true],
      ['GPU-0001', false],
    ]);
  });
});

describe('fractional GPUs (§10.6)', () => {
  it('splits each GPU of a timeslice pool into slot atoms under an unbookable parent', () => {
    const devices = devicesFromGpus('n', board(2), { mode: 'timeslice', replicas: 3 });
    expect(devices.map((d) => [d.id, d.class, d.bookable, d.parentId ?? null])).toEqual([
      ['GPU-0000', 'gpu', false, null],
      ['GPU-0000/s0', 'gpu.slot', true, 'GPU-0000'],
      ['GPU-0000/s1', 'gpu.slot', true, 'GPU-0000'],
      ['GPU-0000/s2', 'gpu.slot', true, 'GPU-0000'],
      ['GPU-0001', 'gpu', false, null],
      ['GPU-0001/s0', 'gpu.slot', true, 'GPU-0001'],
      ['GPU-0001/s1', 'gpu.slot', true, 'GPU-0001'],
      ['GPU-0001/s2', 'gpu.slot', true, 'GPU-0001'],
    ]);
    expect(devices[1]!.attributes).toMatchObject({ sharing: 'timeslice', slot: 0, slots: 3, gpuModel: 'H100' });
  });

  it('gives MPS slots an equal share of 100 units, with defaults when the pool names no count', () => {
    const devices = devicesFromGpus('n', board(1), { mode: 'mps' });
    expect(devices.filter((d) => d.class === 'gpu.slot')).toHaveLength(10);
    expect(devices[1]!.attributes).toMatchObject({ sharing: 'mps', mpsUnits: 10 });
    expect(devicesFromGpus('n', board(1), { mode: 'timeslice' }).filter((d) => d.class === 'gpu.slot')).toHaveLength(4);
    expect(devicesFromGpus('n', board(1), { mode: 'exclusive' })).toHaveLength(1);
  });

  it('freezes every atom of a GPU whose MIG mode is changing', () => {
    const section = board(1);
    section.gpus[0]!.mig = {
      $typeName: 'bettercompute.agent.v1.GpuMig',
      capable: true,
      current: MigMode.DISABLED,
      pending: MigMode.ENABLED,
      profiles: [],
      instances: [],
    };
    const [gpu] = devicesFromGpus('n', section, { mode: 'timeslice', replicas: 2 });
    expect(gpu).toMatchObject({ bookable: false, attributes: { partitionPending: true } });
    expect(devicesFromGpus('n', section, { mode: 'timeslice', replicas: 2 }).every((d) => !d.bookable)).toBe(true);
    expect(isPartitionPending(section.gpus[0]!)).toBe(true);
  });

  it('reads the sharing policy from a pool row', () => {
    expect(poolSharing('timeslice', { sharing: { replicas: 8 } })).toEqual({ mode: 'timeslice', replicas: 8 });
    expect(poolSharing('mps', {})).toEqual({ mode: 'mps' });
    expect(poolSharing(null, {})).toBeUndefined();
    expect(slotDeviceId('GPU-a', 3)).toBe('GPU-a/s3');
  });
});

describe('gpuLinks', () => {
  it('lists each GPU pair once, a < b, keeping the better link when directions disagree', () => {
    const section = board(3);
    const link = (peerUuid: string, type: GpuLinkType) => ({
      $typeName: 'bettercompute.agent.v1.GpuPeerLink' as const,
      peerUuid,
      link: type,
      nvlinks: 0,
    });
    section.gpus[0]!.topology = [link('GPU-0001', GpuLinkType.NV), link('GPU-0002', GpuLinkType.SYS), link('GPU-9999', GpuLinkType.NV)];
    section.gpus[1]!.topology = [link('GPU-0000', GpuLinkType.PIX), link('GPU-0001', GpuLinkType.NV)];
    section.gpus[2]!.topology = [link('GPU-0000', GpuLinkType.UNSPECIFIED)];
    expect(gpuLinks(section)).toEqual([
      { a: 'GPU-0000', b: 'GPU-0001', link: 'NV' },
      { a: 'GPU-0000', b: 'GPU-0002', link: 'SYS' },
    ]);
    expect(gpuLinks(undefined)).toEqual([]);
  });
});

describe('planDevices', () => {
  const derived = devicesFromGpus('n', board(2));

  it('upserts only new or changed devices', () => {
    expect(planDevices([], derived).upsert).toHaveLength(2);
    expect(planDevices(derived, derived)).toEqual({ upsert: [], remove: [], quarantine: [] });
    const changed = [{ ...derived[0]!, attributes: { ...derived[0]!.attributes, vramGiB: 40 } }, derived[1]!];
    expect(planDevices(changed, derived).upsert.map((d) => d.id)).toEqual(['GPU-0000']);
  });

  it('deletes a vanished device, but quarantines one that still has live bookings', () => {
    const plan = planDevices(derived, [], { bookedDeviceIds: new Set(['GPU-0001']) });
    expect(plan).toEqual({ upsert: [], remove: ['GPU-0000'], quarantine: ['GPU-0001'] });
    // Already quarantined: nothing more to write until the bookings end.
    const stored = [derived[0]!, { ...derived[1]!, healthy: false }];
    expect(planDevices(stored, [], { bookedDeviceIds: new Set(['GPU-0001']) }).quarantine).toEqual([]);
  });

  it('never deletes the parent of a booked MIG instance', () => {
    const parent = { ...derived[0]!, bookable: false };
    const child = { id: 'GPU-0000/gi1/ci0', nodeId: 'n', parentId: 'GPU-0000', class: 'gpu.mig' as const, bookable: true, healthy: true, attributes: {} };
    const plan = planDevices([parent, child], [], { bookedDeviceIds: new Set([child.id]) });
    expect(plan.remove).toEqual([]);
    expect(plan.quarantine.sort()).toEqual(['GPU-0000', 'GPU-0000/gi1/ci0']);
  });

  it('does not let inventory heal a device Health quarantined', () => {
    const plan = planDevices(derived, derived, { unhealthy: new Set(['GPU-0000']) });
    expect(plan.upsert).toEqual([{ ...derived[0]!, healthy: false }]);
  });
});

describe('labels and conditions', () => {
  it('derives GFD-style labels, sorted by key', () => {
    const labels = inventoryLabels({
      gpus: board(8),
      cpu: create(CpuSectionSchema, { architecture: 'x86_64', vendor: 'AuthenticAMD', model: 'AMD EPYC 9654 96-Core Processor' }),
      os: create(OsSectionSchema, { distro: 'ubuntu', kernel: '6.8.0-45', kvm: true }),
    });
    expect(Object.fromEntries(labels.map((l) => [l.key, l.value]))).toEqual({
      'cpu.arch': 'x86_64',
      'cpu.model': 'AMD-EPYC-9654-96-Core-Processor',
      'cpu.vendor': 'AuthenticAMD',
      'cuda.driver.major': '12',
      'gpu.count': '8',
      'gpu.model': 'H100',
      'gpu.present': 'true',
      'gpu.product': 'H100-SXM5-80GB',
      'gpu.vramGiB': '80',
      'kvm.available': 'true',
      'mig.capable': 'false',
      'nvidia.driver.version': '550.90.07',
      'os.distro': 'ubuntu',
      'os.kernel': '6.8.0-45',
    });
    expect(labels.every((l) => l.source === 'inventory')).toBe(true);
    expect(labels.map((l) => l.key)).toEqual([...labels.map((l) => l.key)].sort());
  });

  it('normalizes the CPU model into a label value', () => {
    expect(cpuModelLabelValue('Intel(R) Xeon(R) Platinum 8480+')).toBe('Intel-Xeon-Platinum-8480');
    expect(cpuModelLabelValue('Intel(R) Xeon(R) CPU E5-2690 v4 @ 2.60GHz')).toBe('Intel-Xeon-CPU-E5-2690-v4-2.60GHz');
    expect(cpuModelLabelValue('  Neoverse-V2 ')).toBe('Neoverse-V2');
    expect(cpuModelLabelValue('x'.repeat(62) + ' y')).toBe('x'.repeat(62));
    expect(cpuModelLabelValue('')).toBe('');
    // No model reported: no label.
    const labels = inventoryLabels({ cpu: create(CpuSectionSchema, { architecture: 'arm64' }) });
    expect(labels.some((l) => l.key === 'cpu.model')).toBe(false);
  });

  it('labels mixed boards as mixed', () => {
    const section = board(2);
    section.gpus[1]!.name = 'NVIDIA A100-SXM4-80GB';
    const labels = Object.fromEntries(inventoryLabels({ gpus: section }).map((l) => [l.key, l.value]));
    expect(labels['gpu.product']).toBe('mixed');
    expect(labels['gpu.model']).toBe('mixed');
  });

  it('raises GpuCountMismatch and GpuModelUnknown as NoSchedule, and clears them', () => {
    const ok = inventoryConditions({ gpus: board(8) }, { gpuCount: 8, gpuModel: 'H100' });
    expect(ok.map((c) => [c.type, c.status])).toEqual([
      ['GpuCountMismatch', 'false'],
      ['GpuModelUnknown', 'false'],
    ]);
    const short = inventoryConditions({ gpus: board(7) }, { gpuCount: 8 });
    expect(short[0]).toMatchObject({ status: 'true', noSchedule: true, message: 'expected 8 GPUs, found 7' });
    const wrongModel = inventoryConditions({ gpus: board(8) }, { gpuModel: 'B200' });
    expect(wrongModel[0]!.message).toBe('expected B200 GPUs, found H100');
    const odd = board(1);
    odd.gpus[0]!.name = 'NVIDIA GH200 480GB';
    expect(inventoryConditions({ gpus: odd })[1]).toMatchObject({ type: 'GpuModelUnknown', status: 'true' });
  });

  it('reports GpuCountMismatch unknown, not true, when a node never sent a gpus section', () => {
    const conditions = inventoryConditions({ os: create(OsSectionSchema, { distro: 'ubuntu' }) }, { gpuCount: 8 });
    expect(conditions[0]).toMatchObject({ type: 'GpuCountMismatch', status: 'unknown', noSchedule: false });
    expect(inventoryConditions({ gpus: board(0) }, { gpuCount: 8 })[0]).toMatchObject({ status: 'true' });
  });

  it('rewrites only the condition entries it owns in no_schedule_reasons', () => {
    const current = ['GpuModelUnknown', 'unreachable', 'unhealthy.gpu/GPU-1'];
    const next = mergeNoScheduleReasons(current, ['GpuCountMismatch', 'GpuModelUnknown'], [
      { type: 'GpuCountMismatch', status: 'true', noSchedule: true },
      { type: 'GpuModelUnknown', status: 'false', noSchedule: false },
    ]);
    expect(next).toEqual(['GpuCountMismatch', 'unhealthy.gpu/GPU-1', 'unreachable']);
  });

  it('reads driver major versions', () => {
    expect(majorVersion('550.90.07')).toBe('550');
    expect(majorVersion('12')).toBe('12');
    expect(majorVersion('beta')).toBeUndefined();
  });
});

describe('hardwareKey', () => {
  const system = create(SystemSectionSchema, {
    productUuid: '4C4C4544-0042-3510-8052-B7C04F4B3732',
    serial: 'B5RKK72',
  });
  const nics = create(NicsSectionSchema, {
    nics: [
      create(NicSchema, { name: 'eno1', mac: 'B8:CE:F6:01:02:03' }),
      create(NicSchema, { name: 'eno2', mac: 'b8:ce:f6:01:02:04' }),
      create(NicSchema, { name: 'vf0', mac: '02:00:00:00:00:01' }),
    ],
  });

  it('is stable under ordering and case, and trusted with two or more identifiers', () => {
    const a = hardwareKey({ system, nics, gpus: board(2) })!;
    const shuffled = create(NicsSectionSchema, { nics: [...nics.nics].reverse() });
    const b = hardwareKey({ system, nics: shuffled, gpus: board(2) })!;
    expect(a.key).toBe(b.key);
    expect(a.trusted).toBe(true);
    expect(a.independent).toBe(4);
    expect(a.identifiers.macs).toEqual(['b8:ce:f6:01:02:03', 'b8:ce:f6:01:02:04']);
    expect(a.identifiers.productUuid).toBe('4c4c4544-0042-3510-8052-b7c04f4b3732');
  });

  it('drops OEM placeholders, and does not trust a key with one identifier left', () => {
    const placeholder = create(SystemSectionSchema, {
      productUuid: '03000200-0400-0500-0006-000700080009',
      serial: 'To Be Filled By O.E.M.',
      boardSerial: 'Default string',
    });
    const key = hardwareKey({ system: placeholder, nics })!;
    expect(key.identifiers.productUuid).toBeUndefined();
    expect(key.identifiers.serial).toBeUndefined();
    expect(key.trusted).toBe(false);
    expect(hardwareKey({ system: placeholder })).toBeUndefined();
  });

  it('hashes join claims exactly as it hashes the matching inventory', () => {
    const fromSections = hardwareKey({ system, nics, gpus: board(2) })!;
    const fromClaims = hardwareKeyFromClaims({
      productUuid: '4c4c4544-0042-3510-8052-b7c04f4b3732',
      serial: 'b5rkk72',
      macs: ['b8-ce-f6-01-02-04', 'B8:CE:F6:01:02:03', '02:00:00:00:00:01'],
      gpuUuids: ['gpu-0001', 'GPU-0000'],
    })!;
    expect(fromClaims.key).toBe(fromSections.key);
    expect(fromClaims.identifiers).toEqual({ ...fromSections.identifiers, gpuUuids: ['gpu-0000', 'gpu-0001'] });
    expect(hardwareKeyFromClaims({ productUuid: '00020003-0004-0005-0006-000700080009' })).toBeUndefined();
    expect(hardwareKeyFromClaims({})).toBeUndefined();
  });

  it('separates machines that differ in any identifier', () => {
    const base = hardwareKey({ system, nics })!.key;
    const other = create(SystemSectionSchema, { ...system, serial: 'B5RKK73' });
    expect(hardwareKey({ system: other, nics })!.key).not.toBe(base);
  });

  it('normalizes identifiers', () => {
    expect(usableDmiValue('  ABC123 ')).toBe('ABC123');
    expect(usableDmiValue('00000000')).toBeUndefined();
    expect(usableDmiValue('Not Specified')).toBeUndefined();
    expect(usableProductUuid('FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF')).toBeUndefined();
    expect(usableProductUuid('4c4c454400423510 8052b7c04f4b3732')).toBeUndefined();
    expect(permanentMac('01:00:5e:00:00:01')).toBeUndefined(); // multicast
    expect(permanentMac('00:00:00:00:00:00')).toBeUndefined();
    expect(permanentMac('B8-CE-F6-01-02-03')).toBe('b8:ce:f6:01:02:03');
  });

  it('is a pure function of the identifier sets (property)', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({ min: 0, max: 0xffffff }), { minLength: 1, maxLength: 6 }), (suffixes) => {
        const macs = suffixes.map((s) => `b8:ce:f6:${s.toString(16).padStart(6, '0').match(/../g)!.join(':')}`);
        const one = create(NicsSectionSchema, { nics: macs.map((mac) => create(NicSchema, { mac })) });
        const two = create(NicsSectionSchema, { nics: [...macs].reverse().map((mac) => create(NicSchema, { mac: mac.toUpperCase() })) });
        expect(hardwareKey({ system, nics: one })!.key).toBe(hardwareKey({ system, nics: two })!.key);
      }),
    );
  });
});

describe('diffInventory', () => {
  it('reports GPUs missing and added by UUID, and driver changes', () => {
    const before = board(3);
    const after = board(3, { driverVersion: '560.28.03' });
    after.gpus[2] = h100(9);
    const changes = diffInventory({ gpus: before }, { gpus: after });
    expect(changes.map((c) => [c.type, c.deviceId])).toEqual([
      ['gpu.missing', 'GPU-0002'],
      ['gpu.added', 'GPU-0009'],
      ['driver.changed', undefined],
    ]);
    expect(changes[2]!.after).toEqual({ driverVersion: '560.28.03', cudaDriverVersion: '12.4' });
  });

  it('reports MIG layout changes and replaced disks', () => {
    const before = board(1);
    const after = board(1);
    after.gpus[0]!.mig = {
      $typeName: 'bettercompute.agent.v1.GpuMig',
      capable: true,
      current: MigMode.ENABLED,
      pending: MigMode.ENABLED,
      profiles: [],
      instances: [],
    };
    const disks = (serial: string) =>
      create(DisksSectionSchema, { disks: [create(DiskSchema, { name: 'nvme0n1', serial, wwn: `eui.${serial}` })] });
    const changes = diffInventory(
      { gpus: before, disks: disks('S1') },
      { gpus: after, disks: disks('S2') },
    );
    expect(changes.map((c) => c.type)).toEqual(['mig.layout.changed', 'disk.replaced']);
    expect(changes[1]!.deviceId).toBe('eui.S2');
  });

  it('reports nothing for identical inventories or a section present on one side only', () => {
    expect(diffInventory({ gpus: board(8) }, { gpus: board(8) })).toEqual([]);
    expect(diffInventory({}, { gpus: board(8) })).toEqual([]);
  });
});
