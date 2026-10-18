import { describe, expect, it } from 'vitest';
import { defaultMeterGpuModels, meterCatalog, type PoolPolicy } from '@better-compute/core';
import {
  billingModeOf,
  meterLinesFor,
  type BillableShape,
  type BillingMode,
} from '@better-compute/vps';

const base: BillableShape = {
  vcpu: 4,
  memoryGiB: 16,
  spot: false,
  reserved: false,
  granted: false,
};
const lines = (shape: Partial<BillableShape>, mode: BillingMode = 'metered') =>
  meterLinesFor({ ...base, ...shape }, mode, 'running');

describe('rules', () => {
  it('composes vcpu, memory and the instance line', () => {
    expect(lines({})).toEqual([
      { meter: 'vm.vcpu.hours', perHour: 4 },
      { meter: 'vm.memory.gib.hours', perHour: 16 },
      { meter: 'vm.instance.hours', perHour: 1 },
    ]);
  });

  it('spot GPU: vm.gpu.h100.spot.hours x 8', () => {
    const out = lines({ gpus: { model: 'H100', count: 8 }, spot: true });
    expect(out).toContainEqual({ meter: 'vm.gpu.h100.spot.hours', perHour: 8 });
    expect(out).not.toContainEqual(expect.objectContaining({ meter: 'vm.gpu.h100.hours' }));
  });

  it('on-demand GPU uses the plain model meter', () => {
    expect(lines({ gpus: { model: 'H100', count: 2 } })).toContainEqual({
      meter: 'vm.gpu.h100.hours',
      perHour: 2,
    });
  });

  it('reserved: vm.reserved.* with no .spot, and the instance line stays unprefixed', () => {
    const out = lines({ reserved: true, spot: true, gpus: { model: 'A100', count: 1 } });
    expect(out).toEqual([
      { meter: 'vm.reserved.vcpu.hours', perHour: 4 },
      { meter: 'vm.reserved.memory.gib.hours', perHour: 16 },
      { meter: 'vm.reserved.gpu.a100.hours', perHour: 1 },
      { meter: 'vm.instance.hours', perHour: 1 },
    ]);
    expect(out.some((line) => line.meter.includes('spot'))).toBe(false);
  });

  it('granted: only vm.grant.usage.hours', () => {
    expect(lines({ granted: true, reserved: true, gpus: { model: 'H100', count: 8 } })).toEqual([
      { meter: 'vm.grant.usage.hours', perHour: 1 },
    ]);
  });

  it('flavor meter replaces composition', () => {
    expect(
      lines({
        flavorMeter: 'flavor.a3-highgpu-8g.us-central1.hours',
        gpus: { model: 'H100', count: 8 },
      }),
    ).toEqual([{ meter: 'flavor.a3-highgpu-8g.us-central1.hours', perHour: 1 }]);
  });

  it('granted wins over a flavor meter', () => {
    expect(lines({ granted: true, flavorMeter: 'flavor.x.hours' })).toEqual([
      { meter: 'vm.grant.usage.hours', perHour: 1 },
    ]);
  });

  it('an unknown or malformed GPU model maps to other, never a dead letter', () => {
    expect(lines({ gpus: { model: 'MI300X', count: 1 } })).toContainEqual({
      meter: 'vm.gpu.other.hours',
      perHour: 1,
    });
    expect(lines({ gpus: { model: 'weird model!', count: 1 }, spot: true })).toContainEqual({
      meter: 'vm.gpu.other.spot.hours',
      perHour: 1,
    });
    expect(lines({ gpus: { model: 'other', count: 1 }, reserved: true })).toContainEqual({
      meter: 'vm.reserved.gpu.other.hours',
      perHour: 1,
    });
  });

  it('model names are case-insensitive; an operator catalog can widen the known models', () => {
    expect(lines({ gpus: { model: 'h100', count: 1 } })).toContainEqual({
      meter: 'vm.gpu.h100.hours',
      perHour: 1,
    });
    const out = meterLinesFor(
      { ...base, gpus: { model: 'MI300X', count: 1 } },
      'metered',
      'running',
      {
        gpuModels: ['MI300X'],
      },
    );
    expect(out).toContainEqual({ meter: 'vm.gpu.mi300x.hours', perHour: 1 });
  });

  it('none returns nothing, platform-fee returns the managed line', () => {
    expect(lines({ gpus: { model: 'H100', count: 8 } }, 'none')).toEqual([]);
    expect(lines({ granted: true }, 'none')).toEqual([]);
    expect(lines({ gpus: { model: 'H100', count: 8 } }, 'platform-fee')).toEqual([
      { meter: 'vm.managed.hours', perHour: 1 },
    ]);
  });

  it('stopped returns no lines yet', () => {
    for (const mode of ['metered', 'platform-fee', 'none'] as const)
      expect(meterLinesFor(base, mode, 'stopped')).toEqual([]);
  });

  it('publicIp and disks produce no lines yet', () => {
    expect(lines({ publicIp: true, disks: [{ type: 'pd-ssd', sizeGiB: 100 }] })).toEqual(lines({}));
  });

  it('every meterLinesFor output is in meterCatalog', () => {
    const flavorMeter = 'flavor.a3-highgpu-8g.us-central1.hours';
    const known = new Set(
      meterCatalog({ gpuModels: defaultMeterGpuModels, flavorMeters: [flavorMeter] }).map(
        (meter) => meter.key,
      ),
    );
    const gpuChoices = [
      undefined,
      { model: 'H100', count: 8 },
      { model: 'l40s', count: 1 },
      { model: 'MI300X', count: 2 },
      { model: 'other', count: 1 },
    ];
    let checked = 0;
    for (const mode of ['metered', 'platform-fee', 'none'] as const)
      for (const phase of ['running', 'stopped'] as const)
        for (const gpus of gpuChoices)
          for (const spot of [false, true])
            for (const reserved of [false, true])
              for (const granted of [false, true])
                for (const meter of [undefined, flavorMeter])
                  for (const publicIp of [false, true]) {
                    const shape: BillableShape = {
                      ...base,
                      gpus,
                      spot,
                      reserved,
                      granted,
                      flavorMeter: meter,
                      publicIp,
                    };
                    for (const line of meterLinesFor(shape, mode, phase)) {
                      checked += 1;
                      expect(known.has(line.meter), line.meter).toBe(true);
                      expect(line.perHour).toBeGreaterThan(0);
                    }
                  }
    expect(checked).toBeGreaterThan(100);
  });
});

