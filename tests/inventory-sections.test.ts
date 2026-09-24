import { create, toBinary } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import {
  CpuSectionSchema,
  GpusSectionSchema,
  OsSectionSchema,
} from '@better-compute/protocol';
import {
  inventoryDigest,
  maxSectionBytes,
  mergeSections,
  normalizeSectionHashes,
  sectionsToRequest,
  sha256Hex,
  verifySection,
  type ReportedSection,
} from '@better-compute/inventory';

// Section transfer (PLAN.md §10.1). The golden vectors are the Go daemon's
// (daemon/internal/inventory/hash_test.go), so this pins both sides to the same bytes.
const golden = {
  cpu: {
    hex: '0a0c47656e75696e65496e74656c1201781a067838365f3634200230ac023a003a01613a016242081203302d37188008420e08011204382d3135188080808020',
    sha: '2b7a390c6c08b84abe73393518862ff0600ffedeebc5138f8b5ff7fb01e7247a',
  },
  system: {
    hex: '0a0446616b652203616263580160006a050a03322e30',
    sha: 'fe4e9ec951dbb525b4e20c1732f6577336e09335071566b7202268349555699d',
  },
  gpus: {
    hex: '0a093535302e39302e3037226712054750552d6122154e5649444941204831303020383047422048424d33308080c0cbbe02500058e0dc2a60017009820104080110018a011010011a0a6e767377697463683a3020048a01040801100292010b0a054750552d6210011812a20106080110001a002209080112054750552d62',
    sha: 'afa767f5887836179635738b252fbbde12d39d28ef4bc6b797cf3a8703065eec',
  },
} as const;

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
const report = (section: string, content: Uint8Array, sha = sha256Hex(content)): ReportedSection => ({
  section,
  content,
  sha256: Uint8Array.from(Buffer.from(sha, 'hex')),
});

describe('verifySection', () => {
  it('accepts the daemon golden sections and decodes them', () => {
    for (const [name, { hex, sha }] of Object.entries(golden)) {
      const verified = verifySection(report(name, bytes(hex), sha));
      expect(verified.name).toBe(name);
      expect(verified.sha256).toBe(sha);
    }
    const gpus = verifySection(report('gpus', bytes(golden.gpus.hex), golden.gpus.sha));
    if (gpus.name !== 'gpus') throw new Error('unreachable');
    const content = gpus.content as ReturnType<typeof create<typeof GpusSectionSchema>>;
    expect(content.driverVersion).toBe('550.90.07');
    expect(content.gpus.map((g) => g.uuid)).toEqual(['GPU-a', 'GPU-b']);
    expect(content.gpus[0]!.vramBytes).toBe(85520809984n);
  });

  it('rejects a hash that does not match the received bytes', () => {
    const content = bytes(golden.cpu.hex);
    expect(() => verifySection(report('cpu', content, golden.system.sha))).toThrow(
      /does not match its sha256/,
    );
  });

  it('rejects unknown sections, malformed hashes, oversized and undecodable content', () => {
    const content = bytes(golden.cpu.hex);
    expect(() => verifySection(report('gpu', content))).toThrow(/Unknown inventory section/);
    expect(() =>
      verifySection({ section: 'cpu', content, sha256: new Uint8Array(31) }),
    ).toThrow(/malformed sha256/);
    const big = new Uint8Array(maxSectionBytes + 1);
    expect(() => verifySection(report('cpu', big))).toThrow(/limit/);
    const garbage = Uint8Array.of(0xff, 0xff, 0xff);
    expect(() => verifySection(report('cpu', garbage))).toThrow(/does not decode/);
    for (const bad of [() => verifySection(report('cpu', garbage))])
      expect(bad).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('accepts a hex string hash too', () => {
    const content = bytes(golden.system.hex);
    expect(
      verifySection({ section: 'system', content, sha256: golden.system.sha.toUpperCase() as never })
        .sha256,
    ).toBe(golden.system.sha);
  });
});

describe('section hashes', () => {
  it('normalizes reported hashes, dropping sections this build does not know', () => {
    const hashes = normalizeSectionHashes({
      cpu: bytes(golden.cpu.sha),
      gpus: golden.gpus.sha.toUpperCase(),
      quantum: bytes(golden.cpu.sha),
    });
    expect(hashes).toEqual({ cpu: golden.cpu.sha, gpus: golden.gpus.sha });
    expect(() => normalizeSectionHashes({ cpu: 'abc' })).toThrow(/malformed/);
  });

  it('requests only sections whose hash changed, in section order', () => {
    const stored = { cpu: golden.cpu.sha, gpus: golden.gpus.sha, os: 'a'.repeat(64) };
    const reported = { system: golden.system.sha, cpu: golden.cpu.sha, gpus: 'b'.repeat(64) };
    expect(sectionsToRequest(stored, reported)).toEqual(['system', 'gpus']);
    expect(sectionsToRequest(stored, stored)).toEqual([]);
  });

  it('digests a snapshot independently of key order and changes with any hash', () => {
    const a = inventoryDigest({ cpu: golden.cpu.sha, gpus: golden.gpus.sha });
    const b = inventoryDigest({ gpus: golden.gpus.sha, cpu: golden.cpu.sha });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(inventoryDigest({ cpu: golden.cpu.sha })).not.toBe(a);
    expect(inventoryDigest({})).toBe(sha256Hex(''));
  });
});

describe('mergeSections', () => {
  const os = create(OsSectionSchema, { distro: 'ubuntu', kernel: '6.8.0' });
  const osBytes = toBinary(OsSectionSchema, os);
  const cpuBytes = toBinary(CpuSectionSchema, create(CpuSectionSchema, { architecture: 'x86_64' }));

  it('folds pulled sections into the stored ones and reports what changed and vanished', () => {
    const cpu = verifySection(report('cpu', cpuBytes));
    const first = mergeSections(
      { hashes: {}, sections: {} },
      { cpu: cpu.sha256 },
      [cpu],
    );
    expect(first.changed).toEqual(['cpu']);
    expect(first.sections.cpu?.architecture).toBe('x86_64');

    const osSection = verifySection(report('os', osBytes));
    const second = mergeSections(first, { cpu: cpu.sha256, os: osSection.sha256 }, [osSection]);
    expect(second.changed).toEqual(['os']);
    expect(second.sections.cpu).toBe(first.sections.cpu);
    expect(second.digest).toBe(inventoryDigest({ cpu: cpu.sha256, os: osSection.sha256 }));

    const third = mergeSections(second, { os: osSection.sha256 }, []);
    expect(third.removed).toEqual(['cpu']);
    expect(third.sections.cpu).toBeUndefined();
    expect(third.changed).toEqual([]);
  });

  it('refuses a changed section that was not pulled, or a pull under another hash', () => {
    const cpu = verifySection(report('cpu', cpuBytes));
    expect(() => mergeSections({ hashes: {}, sections: {} }, { cpu: cpu.sha256 }, [])).toThrow(
      /was not pulled/,
    );
    expect(() =>
      mergeSections({ hashes: {}, sections: {} }, { cpu: 'c'.repeat(64) }, [cpu]),
    ).toThrow(/was pulled with hash/);
  });
});
