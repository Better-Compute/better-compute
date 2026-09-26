import { describe, expect, it } from 'vitest';
import type { DeviceRequest } from '@better-compute/core';
import { gpuEquivalent, parseCpuList, reservationDemand } from '@better-compute/capacity';
import { presentedCredential } from '../packages/server/src/operations.js';

// Round-5 security review 2: the host-resource quota (M8) holds for fractional GPUs too, cpulists from
// nodes are bounded, and no path in carries a caller's own forwarding headers to IAM (M6).

const mig = (count: number): DeviceRequest[] => [{ class: 'gpu.mig', count }];

describe('host resources on fractional GPUs (review 2, M8)', () => {
  it('counts MIG instances and slots as their fraction of a GPU', () => {
    expect(gpuEquivalent(mig(7), { sharing: 'mig' })).toBe(1);
    expect(gpuEquivalent([{ class: 'gpu.slot', count: 2 }], { sharing: 'timeslice' })).toBe(0.5);
    expect(gpuEquivalent([{ class: 'gpu.slot', count: 5 }], { sharing: 'mps' })).toBe(0.5);
    expect(
      gpuEquivalent([{ class: 'gpu.slot', count: 3 }], { sharing: 'mps', policy: { sharing: { replicas: 6 } } }),
    ).toBe(0.5);
    expect(gpuEquivalent([{ class: 'gpu', count: 2 }], { sharing: 'exclusive' })).toBe(2);
  });

  it('charges everything above an empty share, and nothing for a legacy spec', () => {
    const request = { devices: mig(1), duration: '1h', resources: { vcpu: 4096, memoryGiB: 64 } };
    expect(reservationDemand({ ...request, hostShare: {} })).toEqual({
      'gpu.mig': 1,
      vcpu: 4096,
      memoryGiB: 64,
    });
    expect(reservationDemand({ ...request, hostShare: { vcpu: 96, memoryGiB: 64 } })).toEqual({
      'gpu.mig': 1,
      vcpu: 4000,
    });
    // Made before hostShare existed: never charged, so never refunded either.
    expect(reservationDemand(request)).toEqual({ 'gpu.mig': 1 });
  });
});

describe('cpulists from nodes are bounded (review 2)', () => {
  it('refuses ids above 8191, oversized lists and too many parts', () => {
    expect(parseCpuList('0-3,8191')).toEqual([0, 1, 2, 3, 8191]);
    expect(parseCpuList('0-65535')).toEqual([]);
    expect(parseCpuList('0-1,'.repeat(5000))).toEqual([]);
    expect(parseCpuList('1'.repeat(40_000))).toEqual([]);
  });
});

describe('forwarding headers never reach IAM (review 2, M6)', () => {
  it('replaces a caller’s claims with the verified address, on the in-process path too', () => {
    const credential = presentedCredential(
      {
        headers: {
          authorization: 'Bearer t',
          'x-forwarded-for': '10.0.0.1',
          forwarded: 'for=10.0.0.1',
          'x-real-ip': '10.0.0.1',
        },
        sourceIp: '198.51.100.7',
      },
      false,
    )!;
    const headers = new Headers(credential.headers);
    expect(headers.get('x-forwarded-for')).toBe('198.51.100.7');
    expect(headers.get('forwarded')).toBeNull();
    expect(headers.get('x-real-ip')).toBeNull();
    const unknown = presentedCredential({ headers: { authorization: 'Bearer t', 'x-forwarded-for': '10.0.0.1' } }, false)!;
    expect(new Headers(unknown.headers).get('x-forwarded-for')).toBeNull();
  });
});
