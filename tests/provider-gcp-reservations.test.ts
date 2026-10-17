import { describe, expect, it } from 'vitest';
import { GceEmulator } from './support/gce-emulator.js';
import { build, ctx } from './support/gcp-harness.js';

// provider-gcp reservations against the emulator: on-demand (own and shared in), reservations whose
// shape comes from an instance template, future reservations, zone limits and reservation offers.

const base = 'https://compute.googleapis.com/compute/v1';

function reservation(
  name: string,
  extra: Record<string, unknown> = {},
  zone = 'us-central1-a',
  owner = 'p',
) {
  return {
    kind: 'compute#reservation',
    name,
    zone: `${base}/projects/${owner}/zones/${zone}`,
    selfLink: `${base}/projects/${owner}/zones/${zone}/reservations/${name}`,
    status: 'READY',
    specificReservationRequired: false,
    specificReservation: {
      count: '4',
      inUseCount: '1',
      instanceProperties: { machineType: 'a3-highgpu-8g' },
    },
    ...extra,
  };
}

function future(name: string, extra: Record<string, unknown> = {}, zone = 'us-central1-a') {
  return {
    kind: 'compute#futureReservation',
    name,
    zone: `${base}/projects/p/zones/${zone}`,
    selfLink: `${base}/projects/p/zones/${zone}/futureReservations/${name}`,
    status: { procurementStatus: 'APPROVED' },
    specificSkuProperties: {
      totalCount: '16',
      instanceProperties: { machineType: 'a3-highgpu-8g' },
    },
    timeWindow: { startTime: '2026-11-01T00:00:00Z', endTime: '2026-12-01T00:00:00Z' },
    ...extra,
  };
}

async function reservationsOf(emu: GceEmulator, config?: Record<string, unknown>) {
  const impl = await build(emu, config);
  return impl.listReservations!(ctx());
}

