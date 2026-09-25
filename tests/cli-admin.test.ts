import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCli } from '@better-compute/cli';

// pools, join-requests, inventory, secrets, site-tokens and drivers (PLAN.md §9.3): bodies over a fetch stub;
// secret values only from a file or stdin; one-time tokens to new files.

const POOL = 'pool_01k5w0000000000000000000aa';
const SITE = 'site_01k5w0000000000000000000bb';
const NODE = 'node_01k5w0000000000000000000cc';
const JREQ = 'jreq_01k5w0000000000000000000dd';

async function run(
  argv: string[],
  options: { answer?: unknown; cwd?: string; stdin?: string } = {},
) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const out: string[] = [];
  try {
    await createCli().run([...argv, '--url', 'https://compute.test', '--format', 'json'], {
      out: (line) => out.push(line),
      err() {},
      env: {
        BETTER_COMPUTE_TOKEN: 'biam_ses_0123456789abcdefghij',
        BETTER_COMPUTE_TENANT: 'org_acme',
      },
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.stdin !== undefined ? { stdin: async () => options.stdin! } : {}),
      fetch: async (input, init) => {
        const request = new Request(input, init);
        calls.push({
          path: new URL(request.url).pathname.replace('/api/compute/', ''),
          body: JSON.parse(await request.text()),
        });
        return Response.json({ data: options.answer ?? {} });
      },
    });
    return { ok: true as const, calls, stdout: out.join('\n') };
  } catch (error) {
    return { ok: false as const, calls, code: (error as { code?: string }).code };
  }
}

describe('admin commands', () => {
  it('creates, offers and updates pools', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bc-pools-'));
    await writeFile(join(dir, 'policy.json'), JSON.stringify({ maxDuration: '7d' }));
    expect(
      (
        await run(
          [
            'pools',
            'create',
            '--site',
            SITE,
            '--class',
            'metal-host',
            '--gpu-model',
            'H100',
            '--owner-quota',
            'gpus=64, vcpu=512',
            '--policy-file',
            'policy.json',
            '--key',
            'k',
          ],
          { cwd: dir },
        )
      ).calls[0],
    ).toEqual({
      path: 'pools/create',
      body: {
        tenantId: 'org_acme',
        siteId: SITE,
        class: 'metal-host',
        gpuModel: 'H100',
        policy: { maxDuration: '7d' },
        ownerQuota: { gpus: 64, vcpu: 512 },
        idempotencyKey: 'k',
      },
    });
    expect(
      (
        await run([
          'pools',
          'create',
          '--site',
          SITE,
          '--class',
          'provider',
          '--provider-account',
          'pacct_1',
        ])
      ).calls[0]!.body,
    ).toMatchObject({
      agent: 'none',
      providerAccountId: 'pacct_1',
    });
    expect(await run(['pools', 'create', '--site', SITE, '--class', 'provider'])).toMatchObject({
      ok: false,
      calls: [],
    });
    expect(
      await run([
        'pools',
        'create',
        '--site',
        SITE,
        '--class',
        'vps-host',
        '--owner-quota',
        'gpus=-1',
      ]),
    ).toMatchObject({ ok: false, calls: [] });
    expect(
      (
        await run([
          'pools',
          'offer',
          POOL,
          '--to',
          'org_research',
          '--quota',
          'gpus=16',
          '--priority',
          '5',
        ])
      ).calls[0],
    ).toEqual({
      path: 'pools/offer',
      body: {
        tenantId: 'org_acme',
        poolId: POOL,
        toTenantId: 'org_research',
        quota: { gpus: 16 },
        priority: 5,
      },
    });
    expect(await run(['pools', 'update', POOL])).toMatchObject({ ok: false, calls: [] });
  });

  it('approves and rejects join requests, and reads inventory', async () => {
    expect(
      (
        await run([
          'join-requests',
          'approve',
          JREQ,
          '--pool',
          POOL,
          '--ttl',
          '600',
          '--reason',
          'rack r12',
        ])
      ).calls[0],
    ).toEqual({
      path: 'joinRequests/approve',
      body: {
        tenantId: 'org_acme',
        poolId: POOL,
        requestId: JREQ,
        reason: 'rack r12',
        ttlSeconds: 600,
      },
    });
    expect((await run(['join-requests', 'reject', JREQ, '--pool', POOL])).calls[0]!.body).toEqual({
      tenantId: 'org_acme',
      poolId: POOL,
      requestId: JREQ,
    });
    expect(
      (await run(['inventory', 'diff', NODE, '--from', 'inv_01k5w0000000000000000000ee'])).calls[0],
    ).toEqual({
      path: 'inventory/diff',
      body: { tenantId: 'org_acme', nodeId: NODE, from: 'inv_01k5w0000000000000000000ee' },
    });
  });

  it('takes secret values from a file or stdin only, without their trailing newline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bc-secrets-'));
    await writeFile(join(dir, 'hf'), 'hf_s3cr3t\n');
    expect(
      (
        await run(['secrets', 'put', '--name', 'hf-token', '--value-file', 'hf', '--key', 'k'], {
          cwd: dir,
        })
      ).calls[0],
    ).toEqual({
      path: 'secrets/put',
      body: { tenantId: 'org_acme', name: 'hf-token', value: 'hf_s3cr3t', idempotencyKey: 'k' },
    });
    expect(
      (
        await run(['secrets', 'put', '--name', 'db', '--stdin', '--scope', 'fleet'], {
          stdin: 'p4ss\r\n',
        })
      ).calls[0]!.body,
    ).toMatchObject({
      value: 'p4ss',
      scope: 'fleet',
    });
    expect(await run(['secrets', 'put', '--name', 'x'])).toMatchObject({ ok: false, calls: [] });
    expect(await run(['secrets', 'put', '--name', 'x', '--stdin'], { stdin: '\n' })).toMatchObject({
      ok: false,
      calls: [],
    });
    // There is no flag that takes the value itself.
    expect(await run(['secrets', 'put', '--name', 'x', '--value', 'oops'])).toMatchObject({
      ok: false,
      calls: [],
    });
  });

  it('writes a site token to a new file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bc-site-token-'));
    const result = await run(
      ['site-tokens', 'create', '--site', SITE, '--ttl', '3600', '--out', 'site-token'],
      {
        answer: { id: 'jt_1', token: 'bcjt_jt_1.s3cr3t' },
        cwd: dir,
      },
    );
    expect(result.calls[0]!.body).toMatchObject({
      tenantId: 'org_acme',
      siteId: SITE,
      ttlSeconds: 3600,
    });
    expect(result.ok && result.stdout).not.toContain('s3cr3t');
    expect(await readFile(join(dir, 'site-token'), 'utf8')).toBe('bcjt_jt_1.s3cr3t\n');
    expect(await run(['site-tokens', 'revoke', 'bcjt_jt_1.s3cr3t', '--site', SITE])).toMatchObject({
      ok: false,
      calls: [],
    });
  });
});
