import { describe, expect, it } from 'vitest';
import { createCli, type CliIO } from '@better-compute/cli';

// `better-compute sandbox …` (PLAN.md §3.7): each command is one call to the vps module's sandboxes group. Here the
// remote transport talks to a recording fetch, so the request bodies (the contract with the API) are checked.

const SBX = 'sbx_01k5w000000000000000000abc';
const TEMPLATE = 'sbxt_01k5w00000000000000000abc';

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
