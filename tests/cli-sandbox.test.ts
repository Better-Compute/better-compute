import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCli, type CliIO } from '@better-compute/cli';

// `better-compute sandbox …` (PLAN.md §3.7): each command is one call to the vps module's sandboxes group. Here the
// remote transport talks to a recording fetch, so the request bodies (the contract with the API) are checked.

const SBX = 'sbx_01k5w000000000000000000abc';
const TEMPLATE = 'sbxt_01k5w000000000000000000abc';

function recorder() {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const io: CliIO = {
    out() {},
    err() {},
    env: {
      BETTER_COMPUTE_URL: 'https://compute.example.com',
      BETTER_COMPUTE_TOKEN: 'biam_ses_sandbox_cli_test',
      BETTER_COMPUTE_TENANT: 'org_acme',
    },
    fetch: async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      calls.push({
        path: url.pathname.replace('/api/compute/', ''),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ data: { id: SBX } }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  return { calls, run: (argv: string[]) => createCli().run(argv, io) };
}

describe('sandbox commands', () => {
  it('map flags to the sandboxes API', async () => {
    const { calls, run } = recorder();
    await run(['sandbox', 'create', '--template', TEMPLATE, '--ttl', '30m', '--key', 'k1']);
    await run(['sandbox', 'list', '--all', '--deleted']);
    await run(['sandbox', 'get', SBX]);
    await run(['sandbox', 'extend', SBX, '--by', '2h']);
    await run(['sandbox', 'snapshot', SBX, '--no-memory', '--keep', '--key', 'k2']);
    await run(['sandbox', 'delete', SBX]);
    await run(['sandbox', 'templates']);
    expect(calls).toEqual([
      {
        path: 'sandboxes/create',
        body: {
          tenantId: 'org_acme',
          templateId: TEMPLATE,
          ttlSeconds: 1800,
          idempotencyKey: 'k1',
          wait: { timeoutMs: 30_000 },
        },
      },
      { path: 'sandboxes/list', body: { tenantId: 'org_acme', scope: 'all', deleted: true } },
      { path: 'sandboxes/get', body: { tenantId: 'org_acme', sandboxId: SBX } },
      { path: 'sandboxes/extend', body: { tenantId: 'org_acme', sandboxId: SBX, by: 7_200_000 } },
      {
        path: 'sandboxes/snapshot',
        body: { tenantId: 'org_acme', sandboxId: SBX, includeMemory: false, keep: true, idempotencyKey: 'k2' },
      },
      { path: 'sandboxes/delete', body: { tenantId: 'org_acme', sandboxId: SBX } },
      { path: 'sandboxTemplates/list', body: { tenantId: 'org_acme' } },
    ]);
  });

  it('manages persistent volumes and mounts them in templates (agent memory)', async () => {
    const { calls, run } = recorder();
    const VOL = 'vol_01k5w000000000000000000abc';
    await run([
      'sandbox-volume', 'create', '--pool', 'pool_01k5w000000000000000000abc', '--name', 'agent-notes',
      '--size', '20', '--key', 'v1',
    ]);
    await run(['sandbox-volume', 'list', '--deleted']);
    await run(['sandbox-volume', 'get', VOL]);
    await run(['sandbox-volume', 'resize', VOL, '--size', '40']);
    await run(['sandbox-volume', 'delete', VOL]);
    await run(['sandbox-template', 'update', TEMPLATE, '--volumes', `agent-notes:/mnt/memory, ${VOL}:/data:ro`]);
    expect(calls).toEqual([
      {
        path: 'sandboxVolumes/create',
        body: {
          tenantId: 'org_acme',
          poolId: 'pool_01k5w000000000000000000abc',
          name: 'agent-notes',
          sizeGiB: 20,
          idempotencyKey: 'v1',
        },
      },
      { path: 'sandboxVolumes/list', body: { tenantId: 'org_acme', includeDeleted: true } },
      { path: 'sandboxVolumes/get', body: { tenantId: 'org_acme', volumeId: VOL } },
      { path: 'sandboxVolumes/resize', body: { tenantId: 'org_acme', volumeId: VOL, sizeGiB: 40 } },
      { path: 'sandboxVolumes/delete', body: { tenantId: 'org_acme', volumeId: VOL } },
      {
        path: 'sandboxTemplates/update',
        body: {
          tenantId: 'org_acme',
          templateId: TEMPLATE,
          volumes: [
            { name: 'agent-notes', mountPath: '/mnt/memory', readOnly: false },
            { volumeId: VOL, mountPath: '/data', readOnly: true },
          ],
        },
      },
    ]);
    await expect(
      run(['sandbox-template', 'update', TEMPLATE, '--volumes', 'notes:relative']),
    ).rejects.toThrow(/--volumes notes:relative/);
  });

  it('manages templates: create, update (only the fields given), delete', async () => {
    const { calls, run } = recorder();
    const dir = await mkdtemp(join(tmpdir(), 'bc-sbxt-'));
    await writeFile(join(dir, 'init.yaml'), '#cloud-config\npackages: [python3]\n');
    await run([
      'sandbox-template', 'create', '--name', 'python', '--pool', 'pool_01k5w000000000000000000abc',
      '--flavor', 'small', '--image', 'img_01k5w0000000000000000000abc', '--warm-min', '2', '--warm-max', '4',
      '--default-ttl', '30m', '--max-ttl', '4h', '--network', 'private',
      '--env', 'API_KEY=secret://org_acme/sec_1, DB=secret://org_acme/sec_2',
      '--user-data', join(dir, 'init.yaml'),
    ]);
    await run(['sandbox-template', 'update', TEMPLATE, '--warm-min', '4', '--no-user-data']);
    await run(['sandbox-template', 'delete', TEMPLATE]);
    expect(calls).toEqual([
      {
        path: 'sandboxTemplates/create',
        body: {
          tenantId: 'org_acme',
          name: 'python',
          poolId: 'pool_01k5w000000000000000000abc',
          flavor: 'small',
          imageId: 'img_01k5w0000000000000000000abc',
          userData: '#cloud-config\npackages: [python3]\n',
          defaultTtlSeconds: 1800,
          maxTtlSeconds: 14_400,
          warm: { min: 2, max: 4 },
          env: { API_KEY: 'secret://org_acme/sec_1', DB: 'secret://org_acme/sec_2' },
          network: 'private',
        },
      },
      { path: 'sandboxTemplates/update', body: { tenantId: 'org_acme', templateId: TEMPLATE, warm: { min: 4 }, userData: null } },
      { path: 'sandboxTemplates/delete', body: { tenantId: 'org_acme', templateId: TEMPLATE } },
    ]);
    await expect(run(['sandbox-template', 'update', TEMPLATE])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(run(['sandbox-template', 'update', TEMPLATE, '--warm-max', '3'])).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('refuses malformed input before calling', async () => {
    const { calls, run } = recorder();
    await expect(run(['sandbox', 'get', 'inst_01k5w000000000000000000abc'])).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(run(['sandbox', 'extend', SBX])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(run(['sandbox', 'create', '--template', TEMPLATE, '--ttl', 'soon'])).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(calls).toEqual([]);
  });
});
