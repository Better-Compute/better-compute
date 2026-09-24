import { describe, expect, it } from 'vitest';
import { createCli, type CliIO } from '@better-compute/cli';
import { gpuRequest, parseTime } from '../packages/cli/src/commands/capacity.js';

// The capacity shortcuts (PLAN.md §9.3): each builds its route and body and calls the API as
// BETTER_COMPUTE_TOKEN; here over --url with a fetch stub that records the requests.

const RSV = 'rsv_01k5w0000000000000000000aa';
const POOL = 'pool_01k5w0000000000000000000bb';

interface Call {
  path: string;
  body: Record<string, unknown>;
  authorization: string | null;
}

async function run(argv: string[], answer: unknown = { ok: true }) {
  const calls: Call[] = [];
  const out: string[] = [];
  const notes: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push({
      path: new URL(request.url).pathname,
      body: JSON.parse(await request.text()),
      authorization: request.headers.get('authorization'),
    });
    return Response.json({ data: answer });
  };
  const io: CliIO = {
    out: (line) => out.push(line),
    err: (line) => notes.push(line),
    env: {
      BETTER_COMPUTE_TOKEN: 'biam_ses_0123456789abcdefghij',
      BETTER_COMPUTE_TENANT: 'org_acme',
    },
    fetch,
  };
  try {
    await createCli().run([...argv, '--url', 'https://compute.test'], io);
    return { ok: true as const, calls, stdout: out.join('\n'), notes };
  } catch (error) {
    return {
      ok: false as const,
      calls,
      code: (error as { code?: string }).code,
      message: (error as Error).message,
    };
  }
}

describe('reserve', () => {
  it('builds reservations.create with a selector, a fresh key and a wait', async () => {
    const result = await run([
      'reserve',
      '--pool',
      POOL,
      '--gpus',
      '4',
      '--for',
      '8h',
      '--model',
      'H100',
      '--selector',
      'vramGiB >= 80, gpuProduct in (H100-SXM5-80GB, H100-NVL)',
      '--nvlink',
    ]);
    expect(result.ok).toBe(true);
    const [call] = result.calls;
    expect(call!.path).toBe('/api/compute/reservations/create');
    expect(call!.authorization).toBe('Bearer biam_ses_0123456789abcdefghij');
    expect(call!.body).toMatchObject({
      tenantId: 'org_acme',
      poolId: POOL,
      duration: '8h',
      binding: 'hold',
      wait: { timeoutMs: 20_000 },
      devices: [
        {
          class: 'gpu',
          count: 4,
          topology: 'nvlink-all',
          selector: {
            matchExpressions: [
              { key: 'vramGiB', op: 'Gte', values: [80] },
              { key: 'gpuProduct', op: 'In', values: ['H100-SXM5-80GB', 'H100-NVL'] },
              { key: 'gpuModel', op: 'In', values: ['H100'] },
            ],
          },
        },
      ],
    });
    expect(call!.body.idempotencyKey).toMatch(/^cli-[0-9a-f]{24}$/);
    expect(result.ok && result.notes.join('\n')).toContain(String(call!.body.idempotencyKey));
  });

  it('retries with --key, schedules with --start and leases with --lease', async () => {
    const before = Date.now();
    const result = await run([
      'reserve',
      '--pool',
      POOL,
      '--gpus',
      '1',
      '--for',
      '1h',
      '--key',
      'nightly-1',
      '--start',
      '+2h',
      '--lease',
      '300',
      '--wait',
      '0',
    ]);
    const body = result.calls[0]!.body;
    expect(body).toMatchObject({
      idempotencyKey: 'nightly-1',
      leaseSeconds: 300,
      wait: { timeoutMs: 0 },
    });
    expect(body.start as number).toBeGreaterThanOrEqual(before + 7_200_000);
    expect(result.ok && result.notes).toEqual([]);
  });

  it('refuses bad input before calling anything', async () => {
    for (const argv of [
      ['reserve', '--pool', POOL, '--gpus', '4', '--for', 'forever'],
      ['reserve', '--pool', POOL, '--gpus', '0', '--for', '1h'],
      ['reserve', '--pool', POOL, '--gpus', '1', '--for', '1h', '--selector', 'vramGiB >= (80'],
      ['reserve', '--pool', POOL, '--gpus', '1', '--for', '1h', '--start', 'tomorrow'],
      ['reserve', '--pool', POOL, '--gpus', '1', '--for', '1h', '--key', 'bad key'],
    ]) {
      const result = await run(argv);
      expect(result, argv.join(' ')).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
      expect(result.calls).toEqual([]);
    }
  });
});