describe('billingModeOf', () => {
  const root = 'root';
  const pool = (
    over: Partial<{ ownerTenantId: string; class: string; policy: PoolPolicy }> = {},
  ) => ({
    ownerTenantId: root,
    class: 'provider',
    policy: {} as PoolPolicy,
    ...over,
  });

  it('an explicit policy mode wins', () => {
    expect(
      billingModeOf(pool({ policy: { billing: { mode: 'none' } } }), { tenantId: 'sub' }, root),
    ).toBe('none');
    expect(
      billingModeOf(pool({ policy: { billing: { mode: 'metered' } } }), { tenantId: 'sub' }, root),
    ).toBe('metered');
  });

  it('BYO pool owned by a sub-tenant is platform-fee even when its account did not resolve (fail closed)', () => {
    expect(billingModeOf(pool({ ownerTenantId: 'sub' }), undefined, root)).toBe('platform-fee');
  });

  it('BYO pool owned by a sub-tenant with its own account is platform-fee', () => {
    expect(billingModeOf(pool({ ownerTenantId: 'sub' }), { tenantId: 'sub' }, root)).toBe(
      'platform-fee',
    );
  });

  it('a root-owned provider pool is metered, with or without a resolved account (root pays itself)', () => {
    expect(billingModeOf(pool(), { tenantId: root }, root)).toBe('metered');
    expect(billingModeOf(pool(), undefined, root)).toBe('metered');
  });

  it('a non-provider pool is metered whoever owns it', () => {
    expect(billingModeOf(pool({ class: 'vps-host', ownerTenantId: 'sub' }), undefined, root)).toBe(
      'metered',
    );
  });

  it('an explicit mode wins over the BYO default', () => {
    expect(
      billingModeOf(
        pool({ ownerTenantId: 'sub', policy: { billing: { mode: 'metered' } } }),
        undefined,
        root,
      ),
    ).toBe('metered');
  });
});