describe('reservations', () => {
  it('maps a local a3 reservation', async () => {
    const emu = new GceEmulator();
    emu.reservations.push(
      reservation('rsv-a', {
        specificReservationRequired: true,
        specificReservation: {
          count: '4',
          inUseCount: '1',
          instanceProperties: {
            machineType: 'a3-highgpu-8g',
            localSsds: Array.from({ length: 16 }, () => ({ diskSizeGb: '375', interface: 'NVME' })),
          },
        },
      }),
    );
    const [found] = await reservationsOf(emu);
    expect(found).toEqual({
      id: 'us-central1-a/rsv-a',
      name: 'rsv-a',
      zone: 'us-central1-a',
      region: 'us-central1',
      state: 'ready',
      machineType: 'a3-highgpu-8g',
      vcpu: 208,
      memoryGiB: 1872,
      gpus: { model: 'H100', count: 8 },
      localSsdGiB: 6000,
      total: 4,
      inUse: 1,
      specificOnly: true,
      shared: false,
      offerId: 'us-central1-a/a3-highgpu-8g@rsv-a',
    });
  });

  it('takes explicit accelerators from the instance properties and maps every state', async () => {
    const emu = new GceEmulator();
    emu.reservations.push(
      reservation('with-gpus', {
        specificReservation: {
          count: '2',
          inUseCount: '0',
          instanceProperties: {
            machineType: 'n2-standard-4',
            guestAccelerators: [{ acceleratorType: 'nvidia-l4', acceleratorCount: 1 }],
          },
        },
      }),
    );
    for (const status of ['CREATING', 'READY', 'UPDATING', 'DELETING', 'INVALID'])
      emu.reservations.push(reservation(`s-${status.toLowerCase()}`, { status }));
    const found = await reservationsOf(emu);
    expect(found.find((r) => r.name === 'with-gpus')).toMatchObject({
      machineType: 'n2-standard-4',
      vcpu: 4,
      memoryGiB: 16,
      gpus: { model: 'L4', count: 1 },
      total: 2,
      inUse: 0,
    });
    expect(
      Object.fromEntries(
        found.filter((r) => r.name.startsWith('s-')).map((r) => [r.name, r.state]),
      ),
    ).toEqual({
      's-creating': 'creating',
      's-ready': 'ready',
      's-updating': 'updating',
      's-deleting': 'deleting',
      's-invalid': 'error',
    });
  });

  it('maps a shared reservation with the owner project in id and offer', async () => {
    const emu = new GceEmulator();
    emu.reservations.push(
      reservation(
        'team-rsv',
        { shareSettings: { shareType: 'SPECIFIC_PROJECTS' } },
        'us-central1-a',
        'owner',
      ),
      // Shared out of this project: still ours, so the short id.
      reservation('ours-shared', { shareSettings: { shareType: 'SPECIFIC_PROJECTS' } }),
      reservation('plain', { shareSettings: { shareType: 'LOCAL' } }),
    );
    const found = await reservationsOf(emu);
    const byName = Object.fromEntries(found.map((r) => [r.name, r]));
    expect(byName['team-rsv']).toMatchObject({
      id: 'projects/owner/zones/us-central1-a/reservations/team-rsv',
      shared: true,
      offerId: 'us-central1-a/a3-highgpu-8g@projects/owner/reservations/team-rsv',
    });
    expect(byName['ours-shared']).toMatchObject({ id: 'us-central1-a/ours-shared', shared: true });
    expect(byName['plain']).toMatchObject({ shared: false });
  });

  it('reads the instance template when instanceProperties is absent', async () => {
    const emu = new GceEmulator();
    emu.instanceTemplates.set('gpu-template', {
      name: 'gpu-template',
      properties: {
        machineType: 'g2-standard-4',
        guestAccelerators: [{ acceleratorType: 'nvidia-l4', acceleratorCount: 1 }],
        disks: [
          { type: 'PERSISTENT', boot: true },
          { type: 'SCRATCH', diskSizeGb: '375' },
          { type: 'SCRATCH' },
        ],
      },
    });
    emu.reservations.push(
      reservation('from-template', {
        specificReservation: {
          count: '3',
          inUseCount: '0',
          sourceInstanceTemplate: `${base}/projects/p/global/instanceTemplates/gpu-template`,
        },
      }),
      reservation('missing-template', {
        specificReservation: {
          count: '3',
          sourceInstanceTemplate: `${base}/projects/p/global/instanceTemplates/gone`,
        },
      }),
    );
    const found = await reservationsOf(emu);
    expect(found.map((r) => r.name)).toEqual(['from-template']);
    expect(found[0]).toMatchObject({
      machineType: 'g2-standard-4',
      vcpu: 4,
      memoryGiB: 16,
      gpus: { model: 'L4', count: 1 },
      localSsdGiB: 750,
      total: 3,
    });
  });

  it('maps a future reservation to scheduled with its window', async () => {
    const emu = new GceEmulator();
    emu.futureReservations.push(
      future('soon'),
      future('by-duration', {
        status: { procurementStatus: 'PROCURING' },
        timeWindow: { startTime: '2026-11-01T00:00:00Z', duration: { seconds: '86400' } },
      }),
      future('done', { status: { procurementStatus: 'FULFILLED' } }),
      future('cancelled', { status: { procurementStatus: 'CANCELLED' } }),
      future('declined', { status: { procurementStatus: 'DECLINED' } }),
    );
    const found = await reservationsOf(emu);
    expect(found.map((r) => r.id)).toEqual([
      'future:us-central1-a/by-duration',
      'future:us-central1-a/declined',
      'future:us-central1-a/soon',
    ]);
    const byName = Object.fromEntries(found.map((r) => [r.name, r]));
    expect(byName['soon']).toMatchObject({
      state: 'scheduled',
      total: 16,
      inUse: 0,
      machineType: 'a3-highgpu-8g',
      gpus: { model: 'H100', count: 8 },
      startsAt: Date.parse('2026-11-01T00:00:00Z'),
      endsAt: Date.parse('2026-12-01T00:00:00Z'),
    });
    expect(byName['by-duration']).toMatchObject({
      state: 'scheduled',
      startsAt: Date.parse('2026-11-01T00:00:00Z'),
      endsAt: Date.parse('2026-11-02T00:00:00Z'),
    });
    expect(byName['declined']!.state).toBe('error');
  });

  it('reports deleteAtTime of an on-demand reservation as its end', async () => {
    const emu = new GceEmulator();
    emu.reservations.push(reservation('temp', { deleteAtTime: '2026-12-31T00:00:00Z' }));
    expect((await reservationsOf(emu))[0]!.endsAt).toBe(Date.parse('2026-12-31T00:00:00Z'));
  });

  it('ignores reservations outside configured zones', async () => {
    const emu = new GceEmulator();
    emu.reservations.push(reservation('here'), reservation('there', {}, 'europe-west4-a'));
    emu.futureReservations.push(future('f-here'), future('f-there', {}, 'europe-west4-a'));
    const found = await reservationsOf(emu);
    expect(found.map((r) => r.id)).toEqual(['future:us-central1-a/f-here', 'us-central1-a/here']);
    const both = await reservationsOf(emu, {
      projectId: 'p',
      zones: ['us-central1-a', 'europe-west4-a'],
    });
    expect(both).toHaveLength(4);
  });

  it('pages through every reservation', async () => {
    const emu = new GceEmulator();
    for (let i = 0; i < 5; i++) emu.reservations.push(reservation(`r${i}`));
    expect(await reservationsOf(emu)).toHaveLength(5);
  });

  it('listOffers includes reservation offers with availability', async () => {
    const emu = new GceEmulator();
    emu.reservations.push(
      reservation('rsv-a'),
      reservation('rsv-full', {
        specificReservation: {
          count: '2',
          inUseCount: '2',
          instanceProperties: { machineType: 'a3-highgpu-8g' },
        },
      }),
      reservation('rsv-creating', { status: 'CREATING' }),
      reservation('rsv-shared', {}, 'us-central1-a', 'owner'),
    );
    emu.futureReservations.push(future('later'));
    const impl = await build(emu);
    const offers = await impl.listOffers({ gpuModel: 'H100' });
    expect(offers.map((o) => [o.id, o.available])).toEqual([
      ['us-central1-a/a3-highgpu-8g', true],
      ['us-central1-a/a3-highgpu-8g@projects/owner/reservations/rsv-shared', true],
      ['us-central1-a/a3-highgpu-8g@rsv-a', true],
      ['us-central1-a/a3-highgpu-8g@rsv-full', false],
    ]);
    expect(offers[2]).toMatchObject({
      kind: 'vps',
      region: 'us-central1',
      vcpu: 208,
      memoryGiB: 1872,
      gpus: { model: 'H100', count: 8 },
    });
    expect((await impl.listOffers({ gpuModel: 'L4' })).some((o) => o.id.includes('@'))).toBe(false);
    expect(await impl.listOffers({ minVcpu: 1000 })).toEqual([]);
    // Creating on a reservation offer consumes it by name.
    await impl.create(
      {
        offerId: 'us-central1-a/a3-highgpu-8g@projects/owner/reservations/rsv-shared',
        image: 'ubuntu-2404-lts',
        userData: '',
        name: 'ins_x',
      },
      ctx(),
    );
    expect(emu.instances.get('us-central1-a/bc-ins-x')!.reservationAffinity.values).toEqual([
      'projects/owner/reservations/rsv-shared',
    ]);
  });

  it('listOffers still answers when reservations cannot be read', async () => {
    const emu = new GceEmulator();
    const original = emu.fetch;
    emu.fetch = async (input, init) => {
      if (String(input).includes('/aggregated/reservations'))
        return emu.error(403, 'forbidden', 'Required compute.reservations.list permission');
      return original(input, init);
    };
    const offers = await (await build(emu)).listOffers({});
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every((o) => !o.id.includes('@'))).toBe(true);
  });

  it('listReservations reports a denied read', async () => {
    const emu = new GceEmulator();
    const original = emu.fetch;
    emu.fetch = async (input, init) =>
      String(input).includes('/aggregated/reservations')
        ? emu.error(403, 'forbidden', 'Required compute.reservations.list permission')
        : original(input, init);
    const impl = await build(emu);
    await expect(impl.listReservations!(ctx())).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });
});
