import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCli, type CliIO } from '@better-compute/cli';
import { describePlan } from '../packages/cli/src/commands/fleet.js';

// `better-compute fleet export|plan|apply` over --url with a fetch stub standing in for the fleet
// group (PLAN.md §9.2): the requests they build and how they report plans, blocks and drift.

const HASH = 'a'.repeat(64);
const document = { version: 1, sites: [{ name: 'fra', kind: 'shared', region: 'eu-central' }] };

const planOf = (overrides: Record<string, unknown> = {}) => ({
  tenantId: 'root',
  prune: false,
  changes: [
    { kind: 'site', name: 'fra', action: 'create' },
    { kind: 'pool', name: 'vps-fra', action: 'update', fields: ['policy'] },
    { kind: 'offer', name: 'vps-fra -> acme', action: 'unchanged' },
  ],
  calls: [
    { path: 'sites/create', input: {} },
    { path: 'pools/update', input: {} },
  ],
  summary: { create: 1, update: 1, delete: 0, unchanged: 1 },
  blocked: false,
  planHash: HASH,
  ...overrides,
});

type Handler = (path: string, body: Record<string, unknown>) => Response;

async function run(argv: string[], handler: Handler, stdin?: string) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const out: string[] = [];
  const notes: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname.replace('/api/compute/', '');
    const body = JSON.parse(await request.text()) as Record<string, unknown>;
    calls.push({ path, body });
    return handler(path, body);
  };
  const io: CliIO = {
    out: (line) => out.push(line),
    err: (line) => notes.push(line),
    env: { BETTER_COMPUTE_TOKEN: 'biam_ses_0123456789abcdefghij', BETTER_COMPUTE_TENANT: 'root' },
    fetch,
    ...(stdin !== undefined ? { stdin: async () => stdin } : {}),
  };
  try {
    await createCli().run([...argv, '--url', 'https://compute.test'], io);
    return { ok: true as const, calls, stdout: out.join('\n'), notes: notes.join('\n') };
  } catch (error) {
    return {
      ok: false as const,
      calls,
      stdout: out.join('\n'),
      notes: notes.join('\n'),
      code: (error as { code?: string }).code,
    };
  }
}

const ok = (data: unknown) => Response.json({ data });

