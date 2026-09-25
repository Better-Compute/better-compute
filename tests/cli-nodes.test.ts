import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCli, type CliIO } from '@better-compute/cli';

// `nodes`, `join-tokens` and `instances` (PLAN.md §9.3: commands mirror the API groups). The bodies are checked
// against a fetch stub; the node and join-token commands also run against `dev --sim 1`, whose registry validates
// every input for real.

const NODE = 'node_01k5w0000000000000000000aa';
const INST = 'inst_01k5w0000000000000000000bb';

async function stubbed(argv: string[], answer: unknown = { ok: true }, cwd?: string) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const out: string[] = [];
  const notes: string[] = [];
  const io: CliIO = {
    out: (line) => out.push(line),
    err: (line) => notes.push(line),
    env: { BETTER_COMPUTE_TOKEN: 'biam_ses_0123456789abcdefghij', BETTER_COMPUTE_TENANT: 'org_acme' },
    ...(cwd ? { cwd } : {}),
    fetch: async (input, init) => {
      const request = new Request(input, init);
      calls.push({ path: new URL(request.url).pathname, body: JSON.parse(await request.text()) });
      return Response.json({ data: answer });
    },
  };
  try {
    await createCli().run([...argv, '--url', 'https://compute.test', '--format', 'json'], io);
    return { ok: true as const, calls, stdout: out.join('\n'), notes };
  } catch (error) {
    return { ok: false as const, calls, code: (error as { code?: string }).code, message: (error as Error).message };
  }
}

async function wait<T>(probe: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 1200; i++) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('nodes, join-tokens and instances (request bodies)', () => {
  it('builds node changes, labels and taints', async () => {
    let result = await stubbed(['nodes', 'cordon', NODE, '--reason', 'disk swap', '--if-version', '7']);
    expect(result.calls).toEqual([
      { path: '/api/compute/nodes/cordon', body: { tenantId: 'org_acme', nodeId: NODE, reason: 'disk swap', version: 7 } },
    ]);
    result = await stubbed(['nodes', 'label', NODE, '--set', 'rack=r12, fabric=ib-a', '--remove', 'old']);
    expect(result.calls[0]!.body).toEqual({
      tenantId: 'org_acme',
      nodeId: NODE,
      set: { rack: 'r12', fabric: 'ib-a' },
      remove: ['old'],
    });
    result = await stubbed(['nodes', 'taint', NODE, '--add', 'gpu=degraded:NoSchedule']);
    expect(result.calls[0]!.body).toEqual({ tenantId: 'org_acme', nodeId: NODE, add: ['gpu=degraded:NoSchedule'] });
    expect(await stubbed(['nodes', 'label', NODE])).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    expect(await stubbed(['nodes', 'label', NODE, '--set', 'novalue'])).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    expect(await stubbed(['nodes', 'get', 'inst_x'])).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    result = await stubbed(['nodes', 'list', '--pool', 'h100-eu', '--cordoned', '--state', 'adopted']);
    expect(result.calls[0]!.body).toEqual({ tenantId: 'org_acme', poolId: 'h100-eu', cordoned: true, provisionState: 'adopted' });
  });

  it('creates instances with keys and user data from files, or a secret reference', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bc-instances-'));
    await writeFile(join(dir, 'a.pub'), 'ssh-ed25519 AAAAC3Nza a@laptop\n# comment\n\nssh-ed25519 AAAAC3Nzb b@laptop\n');
    await writeFile(join(dir, 'user-data'), '#cloud-config\npackages: [htop]\n');
    await writeFile(join(dir, 'id'), '-----BEGIN OPENSSH PRIVATE KEY-----\n');
    const base = ['instances', 'create', '--pool', 'vps-eu', '--flavor', 'g1.small', '--image', 'img_1'];
    let result = await stubbed([...base, '--ssh-key', 'a.pub', '--user-data', 'user-data', '--stopped', '--key', 'k1'], {}, dir);
    expect(result.calls[0]).toEqual({
      path: '/api/compute/instances/create',
      body: {
        tenantId: 'org_acme',
        poolId: 'vps-eu',
        flavor: 'g1.small',
        imageId: 'img_1',
        sshKeys: ['ssh-ed25519 AAAAC3Nza a@laptop', 'ssh-ed25519 AAAAC3Nzb b@laptop'],
        userData: '#cloud-config\npackages: [htop]\n',
        desiredState: 'stopped',
        idempotencyKey: 'k1',
        wait: { timeoutMs: 30_000 },
      },
    });
    result = await stubbed([...base, '--user-data', 'secret://org_acme/sec_1', '--wait', '0'], {}, dir);
    expect(result.calls[0]!.body).toMatchObject({ userData: 'secret://org_acme/sec_1' });
    expect(result.calls[0]!.body).not.toHaveProperty('wait');
    expect(result.calls[0]!.body.idempotencyKey).toMatch(/^cli-[0-9a-f]{24}$/);
    // A private key is never sent.
    expect(await stubbed([...base, '--ssh-key', 'id'], {}, dir)).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT', calls: [] });
    for (const verb of ['start', 'stop', 'delete']) {
      result = await stubbed(['instances', verb, INST]);
      expect(result.calls[0]).toEqual({ path: `/api/compute/instances/${verb}`, body: { tenantId: 'org_acme', instanceId: INST } });
    }
    result = await stubbed(['instances', 'list', '--all', '--state', 'running']);
    expect(result.calls[0]!.body).toEqual({ tenantId: 'org_acme', scope: 'all', state: 'running' });
  });

  it('writes a join token to a new 0600 file and never prints it then', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bc-join-token-'));
    const answer = { id: 'jt_1', poolId: 'h100-eu', token: 'bcjt_jt_1.s3cr3t' };
    const result = await stubbed(
      ['join-tokens', 'create', '--pool', 'h100-eu', '--ttl', '2h', '--max-uses', '8', '--expect-serial', 'SN1', '--out', 'token'],
      answer,
      dir,
    );
    expect(result.calls[0]!.body).toMatchObject({
      tenantId: 'org_acme',
      poolId: 'h100-eu',
      ttlSeconds: 7200,
      maxUses: 8,
      expect: { serial: 'SN1' },
    });
    expect(result.ok && result.stdout).not.toContain('s3cr3t');
    expect(await readFile(join(dir, 'token'), 'utf8')).toBe('bcjt_jt_1.s3cr3t\n');
    if (process.platform !== 'win32') expect((await stat(join(dir, 'token'))).mode & 0o777).toBe(0o600);
    // Never over an existing file; a replay (no token) cannot be written.
    expect(
      await stubbed(['join-tokens', 'create', '--pool', 'h100-eu', '--ttl', '2h', '--out', 'token'], answer, dir),
    ).toMatchObject({ ok: false, code: 'ALREADY_EXISTS' });
    expect(
      await stubbed(['join-tokens', 'create', '--pool', 'h100-eu', '--ttl', '2h', '--out', 'other'], { id: 'jt_1' }, dir),
    ).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(await stubbed(['join-tokens', 'create', '--pool', 'p', '--ttl', '30s'])).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    expect(await stubbed(['join-tokens', 'create', '--pool', 'p', '--ttl', '25h'])).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    // revoke takes the id; the token itself is refused before anything is sent.
    expect(await stubbed(['join-tokens', 'revoke', 'bcjt_jt_1.s3cr3t', '--pool', 'p'])).toMatchObject({
      ok: false,
      code: 'INVALID_ARGUMENT',
      calls: [],
    });
  });
});

