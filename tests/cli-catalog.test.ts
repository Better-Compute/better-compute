import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCli } from '@better-compute/cli';

// sites, projects, images, flavors, quotas, usage and webhooks (PLAN.md §9.3): the bodies over a fetch stub, the
// one-time secrets and exports written to new 0600 files.

const POOL = 'pool_01k5w0000000000000000000aa';
const WHK = 'whk_01k5w0000000000000000000bb';

async function run(argv: string[], answer: unknown = {}, cwd?: string) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const out: string[] = [];
  try {
    await createCli().run([...argv, '--url', 'https://compute.test', '--format', 'json'], {
      out: (line) => out.push(line),
      err() {},
      env: { BETTER_COMPUTE_TOKEN: 'biam_ses_0123456789abcdefghij', BETTER_COMPUTE_TENANT: 'org_acme' },
      ...(cwd ? { cwd } : {}),
      fetch: async (input, init) => {
        const request = new Request(input, init);
        calls.push({ path: new URL(request.url).pathname.replace('/api/compute/', ''), body: JSON.parse(await request.text()) });
        return Response.json({ data: answer });
      },
    });
    return { ok: true as const, calls, stdout: out.join('\n') };
  } catch (error) {
    return { ok: false as const, calls, code: (error as { code?: string }).code };
  }
}

describe('catalog commands', () => {
  it('builds sites, projects, images, flavors and quotas calls', async () => {
    expect((await run(['sites', 'create', '--kind', 'dedicated', '--region', 'eu-west', '--key', 'k'])).calls[0]).toEqual({
      path: 'sites/create',
      body: { tenantId: 'org_acme', kind: 'dedicated', region: 'eu-west', idempotencyKey: 'k' },
    });
    expect(await run(['sites', 'update', 'site_01k5w0000000000000000000cc'])).toMatchObject({ ok: false, calls: [] });
    expect((await run(['projects', 'create', '--name', 'training', '--key', 'k'])).calls[0]!.body).toEqual({
      tenantId: 'org_acme',
      name: 'training',
      idempotencyKey: 'k',
    });
    const sha = 'AB'.repeat(32);
    expect(
      (await run(['images', 'register', '--ref', 'u@1', '--source', 'https://i/u.qcow2', '--disk-format', 'qcow2', '--sha256', sha]))
        .calls[0]!.body,
    ).toEqual({ tenantId: 'org_acme', ref: 'u@1', source: 'https://i/u.qcow2', format: 'qcow2', sha256: sha.toLowerCase() });
    expect(
      await run(['images', 'register', '--ref', 'u@1', '--source', 's', '--disk-format', 'raw', '--sha256', sha, '--signature', 'c2ln']),
    ).toMatchObject({ ok: false, calls: [] });
    expect(
      (await run(['flavors', 'create', '--pool', POOL, '--name', 'g1.small', '--vcpu', '4', '--memory-gib', '16', '--disk-gib', '80', '--gpus', '1']))
        .calls[0],
    ).toEqual({
      path: 'flavors/create',
      body: { tenantId: 'org_acme', poolId: POOL, name: 'g1.small', vcpu: 4, memoryGiB: 16, diskGiB: 80, gpus: 1 },
    });
    expect((await run(['quotas', 'set', '--pool', POOL, '--resource', 'gpus', '--max', '64'])).calls[0]!.body).toEqual({
      tenantId: 'org_acme',
      poolId: POOL,
      resource: 'gpus',
      max: 64,
    });
  });

  it('exports usage to a new file and keeps the summary in the output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bc-usage-'));
    const answer = { format: 'csv', data: 'meter,quantity\ngpu.hours,3\n', count: 1, totals: { 'gpu.hours': 3 }, truncated: false };
    const before = Date.now();
    const result = await run(['usage', 'export', '--from', '-7d', '--to', '+0s', '--out', 'usage.csv'], answer, dir);
    const body = result.calls[0]!.body;
    expect(body.to as number).toBeGreaterThanOrEqual(before);
    expect((body.to as number) - (body.from as number)).toBeGreaterThanOrEqual(7 * 86_400_000 - 5000);
    expect(await readFile(join(dir, 'usage.csv'), 'utf8')).toBe(answer.data);
    expect(result.ok && JSON.parse(result.stdout)).toMatchObject({ count: 1, totals: { 'gpu.hours': 3 } });
    expect(result.ok && result.stdout).not.toContain('meter,quantity');
    expect(await run(['usage', 'export', '--from', '-7d', '--to', '+0s', '--out', 'usage.csv'], answer, dir)).toMatchObject({
      ok: false,
      code: 'ALREADY_EXISTS',
    });
    expect(await run(['usage', 'export', '--from', '+1h', '--to', '-1h'])).toMatchObject({ ok: false, calls: [] });
  });

  it('writes a webhook signing secret to a new 0600 file instead of printing it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bc-webhooks-'));
    const answer = { webhook: { id: WHK }, secret: 'whsec_s3cr3t' };
    const result = await run(
      ['webhooks', 'create', '--endpoint', 'https://hooks.test/x', '--events', 'node.*, reservation.*', '--secret-out', 'whk.secret'],
      answer,
      dir,
    );
    expect(result.calls[0]!.body).toEqual({ tenantId: 'org_acme', url: 'https://hooks.test/x', events: ['node.*', 'reservation.*'] });
    expect(result.ok && result.stdout).not.toContain('s3cr3t');
    expect(await readFile(join(dir, 'whk.secret'), 'utf8')).toBe('whsec_s3cr3t\n');
    if (process.platform !== 'win32') expect((await stat(join(dir, 'whk.secret'))).mode & 0o777).toBe(0o600);
    const rotated = await run(['webhooks', 'rotate-secret', WHK, '--keep-previous', '1h', '--secret-out', 'whk.secret.new'], answer, dir);
    expect(rotated.calls[0]!.body).toEqual({ tenantId: 'org_acme', webhookId: WHK, keepPreviousSeconds: 3600 });
    expect(await run(['webhooks', 'rotate-secret', WHK, '--keep-previous', '2d'])).toMatchObject({ ok: false, calls: [] });
    expect((await run(['webhooks', 'update', WHK, '--pause'])).calls[0]!.body).toEqual({
      tenantId: 'org_acme',
      webhookId: WHK,
      active: false,
    });
    expect(await run(['webhooks', 'update', WHK])).toMatchObject({ ok: false, calls: [] });
  });
});
