import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCli } from '@better-compute/cli';

// metal, profiles, provider-accounts and sandbox-snapshot (PLAN.md §9.3): bodies over a fetch stub; BMC
// credentials only as a reference or from a password file.

const NODE = 'node_01k5w0000000000000000000aa';
const NODE2 = 'node_01k5w0000000000000000000ab';
const PACCT = 'pacct_01k5w0000000000000000000cc';

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

const enroll = ['metal', 'enroll', '--site', 'site_1', '--pool', 'pool_1', '--bmc-address', '10.20.0.14', '--bmc-driver', 'redfish'];

describe('metal', () => {
  it('enrolls with a credentials reference or a password file, never a password flag', async () => {
    expect((await run([...enroll, '--bmc-credentials', 'secret://org_acme/bmc-r12', '--macs', 'aa:bb:cc:dd:ee:ff', '--legacy-bios'])).calls[0]).toEqual({
      path: 'metal/enroll',
      body: {
        tenantId: 'org_acme',
        siteId: 'site_1',
        poolId: 'pool_1',
        bmc: { address: '10.20.0.14', driver: 'redfish', credentials: 'secret://org_acme/bmc-r12' },
        macs: ['aa:bb:cc:dd:ee:ff'],
        uefi: false,
      },
    });
    const dir = await mkdtemp(join(tmpdir(), 'bc-metal-'));
    await writeFile(join(dir, 'bmc-pass'), 'hunter2\n');
    expect(
      (await run([...enroll, '--bmc-username', 'admin', '--bmc-password-file', 'bmc-pass'], dir)).calls[0]!.body.bmc,
    ).toEqual({ address: '10.20.0.14', driver: 'redfish', credentials: { username: 'admin', password: 'hunter2' } });
    for (const extra of [
      [],
      ['--bmc-credentials', 'hunter2'],
      ['--bmc-username', 'admin'],
      ['--bmc-credentials', 'secret://x/y', '--bmc-username', 'admin', '--bmc-password-file', 'bmc-pass'],
      ['--bmc-password', 'hunter2'],
    ])
      expect(await run([...enroll, ...extra], dir)).toMatchObject({ ok: false, calls: [] });
  });

  it('runs lifecycle verbs, power actions and a bulk batch', async () => {
    for (const verb of ['manage', 'inspect', 'provide', 'rescue', 'unrescue', 'recover', 'retire'])
      expect((await run(['metal', verb, NODE])).calls[0]).toEqual({ path: `metal/${verb}`, body: { tenantId: 'org_acme', nodeId: NODE } });
    expect((await run(['metal', 'deploy', NODE, '--profile', 'ubuntu-gpu', '--profile-version', '3'])).calls[0]!.body).toEqual({
      tenantId: 'org_acme',
      nodeId: NODE,
      profileId: 'ubuntu-gpu',
      profileVersion: 3,
    });
    expect((await run(['metal', 'undeploy', NODE, '--wipe', 'secure-erase'])).calls[0]!.body).toMatchObject({ wipe: 'secure-erase' });
    expect((await run(['metal', 'power', NODE, '--action', 'cycle'])).calls[0]!.body).toMatchObject({ action: 'cycle' });
    const dir = await mkdtemp(join(tmpdir(), 'bc-bulk-'));
    await writeFile(join(dir, 'nodes.txt'), `${NODE}\n${NODE2}\n${NODE}\n`);
    expect(
      (await run(['metal', 'bulk', '--pool', 'pool_1', '--verb', 'retire', '--nodes-file', 'nodes.txt', '--reason', 'EOL'], dir)).calls[0],
    ).toEqual({
      path: 'metal/bulk',
      body: { tenantId: 'org_acme', poolId: 'pool_1', verb: 'retire', nodeIds: [NODE, NODE2], reason: 'EOL' },
    });
    expect(await run(['metal', 'bulk', '--pool', 'p', '--verb', 'retire', '--nodes', NODE, '--wipe', 'quick', '--reason', 'x'])).toMatchObject({
      ok: false,
      calls: [],
    });
    expect(await run(['metal', 'bulk', '--pool', 'p', '--verb', 'retire', '--nodes', 'inst_x', '--reason', 'x'])).toMatchObject({
      ok: false,
      calls: [],
    });
  });
});

describe('profiles, provider accounts and snapshots', () => {
  it('sends documents and configs from JSON files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bc-profiles-'));
    const document = { id: 'ubuntu-gpu', version: 3, target: 'metal', steps: [] };
    await writeFile(join(dir, 'profile.json'), JSON.stringify(document));
    await writeFile(join(dir, 'hetzner.json'), JSON.stringify({ token: 'secret://org_acme/hetzner' }));
    expect((await run(['profiles', 'create', 'profile.json', '--public'], dir)).calls[0]).toEqual({
      path: 'profiles/create',
      body: { tenantId: 'org_acme', document, visibility: 'public' },
    });
    expect((await run(['profiles', 'render', 'ubuntu-gpu', '--profile-version', '3'])).calls[0]).toEqual({
      path: 'profiles/render',
      body: { tenantId: 'org_acme', profileId: 'ubuntu-gpu', profileVersion: 3 },
    });
    expect(
      (await run(['provider-accounts', 'create', '--provider', 'provider-hetzner', '--name', 'main', '--config-file', 'hetzner.json', '--key', 'k'], dir))
        .calls[0]!.body,
    ).toEqual({
      tenantId: 'org_acme',
      provider: 'provider-hetzner',
      name: 'main',
      config: { token: 'secret://org_acme/hetzner' },
      idempotencyKey: 'k',
    });
    expect((await run(['provider-accounts', 'offers', PACCT, '--kind', 'metal'])).calls[0]!.body).toEqual({
      tenantId: 'org_acme',
      accountId: PACCT,
      query: { kind: 'metal' },
    });
    expect(await run(['provider-accounts', 'bootstrap', PACCT, '--pool', 'pool_1'])).toMatchObject({ ok: false, calls: [] });
    expect((await run(['sandbox-snapshot', 'list', '--all'])).calls[0]!.body).toEqual({ tenantId: 'org_acme', scope: 'all' });
  });
});