describe('nodes and join-tokens against dev --sim', () => {
  it('lists, reads, cordons, labels and taints a node, and runs a join token through its life', { timeout: 180_000 }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bc-nodes-'));
    const controller = new AbortController();
    const notes: string[] = [];
    const dev = createCli().run(['dev', '--memory', '--port', '0', '--sim', '1'], {
      out() {},
      err: (line) => notes.push(line),
      env: {},
      cwd,
      signal: controller.signal,
    });
    const noted = (pattern: RegExp) => wait(() => notes.find((line) => pattern.test(line)), `${pattern}: ${notes.join('\n')}`);
    try {
      const url = /listening on (\S+)/.exec(await noted(/listening on/))![1]!;
      const token = /root token \(dev only\): (\S+)/.exec(await noted(/root token/))![1]!;
      const tenant = /root tenant (\S+);/.exec(await noted(/root tenant/))![1]!;
      await noted(/1 simulated node\(s\) adopted/);
      const env = { BETTER_COMPUTE_URL: url, BETTER_COMPUTE_TOKEN: token, BETTER_COMPUTE_TENANT: tenant };
      const cli = async (argv: string[]) => {
        const out: string[] = [];
        await createCli().run([...argv, '--format', 'json'], { out: (line) => out.push(line), env, cwd });
        return JSON.parse(out.join('\n'));
      };
      const listed = await cli(['nodes', 'list']);
      const node = listed.items[0];
      expect(node.id).toMatch(/^node_/);
      expect(await cli(['nodes', 'get', node.id])).toMatchObject({ id: node.id });
      expect(await cli(['nodes', 'cordon', node.id, '--reason', 'cli test'])).toMatchObject({ cordoned: true });
      expect((await cli(['nodes', 'list', '--cordoned'])).items.map((item: { id: string }) => item.id)).toEqual([node.id]);
      expect(await cli(['nodes', 'uncordon', node.id])).toMatchObject({ cordoned: false });
      await cli(['nodes', 'label', node.id, '--set', 'rack=r12']);
      expect(JSON.stringify((await cli(['nodes', 'get', node.id])).labels)).toMatch(/rack.*r12/);
      const tainted = await cli(['nodes', 'taint', node.id, '--add', 'gpu=degraded:NoSchedule']);
      expect(tainted.noScheduleReasons.some((reason: string) => reason.startsWith('taint:gpu'))).toBe(true);
      const events = await cli(['nodes', 'events', node.id, '--type', 'node.cordoned']);
      expect(events.items.length).toBeGreaterThan(0);

      const pool = (await cli(['nodes', 'get', node.id])).poolId as string;
      const created = await cli(['join-tokens', 'create', '--pool', pool, '--ttl', '30m', '--max-uses', '2']);
      expect(created.token).toMatch(/^bcjt_/);
      const tokens = await cli(['join-tokens', 'list', '--pool', pool]);
      expect(JSON.stringify(tokens)).not.toContain(created.token.split('.')[1]);
      const tokenId = created.id as string;
      expect(tokens.items.map((item: { id: string }) => item.id)).toContain(tokenId);
      await cli(['join-tokens', 'revoke', tokenId, '--pool', pool]);
      expect((await cli(['join-tokens', 'list', '--pool', pool])).items.map((item: { id: string }) => item.id)).not.toContain(
        tokenId,
      );
    } finally {
      controller.abort();
      await dev;
    }
  });
});