describe('reservation and pool commands', () => {
  it('route release, cancel, extend, renew, get and list', async () => {
    const tenantId = 'org_acme';
    expect((await run(['release', RSV])).calls[0]).toMatchObject({
      path: '/api/compute/reservations/release',
      body: { tenantId, reservationId: RSV },
    });
    expect((await run(['release', RSV, '--cancel'])).calls[0]!.path).toBe(
      '/api/compute/reservations/cancel',
    );
    const extend = (await run(['extend', RSV, '--by', '4h', '--key', 'k1'])).calls[0]!;
    expect(extend).toMatchObject({
      path: '/api/compute/reservations/extend',
      body: { tenantId, reservationId: RSV, by: '4h', idempotencyKey: 'k1' },
    });
    const until = (await run(['extend', RSV, '--until', '2026-10-01T00:00:00Z'])).calls[0]!.body;
    expect(until.until).toBe(Date.UTC(2026, 9, 1));
    expect((await run(['extend', RSV, '--renew'])).calls[0]).toMatchObject({
      path: '/api/compute/reservations/renew',
      body: { tenantId, reservationId: RSV },
    });
    expect(await run(['extend', RSV])).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    expect(await run(['extend', RSV, '--by', '1h', '--renew'])).toMatchObject({ ok: false });
    expect(await run(['release', 'not-an-id'])).toMatchObject({
      ok: false,
      code: 'INVALID_ARGUMENT',
    });

    expect((await run(['reservations', 'get', RSV])).calls[0]!.path).toBe(
      '/api/compute/reservations/get',
    );
    expect(
      (await run(['reservations', 'list', '--state', 'active', '--limit', '50'])).calls[0]!.body,
    ).toEqual({
      tenantId,
      state: 'active',
      limit: 50,
    });
    expect((await run(['pools', 'list'])).calls[0]).toMatchObject({
      path: '/api/compute/pools/list',
      body: { tenantId },
    });
  });

  it('prints tables for lists by default', async () => {
    const result = await run(['reservations', 'list'], {
      items: [{ id: RSV, state: 'active', poolId: POOL }],
    });
    expect(result.ok && result.stdout.split('\n')[0]).toMatch(/^ID\s+STATE\s+POOLID/i);
  });

  it('shows capacity: summary, one pool, or a placement preview', async () => {
    expect((await run(['capacity'])).calls[0]!.path).toBe('/api/compute/capacity/summary');
    expect((await run(['capacity', '--pool', POOL])).calls[0]).toMatchObject({
      path: '/api/compute/capacity/byPool',
      body: { poolId: POOL },
    });
    const preview = (
      await run(['capacity', '--preview', '--pool', POOL, '--gpus', '8', '--for', '1d'])
    ).calls[0]!;
    expect(preview).toMatchObject({
      path: '/api/compute/capacity/preview',
      body: { poolId: POOL, duration: '1d', devices: [{ class: 'gpu', count: 8 }] },
    });
    expect(await run(['capacity', '--preview', '--pool', POOL])).toMatchObject({
      ok: false,
      code: 'INVALID_ARGUMENT',
    });
  });

  it('needs a tenant and a token', async () => {
    const io: CliIO = { out: () => {}, env: { BETTER_COMPUTE_TOKEN: 't' } };
    await expect(
      createCli().run(['pools', 'list', '--url', 'https://compute.test'], io),
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});

describe('helpers', () => {
  it('parses times and device requests', () => {
    expect(parseTime('+90m', 1000, 'start')).toBe(1000 + 5_400_000);
    expect(parseTime('1790000000000', 0, 'start')).toBe(1_790_000_000_000);
    expect(() => parseTime('next week', 0, 'start')).toThrow(/ISO 8601/);
    expect(gpuRequest({ gpus: 2 })).toEqual({ class: 'gpu', count: 2 });
  });
});
