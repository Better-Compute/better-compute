import { beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '@better-compute/core';
import { tenantProjectName } from '@better-compute/provider-digitalocean';
import { DoEmulator } from './support/do-emulator/index.js';
import { seedSshKey } from './support/do-emulator/keys.js';
import { projectsOf } from './support/do-emulator/projects.js';
import { build, ctx, freshBudgets } from './support/do-harness.js';

// DigitalOcean P9 projects (DO-D22): with `projectPerTenant`, every new Droplet is assigned to the `bc-<tenant>`
// project, made on first use. Off by default; the assignment is best effort (D-ops-4): a create that made its
// Droplet never fails over it.

beforeEach(freshBudgets);

const testKey =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICbbzkHhLXTIyRDUgXLAC0pVt8MQajr4BGKVoF5MJ71Z test@bc';

function world() {
  const emu = new DoEmulator();
  seedSshKey(emu.state, 'k', testKey);
  return emu;
}

const request = (over: Record<string, unknown> = {}) => ({
  offerId: 'nyc3/s-1vcpu-1gb',
  image: 'ubuntu-24-04-x64',
  userData: '#cloud-config\n',
  name: 'inst_1',
  sshKeys: [testKey],
  tenantId: 'tenant-acme',
  ...over,
});

const on = { token: 'secret://do/t', regions: ['nyc3'], projectPerTenant: true };

function recording(): { log: Logger; lines: { level: string; event: string; data: unknown }[] } {
  const lines: { level: string; event: string; data: unknown }[] = [];
  const push = (level: string) => (event: string, data?: unknown) =>
    void lines.push({ level, event, data });
  return {
    lines,
    log: { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') },
  };
}

describe('projectPerTenant', () => {
  it('names the project after the tenant', () => {
    expect(tenantProjectName('tenant-acme')).toBe('bc-tenant-acme');
  });

  it('is off by default: no project request', async () => {
    const emu = world();
    const compute = await build(emu);
    await compute.create(request(), ctx('c1'));
    expect(emu.requests.some((r) => r.url.pathname.startsWith('/v2/projects'))).toBe(false);
  });

  it('makes the tenant’s project once and assigns each new Droplet to it', async () => {
    const emu = world();
    const compute = await build(emu, on);
    const first = await compute.create(request(), ctx('c1'));
    const second = await compute.create(request({ name: 'inst_2' }), ctx('c2'));
    const projects = projectsOf(emu);
    const ours = [...projects.projects.values()].filter((p) => p.name === 'bc-tenant-acme');
    expect(ours).toHaveLength(1);
    expect(ours[0]).toMatchObject({ environment: 'Production' });
    expect(projects.resources.get(ours[0]!.id)).toEqual([
      `do:droplet:${first.id}`,
      `do:droplet:${second.id}`,
    ]);
    // One create of the project, and the second Droplet needed no new lookup.
    expect(
      emu.requests.filter((r) => r.method === 'POST' && r.url.pathname === '/v2/projects'),
    ).toHaveLength(1);
    expect(
      emu.requests.filter((r) => r.method === 'GET' && r.url.pathname === '/v2/projects'),
    ).toHaveLength(1);
  });

  it('reuses a project that already exists, and separates tenants', async () => {
    const emu = world();
    const projects = projectsOf(emu);
    projects.projects.set('p-acme', { id: 'p-acme', name: 'bc-tenant-acme' });
    const compute = await build(emu, on);
    const a = await compute.create(request(), ctx('c1'));
    const b = await compute.create(request({ name: 'inst_2', tenantId: 'tenant-beta' }), ctx('c2'));
    expect(projects.resources.get('p-acme')).toEqual([`do:droplet:${a.id}`]);
    const beta = [...projects.projects.values()].find((p) => p.name === 'bc-tenant-beta')!;
    expect(projects.resources.get(beta.id)).toEqual([`do:droplet:${b.id}`]);
  });

  it('takes the project another process made between its lookup and its create', async () => {
    const emu = world();
    const projects = projectsOf(emu);
    emu.beforeAction('POST /projects', () => {
      projects.projects.set('p-race', { id: 'p-race', name: 'bc-tenant-acme' });
    });
    const compute = await build(emu, on);
    const machine = await compute.create(request(), ctx('c1'));
    expect(projects.resources.get('p-race')).toEqual([`do:droplet:${machine.id}`]);
  });

  it('never fails a create over the project: it logs, without the token, and retries on the next create', async () => {
    const emu = world();
    const { log, lines } = recording();
    const compute = await build(emu, on, {}, { log });
    emu.failNext({ method: 'POST', path: /^\/projects$/ }, 403, emu.error('forbidden').body);
    const machine = await compute.create(request(), ctx('c1'));
    expect(machine.id).toBeDefined();
    const warning = lines.find((line) => line.event === 'digitalocean.projectAssignFailed');
    expect(warning).toMatchObject({
      level: 'warn',
      data: expect.objectContaining({ code: 'ACCESS_DENIED' }),
    });
    expect(JSON.stringify(lines)).not.toContain('do-token');
    // The failure is not cached: the next create makes the project.
    const next = await compute.create(request({ name: 'inst_2' }), ctx('c2'));
    const ours = [...projectsOf(emu).projects.values()].find((p) => p.name === 'bc-tenant-acme')!;
    expect(projectsOf(emu).resources.get(ours.id)).toEqual([`do:droplet:${next.id}`]);
  });

  it('skips a create with no tenant, or a tenant id that cannot name a project', async () => {
    const emu = world();
    const { log, lines } = recording();
    const compute = await build(emu, on, {}, { log });
    await compute.create(request({ tenantId: undefined }), ctx('c1'));
    await compute.create(request({ name: 'inst_2', tenantId: 'x'.repeat(200) }), ctx('c2'));
    expect(emu.requests.some((r) => r.url.pathname.startsWith('/v2/projects'))).toBe(false);
    expect(lines.some((line) => line.event === 'digitalocean.projectTenantInvalid')).toBe(true);
  });
});
