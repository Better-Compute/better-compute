import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCli } from '@better-compute/cli';

// `releases`, `rollouts`, `workflows` and `commands` (PLAN.md §9.3): each builds its route and body and calls the
// API as BETTER_COMPUTE_TOKEN; here over --url with a fetch stub that records the requests.

const NODE = 'node_01k5w0000000000000000000aa';
const ROLLOUT = 'rollout_01k5w0000000000000000000bb';
const WF = 'wf_01k5w0000000000000000000cc';
const CMD = 'cmd_01k5w0000000000000000000dd';

async function run(argv: string[], cwd?: string) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  try {
    await createCli().run([...argv, '--url', 'https://compute.test'], {
      out() {},
      env: { BETTER_COMPUTE_TOKEN: 'biam_ses_0123456789abcdefghij', BETTER_COMPUTE_TENANT: 'org_acme' },
      ...(cwd ? { cwd } : {}),
      fetch: async (input, init) => {
        const request = new Request(input, init);
        calls.push({ path: new URL(request.url).pathname.replace('/api/compute/', ''), body: JSON.parse(await request.text()) });
        return Response.json({ data: {} });
      },
    });
    return { ok: true as const, calls };
  } catch (error) {
    return { ok: false as const, calls, code: (error as { code?: string }).code };
  }
}

describe('releases and rollouts', () => {
  it('registers a manifest file as it is', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bc-releases-'));
    const manifest = { manifest: 'eyJ2ZXJzaW9uIjoiMC45LjEifQ', signatures: [{ kid: 'k1', sig: 'c2ln' }] };
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
    expect((await run(['releases', 'register', 'manifest.json'], dir)).calls).toEqual([
      { path: 'releases/register', body: { tenantId: 'org_acme', manifest } },
    ]);
    expect(await run(['releases', 'register', 'missing.json'], dir)).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
  });

  it('creates a rollout with waves, durations and a key, and refuses malformed waves', async () => {
    const result = await run([
      'rollouts', 'create', '--version', '0.9.1', '--pools', 'pool_a, pool_b', '--waves', '5,25,100',
      '--max-failure-ratio', '0.1', '--soak', '30m', '--upgrade-timeout', '20m', '--key', 'k1',
    ]);
    expect(result.calls[0]).toEqual({
      path: 'rollouts/create',
      body: {
        tenantId: 'org_acme',
        version: '0.9.1',
        poolIds: ['pool_a', 'pool_b'],
        waves: [5, 25, 100],
        maxFailureRatio: 0.1,
        soakSeconds: 1800,
        upgradeTimeoutSeconds: 1200,
        idempotencyKey: 'k1',
      },
    });
    for (const waves of ['5,25,90', '50,25,100', '0,100', '1.5,100'])
      expect(await run(['rollouts', 'create', '--version', '0.9.1', '--waves', waves])).toMatchObject({
        ok: false,
        code: 'INVALID_ARGUMENT',
        calls: [],
      });
    expect(await run(['rollouts', 'create', '--version', '0.9.1', '--max-failure-ratio', '2'])).toMatchObject({ ok: false });
    expect(await run(['rollouts', 'create', '--version', '0.9.1', '--upgrade-timeout', '10s'])).toMatchObject({ ok: false });
  });

  it('pauses, resumes and aborts with a rollback', async () => {
    expect((await run(['rollouts', 'pause', ROLLOUT, '--reason', 'XIDs'])).calls[0]).toEqual({
      path: 'rollouts/pause',
      body: { tenantId: 'org_acme', rolloutId: ROLLOUT, reason: 'XIDs' },
    });
    expect((await run(['rollouts', 'resume', ROLLOUT])).calls[0]!.path).toBe('rollouts/resume');
    expect((await run(['rollouts', 'abort', ROLLOUT, '--rollback'])).calls[0]).toEqual({
      path: 'rollouts/abort',
      body: { tenantId: 'org_acme', rolloutId: ROLLOUT, rollback: true },
    });
    expect(await run(['rollouts', 'get', 'wf_x'])).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
  });
});

describe('workflows and commands', () => {
  it('acts on a node’s workflows', async () => {
    expect((await run(['workflows', 'list', '--node', NODE, '--limit', '5'])).calls[0]).toEqual({
      path: 'workflows/list',
      body: { tenantId: 'org_acme', nodeId: NODE, limit: 5 },
    });
    expect((await run(['workflows', 'abort', WF, '--node', NODE, '--reason', 'wrong image'])).calls[0]).toEqual({
      path: 'workflows/abort',
      body: { tenantId: 'org_acme', nodeId: NODE, workflowId: WF, reason: 'wrong image' },
    });
    expect((await run(['workflows', 'pause', WF, '--node', NODE])).calls[0]!.body).toEqual({
      tenantId: 'org_acme',
      nodeId: NODE,
      workflowId: WF,
    });
    expect((await run(['workflows', 'retry', WF, '--node', NODE, '--from-step', 'deploy'])).calls[0]!.body).toMatchObject({
      fromStep: 'deploy',
    });
    // --node is required.
    expect(await run(['workflows', 'get', WF])).toMatchObject({ ok: false, calls: [] });
  });

  it('lists, reads and cancels a node’s commands', async () => {
    expect((await run(['commands', 'list', '--node', NODE, '--state', 'failed'])).calls[0]).toEqual({
      path: 'commands/list',
      body: { tenantId: 'org_acme', nodeId: NODE, state: 'failed' },
    });
    expect((await run(['commands', 'cancel', CMD, '--node', NODE])).calls[0]).toEqual({
      path: 'commands/cancel',
      body: { tenantId: 'org_acme', nodeId: NODE, commandId: CMD },
    });
    expect(await run(['commands', 'list', '--node', NODE, '--state', 'bogus'])).toMatchObject({ ok: false, calls: [] });
  });
});