describe('fleet commands', () => {
  it('export writes the document to a new file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-'));
    const target = join(dir, 'fleet.json');
    const result = await run(['fleet', 'export', '--out', target], () =>
      ok({ config: document, missing: ['flavors'] }),
    );
    expect(result.ok).toBe(true);
    expect(result.calls).toEqual([{ path: 'fleet/export', body: { tenantId: 'root' } }]);
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual(document);
    expect(result.notes).toContain('does not run: flavors');
    // Never overwrites.
    const again = await run(['fleet', 'export', '--out', target], () => ok({ config: document }));
    expect(again.ok).toBe(false);
  });

  it('plan reads stdin, prints the changes and the hash, and hides calls by default', async () => {
    const result = await run(
      ['fleet', 'plan', '-', '--prune'],
      () => ok(planOf()),
      JSON.stringify(document),
    );
    expect(result.ok).toBe(true);
    expect(result.calls[0]).toEqual({
      path: 'fleet/plan',
      body: { tenantId: 'root', config: document, prune: true },
    });
    expect(result.notes).toContain('+ site fra');
    expect(result.notes).toContain('~ pool vps-fra (policy)');
    expect(result.notes).not.toContain('= offer');
    expect(result.stdout).toContain(HASH);
    expect(result.stdout).not.toContain('sites/create');
  });

  it('plan exits FLEET_DRIFTED with --fail-on-drift, and PLAN_BLOCKED on a blocked plan', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-'));
    const file = join(dir, 'fleet.json');
    await writeFile(file, JSON.stringify(document));
    const pending = await run(['fleet', 'plan', file, '--fail-on-drift'], () => ok(planOf()));
    expect(pending).toMatchObject({ ok: false, code: 'FLEET_DRIFTED' });
    const clean = await run(['fleet', 'plan', file, '--fail-on-drift'], () =>
      ok(planOf({ calls: [], summary: { create: 0, update: 0, delete: 0, unchanged: 3 } })),
    );
    expect(clean.ok).toBe(true);
    const blocked = await run(['fleet', 'plan', file], () =>
      ok(
        planOf({
          blocked: true,
          changes: [
            {
              kind: 'site',
              name: 'fra',
              action: 'update',
              fields: ['region'],
              blocked: 'sites cannot change',
            },
          ],
        }),
      ),
    );
    expect(blocked).toMatchObject({ ok: false, code: 'PLAN_BLOCKED' });
    expect(blocked.notes).toContain('BLOCKED: sites cannot change');
  });

  it('apply stops after the plan without --yes, and applies exactly the planned hash with it', async () => {
    const handler: Handler = (path) =>
      path === 'fleet/plan' ? ok(planOf()) : ok({ applied: 2, plan: planOf() });
    const dry = await run(['fleet', 'apply', '-'], handler, JSON.stringify(document));
    expect(dry.ok).toBe(true);
    expect(dry.calls.map((call) => call.path)).toEqual(['fleet/plan']);
    expect(dry.notes).toContain(`--plan-hash ${HASH}`);

    const real = await run(['fleet', 'apply', '-', '--yes'], handler, JSON.stringify(document));
    expect(real.calls.map((call) => call.path)).toEqual(['fleet/plan', 'fleet/apply']);
    expect(real.calls[1]!.body).toMatchObject({ planHash: HASH, prune: false });
    expect(real.notes).toContain('Applied 2 call(s).');

    const reviewed = await run(
      ['fleet', 'apply', '-', '--plan-hash', HASH],
      handler,
      JSON.stringify(document),
    );
    expect(reviewed.calls.map((call) => call.path)).toEqual(['fleet/apply']);
  });

  it('apply exits CONFIG_DRIFT when the fleet moved, and checks --plan-hash', async () => {
    const result = await run(
      ['fleet', 'apply', '-', '--plan-hash', HASH],
      () =>
        Response.json(
          { error: { code: 'CONFIG_DRIFT', message: 'The fleet changed' } },
          { status: 409 },
        ),
      JSON.stringify(document),
    );
    expect(result).toMatchObject({ ok: false, code: 'CONFIG_DRIFT' });
    const bad = await run(['fleet', 'apply', '-', '--plan-hash', 'nope'], () => ok({}), '{}');
    expect(bad).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
  });

  it('status reports drift and exits FLEET_DRIFTED with --fail-on-drift', async () => {
    const drift = {
      changes: [{ kind: 'pool', name: 'vps-fra', action: 'update', fields: ['policy'] }],
      summary: { create: 0, update: 1, delete: 0, unchanged: 0 },
    };
    const clean = await run(['fleet', 'status'], () =>
      ok({ tenantId: 'root', applied: { planHash: HASH } }),
    );
    expect(clean.ok && clean.notes).toContain('matches the applied document');
    const drifted = await run(['fleet', 'status', '--fail-on-drift'], () =>
      ok({ tenantId: 'root', applied: { planHash: HASH }, drift }),
    );
    expect(drifted).toMatchObject({ ok: false, code: 'FLEET_DRIFTED' });
    expect(drifted.notes).toContain('~ pool vps-fra (policy)');
    expect(drifted.calls).toEqual([{ path: 'fleet/status', body: { tenantId: 'root' } }]);
  });

  it('describes a plan in one line per change plus a summary', () => {
    expect(describePlan(planOf())).toEqual([
      '+ site fra',
      '~ pool vps-fra (policy)',
      '1 to create, 1 to update, 0 to delete, 1 unchanged.',
    ]);
  });
});
