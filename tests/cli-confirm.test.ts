import { describe, expect, it } from 'vitest';
import { createCli, type CliIO } from '@better-compute/cli';

// Destructive commands (metal retire, metal undeploy, a hard metal power action, nodes delete) go ahead
// only with --yes, or after a "yes" at an interactive terminal; anywhere else (a pipe, CI) they refuse
// before calling the API. One helper decides for all of them.

const NODE = 'node_01k5w0000000000000000000aa';

async function run(argv: string[], confirm?: CliIO['confirm']) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const asked: string[] = [];
  try {
    await createCli().run([...argv, '--url', 'https://compute.test'], {
      out() {},
      env: { BETTER_COMPUTE_TOKEN: 'biam_ses_0123456789abcdefghij', BETTER_COMPUTE_TENANT: 'org_acme' },
      ...(confirm
        ? {
            confirm: async (question) => {
              asked.push(question);
              return confirm(question);
            },
          }
        : {}),
      fetch: async (input, init) => {
        const request = new Request(input, init);
        calls.push({ path: new URL(request.url).pathname.replace('/api/compute/', ''), body: JSON.parse(await request.text()) });
        return Response.json({ data: {} });
      },
    });
    return { ok: true as const, calls, asked };
  } catch (error) {
    return { ok: false as const, calls, asked, code: (error as { code?: string }).code, message: (error as Error).message };
  }
}

const destructive = [
  { name: 'metal retire', argv: ['metal', 'retire', NODE], path: 'metal/retire', says: /erases? .*disks/ },
  { name: 'metal undeploy', argv: ['metal', 'undeploy', NODE, '--wipe', 'secure-erase'], path: 'metal/undeploy', says: /wipes? .*disks/ },
  { name: 'metal power --action off', argv: ['metal', 'power', NODE, '--action', 'off'], path: 'metal/power', says: /power/ },
  { name: 'metal power --action reset', argv: ['metal', 'power', NODE, '--action', 'reset'], path: 'metal/power', says: /power/ },
  { name: 'metal power --action cycle', argv: ['metal', 'power', NODE, '--action', 'cycle'], path: 'metal/power', says: /power/ },
  { name: 'nodes delete', argv: ['nodes', 'delete', NODE], path: 'nodes/delete', says: /for good/ },
] as const;

describe.each(destructive)('$name', (command) => {
  it('refuses without --yes where nobody can be asked, before any call', async () => {
    const refused = await run([...command.argv]);
    expect(refused).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT', calls: [] });
    expect(refused.ok || refused.message).toMatch(/--yes/);
    expect(refused.ok || refused.message).toContain(NODE);
  });

  it('goes ahead with --yes, asking nobody', async () => {
    const done = await run([...command.argv, '--yes'], async () => false);
    expect(done).toMatchObject({ ok: true, asked: [] });
    expect(done.calls.map((call) => call.path)).toEqual([command.path]);
    expect(done.calls[0]!.body).not.toHaveProperty('yes');
  });

  it('asks at an interactive terminal: yes goes ahead, anything else calls nothing', async () => {
    const yes = await run([...command.argv], async () => true);
    expect(yes.ok).toBe(true);
    expect(yes.calls.map((call) => call.path)).toEqual([command.path]);
    expect(yes.asked).toHaveLength(1);
    expect(yes.asked[0]).toMatch(command.says);
    expect(yes.asked[0]).toContain(NODE);
    const no = await run([...command.argv], async () => false);
    expect(no).toMatchObject({ ok: false, code: 'CANCELLED', calls: [] });
  });
});

describe('what is not destructive needs no confirmation', () => {
  it.each(['on', 'graceful-off', 'graceful-restart', 'nmi'])('metal power --action %s', async (action) => {
    const done = await run(['metal', 'power', NODE, '--action', action]);
    expect(done).toMatchObject({ ok: true, asked: [] });
    expect(done.calls[0]!.body).toMatchObject({ action });
  });

  it('metal manage, inspect, provide, rescue, unrescue and recover', async () => {
    for (const verb of ['manage', 'inspect', 'provide', 'rescue', 'unrescue', 'recover']) {
      const done = await run(['metal', verb, NODE]);
      expect(done.ok, verb).toBe(true);
      expect(await run(['metal', verb, NODE, '--yes']), verb).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    }
  });
});
