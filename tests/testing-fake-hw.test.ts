import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import {
  BootMode,
  GpuLinkType,
  INVENTORY_SECTIONS,
  LinkState,
  MigMode,
  NodeInventorySchema,
  decodeInventorySection,
} from '@better-compute/protocol';
import {
  H100_GPU_NAME,
  encodeInventorySections,
  fakeHardware,
  inventoryHashes,
} from '@better-compute/testing';

// Fake hardware (PLAN.md §6 `sim`, §15), mirroring daemon/internal/fakehw and the section encoding of
// daemon/internal/inventory.

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('section encoding (the goldens of daemon/internal/inventory/hash_test.go)', () => {
  const section = (init: Parameters<typeof create<typeof NodeInventorySchema>>[1]) => {
    const sections = encodeInventorySections(create(NodeInventorySchema, init));
    expect(sections).toHaveLength(1);
    return { content: hex(sections[0]!.content), sha256: hex(sections[0]!.sha256) };
  };

  it('CpuSection, canonicalized (flags and NUMA nodes sorted)', () => {
    expect(
      section({
        cpu: {
          vendor: 'GenuineIntel',
          model: 'x',
          architecture: 'x86_64',
          sockets: 2,
          threads: 300,
          flags: ['b', '', 'a'],
          numaNodes: [
            { id: 1, cpus: '8-15', memoryBytes: 1n << 33n },
            { id: 0, cpus: '0-7', memoryBytes: 1024n },
          ],
        },
      }),
    ).toEqual({
      content:
        '0a0c47656e75696e65496e74656c1201781a067838365f3634200230ac023a003a01613a016242081203302d37188008420e08011204382d3135188080808020',
      sha256: '2b7a390c6c08b84abe73393518862ff0600ffedeebc5138f8b5ff7fb01e7247a',
    });
  });

  it('SystemSection with an explicit secure_boot=false', () => {
    expect(
      section({
        system: {
          vendor: 'Fake',
          productUuid: 'abc',
          bootMode: BootMode.UEFI,
          secureBoot: false,
          tpm: { version: '2.0' },
        },
      }),
    ).toEqual({
      content: '0a0446616b652203616263580160006a050a03322e30',
      sha256: 'fe4e9ec951dbb525b4e20c1732f6577336e09335071566b7202268349555699d',
    });
  });

  it('GpusSection, canonicalized (GPUs by index, NVLinks by link)', () => {
    expect(
      section({
        gpus: {
          driverVersion: '550.90.07',
          gpus: [
            { index: 1, uuid: 'GPU-b' },
            {
              index: 0,
              uuid: 'GPU-a',
              name: H100_GPU_NAME,
              vramBytes: 85520809984n,
              numaNode: 0,
              powerLimitMw: 700_000,
              persistenceMode: true,
              cudaComputeCapabilityMajor: 9,
              mig: { capable: true, current: MigMode.DISABLED },
              nvlinks: [
                { link: 1, state: LinkState.DOWN },
                { link: 0, state: LinkState.UP, peer: 'nvswitch:0', version: 4 },
              ],
              topology: [{ peerUuid: 'GPU-b', link: GpuLinkType.NV, nvlinks: 18 }],
              ecc: { enabled: true, pendingEnabled: false, volatileCounts: {} },
            },
          ],
        },
      }),
    ).toEqual({
      content:
        '0a093535302e39302e3037226712054750552d6122154e5649444941204831303020383047422048424d33308080c0cbbe02500058e0dc2a60017009820104080110018a011010011a0a6e767377697463683a3020048a01040801100292010b0a054750552d6210011812a20106080110001a002209080112054750552d62',
      sha256: 'afa767f5887836179635738b252fbbde12d39d28ef4bc6b797cf3a8703065eec',
    });
  });

  it('an empty section hashes its empty encoding', () => {
    expect(section({ bmc: {} })).toEqual({
      content: '',
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
  });
});

describe('fakeHardware()', () => {
  it('is deterministic per seed, and seeds differ only in seeded sections (as fakehw_test.go)', () => {
    expect(inventoryHashes(fakeHardware({ seed: 7 }).inventory)).toEqual(
      inventoryHashes(fakeHardware({ seed: 7n }).inventory),
    );
    const one = inventoryHashes(fakeHardware({ seed: 1 }).inventory);
    const two = inventoryHashes(fakeHardware({ seed: 2 }).inventory);
    // Fake GPU hosts have no image cache, so no `images` section.
    expect(Object.keys(one)).toEqual(INVENTORY_SECTIONS.filter((s) => s !== 'images'));
    for (const name of ['system', 'disks', 'nics', 'gpus', 'bmc'])
      expect(one[name]).not.toEqual(two[name]);
    for (const name of ['cpu', 'memory', 'os']) expect(one[name]).toEqual(two[name]);
  });

  it('builds the HGX H100 shape of daemon/internal/fakehw', () => {
    const hw = fakeHardware({ seed: 0 });
    const inv = hw.inventory;
    const gpus = inv.gpus!.gpus;
    expect(gpus).toHaveLength(8);
    expect(new Set(gpus.map((g) => g.uuid)).size).toBe(8);
    expect(gpus.map((g) => g.pciBusId)[0]).toBe('00000000:18:00.0');
    for (const gpu of gpus) {
      expect(gpu).toMatchObject({
        name: H100_GPU_NAME,
        vramBytes: 81559n << 20n,
        architecture: 'hopper',
      });
      expect(gpu.mig?.capable).toBe(true);
      expect(gpu.topology).toHaveLength(7);
      expect(gpu.topology.every((p) => p.link === GpuLinkType.NV && p.nvlinks === 18)).toBe(true);
      expect(gpu.nvlinks).toHaveLength(18);
      expect(gpu.uuid).toMatch(
        /^GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
    expect(gpus.map((g) => g.numaNode)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    expect(inv.cpu).toMatchObject({ sockets: 2, cores: 112, threads: 224 });
    const dimms = inv.memory!.dimms.reduce((sum, d) => sum + d.sizeBytes, 0n);
    const numa = inv.cpu!.numaNodes.reduce((sum, n) => sum + n.memoryBytes, 0n);
    expect(dimms).toBe(inv.memory!.totalBytes);
    expect(numa).toBe(inv.memory!.totalBytes);
    expect(inv.disks!.disks).toHaveLength(10);
    expect(inv.nics!.nics.map((n) => n.mac)).toEqual([...inv.nics!.nics.map((n) => n.mac)].sort());
    expect(inv.nics!.nics.every((n) => n.mac.startsWith('02:bc:'))).toBe(true);
    expect(inv.system!.secureBoot).toBe(false);
    expect(hw.expectedGpuCount).toBe(8);
    expect(hw.claims.gpuUuids).toEqual([...hw.gpuUuids].sort());
    // The encoded section decodes to the same GPUs.
    const encoded = encodeInventorySections(inv).find((s) => s.name === 'gpus')!;
    expect(decodeInventorySection('gpus', encoded.content).gpus.map((g) => g.uuid)).toEqual(
      hw.gpuUuids,
    );
  });

  it('variants: one GPU missing, 4x L40S on PCIe, and CPU-only without a gpus section', () => {
    const full = fakeHardware({ seed: 'n1' });
    const missing = fakeHardware({ seed: 'n1', variant: 'hgx-h100-gpu-missing', missingGpu: 3 });
    expect(missing.gpuUuids).toEqual(full.gpuUuids.filter((_, i) => i !== 3));
    expect(missing.inventory.gpus!.gpus.map((g) => g.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(missing.inventory.gpus!.gpus.every((g) => g.topology.length === 6)).toBe(true);
    expect(missing.expectedGpuCount).toBe(8);
    const hashes = inventoryHashes(missing.inventory);
    expect(hashes['gpus']).not.toEqual(inventoryHashes(full.inventory)['gpus']);
    expect(hashes['system']).toEqual(inventoryHashes(full.inventory)['system']);
    expect(() => fakeHardware({ variant: 'hgx-h100-gpu-missing', missingGpu: 8 })).toThrow(
      RangeError,
    );

    const l40s = fakeHardware({ seed: 'n1', variant: 'l40s' });
    const gpus = l40s.inventory.gpus!.gpus;
    expect(gpus.map((g) => g.name)).toEqual(Array(4).fill('NVIDIA L40S'));
    expect(gpus.every((g) => g.nvlinks.length === 0 && g.mig?.capable === false)).toBe(true);
    expect(gpus[0]!.topology.map((p) => GpuLinkType[p.link]).sort()).toEqual([
      'NODE',
      'SYS',
      'SYS',
    ]);

    const cpu = fakeHardware({ seed: 'n1', variant: 'cpu' });
    expect(cpu.inventory.gpus).toBeUndefined();
    expect(cpu.gpuUuids).toEqual([]);
    expect(Object.keys(inventoryHashes(cpu.inventory))).toEqual(
      INVENTORY_SECTIONS.filter((s) => s !== 'gpus' && s !== 'images'),
    );
  });
});
