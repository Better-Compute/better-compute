import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { draftId, type Project, type Site } from '@better-compute/core';
import { ACME, OTHER, ROOT } from './support/server.js';
import { ADMIN, OUTSIDER, USER, serverHarness, type Harness } from './support/server-api.js';

// `projects` and `sites` (PLAN.md §9.2, module server): validation, tenant scoping, idempotent
// creates, the projection rows and events they write, and the decisions they are made under.

let h: Harness;
beforeAll(async () => {
  h = await serverHarness();
  h.iam.allow({ token: USER });
  h.iam.allow({ token: ADMIN });
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => h.reset());

const decisions = () =>
  h.iam.calls.flatMap((call) =>
    call.decision
      ? [
          `${call.method} ${call.decision.action} @ ${call.decision.resource.type}/${call.decision.resource.id} in ${call.decision.tenantId}`,
        ]
      : [],
  );

describe('projects', () => {
  it('creates a project under projects:manage on the tenant, with its projection row and event', async () => {
    const project = await h.call<Project>('projects/create', USER, {
      tenantId: ACME,
      name: 'vision',
      idempotencyKey: 'create-vision',
    });
    const id = await draftId('prj', ACME, 'id-user', 'create-vision');
    expect(project).toEqual({ id, tenantId: ACME, name: 'vision', state: 'active', version: 1 });
    expect(decisions()).toEqual([
      `require compute:projects:manage @ compute-tenant/${ACME} in ${ACME}`,
    ]);
    expect(h.ports.authz.rows).toEqual([
      { type: 'project', id, tenantId: ACME, attributes: {}, ownerId: 'id-user' },
    ]);
    expect(h.ports.events.published).toEqual([
      {
        type: 'project.created',
        tenantId: ACME,
        subject: `project/${id}`,
        data: { projectId: id, name: 'vision' },
      },
    ]);
    const { rows } = await h.store.query(
      "SELECT resource_type, resource_id FROM audit_events WHERE action = 'compute:projects:manage' AND tenant_id = $1",
      [ACME],
    );
    expect(rows).toContainEqual({ resource_type: 'compute-tenant', resource_id: ACME });
  });

  it('refuses a second project with the same name under another key', async () => {
    await h.call('projects/create', USER, { tenantId: ACME, name: 'dup', idempotencyKey: 'dup-1' });
    const error = await h.failure('projects/create', USER, {
      tenantId: ACME,
      name: 'dup',
      idempotencyKey: 'dup-2',
    });
    expect(error).toMatchObject({
      code: 'CONFLICT',
      message: 'A project named dup already exists',
    });
  });

  it('gets a project in its tenant only, decided on the project', async () => {
    const project = await h.call<Project>('projects/create', USER, {
      tenantId: ACME,
      name: 'lookup',
      idempotencyKey: 'lookup',
    });
    h.reset();
    expect(await h.call('projects/get', USER, { tenantId: ACME, projectId: project.id })).toEqual(
      project,
    );
    expect(decisions()).toEqual([
      `authorize compute:projects:read @ compute-project/${project.id} in ${ACME}`,
    ]);
    // A root caller naming another tenant finds nothing there.
    expect(
      (await h.failure('projects/get', ADMIN, { tenantId: OTHER, projectId: project.id })).code,
    ).toBe('NOT_FOUND');
    expect(
      (await h.failure('projects/get', OUTSIDER, { tenantId: ACME, projectId: project.id })).code,
    ).toBe('ACCESS_DENIED');
  });

  it('validates exactly, unknown fields included', async () => {
    const bad = [
      [{ tenantId: ACME, name: 'Upper', idempotencyKey: 'k' }, /name: Must match/],
      [
        { tenantId: ACME, name: 'ok', idempotencyKey: 'k', extra: true },
        /extra: Unknown field extra/,
      ],
      [{ tenantId: ACME, name: 'ok' }, /idempotencyKey: Required/],
      [{ tenantId: 'bad tenant', name: 'ok', idempotencyKey: 'k' }, /tenantId: Must match/],
    ] as const;
    for (const [input, message] of bad) {
      const error = await h.failure('projects/create', USER, input);
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.message).toMatch(message);
    }
    expect((await h.failure('projects/get', USER, { tenantId: ACME, projectId: 'p-1' })).code).toBe(
      'INVALID_INPUT',
    );
    expect((await h.failure('projects/list', USER, { tenantId: ACME, limit: 51 })).message).toMatch(
      /limit: Must be at most 50/,
    );
    expect(h.iam.calls).toEqual([]);
  });

  it('filters lists by state', async () => {
    await h.call('projects/create', USER, { tenantId: ACME, name: 'listed', idempotencyKey: 'l' });
    const active = await h.call<{ items: Project[] }>('projects/list', USER, {
      tenantId: ACME,
      state: 'active',
    });
    expect(active.items.map((project) => project.name)).toContain('listed');
    const archived = await h.call<{ items: Project[] }>('projects/list', USER, {
      tenantId: ACME,
      state: 'archived',
    });
    expect(archived.items).toEqual([]);
  });
});

describe('sites', () => {
  it('creates platform sites under compute-fleet/global in the root tenant', async () => {
    const site = await h.call<Site>('sites/create', ADMIN, {
      tenantId: ROOT,
      kind: 'shared',
      region: 'eu-west-1',
      iamRegion: 'eu-central-1',
      idempotencyKey: 'fra1',
    });
    const id = await draftId('site', ROOT, 'id-admin', 'fra1');
    expect(site).toEqual({
      id,
      ownerTenantId: ROOT,
      kind: 'shared',
      region: 'eu-west-1',
      iamRegion: 'eu-central-1',
      version: 1,
    });
    expect(decisions()).toEqual([`require compute:sites:manage @ compute-fleet/global in ${ROOT}`]);
    expect(h.ports.authz.rows).toEqual([
      {
        type: 'site',
        id,
        tenantId: ROOT,
        attributes: { region: 'eu-west-1', kind: 'shared', iamRegion: 'eu-central-1' },
      },
    ]);
    expect(h.ports.events.published[0]).toMatchObject({ type: 'site.created', tenantId: ROOT });
  });

  it('keeps platform sites to root callers, and to the root tenant', async () => {
    const input = { tenantId: ACME, kind: 'dedicated', region: 'eu-west-1', idempotencyKey: 's' };
    // An org caller: the fleet decision is the root tenant's, so the pre-check refuses it.
    expect((await h.failure('sites/create', USER, input)).code).toBe('ACCESS_DENIED');
    expect(h.iam.count('require')).toBe(0);
    // A root caller naming an org tenant for a platform site.
    const error = await h.failure('sites/create', ADMIN, input);
    expect(error).toMatchObject({ code: 'INVALID_INPUT' });
    expect(error.message).toMatch(/dedicated sites belong to the root tenant/);
  });

  it('creates a tenant’s custom site under compute-tenant/{t}', async () => {
    const site = await h.call<Site>('sites/create', USER, {
      tenantId: ACME,
      kind: 'custom',
      region: 'us-east-1',
      idempotencyKey: 'my-rack',
    });
    expect(site).toMatchObject({ ownerTenantId: ACME, kind: 'custom' });
    expect(site.iamRegion).toBeUndefined();
    expect(decisions()).toEqual([
      `require compute:sites:manage @ compute-tenant/${ACME} in ${ACME}`,
    ]);
    h.reset();
    // Replays by the same caller; a different request under the key conflicts.
    expect(
      await h.call('sites/create', USER, {
        tenantId: ACME,
        kind: 'custom',
        region: 'us-east-1',
        idempotencyKey: 'my-rack',
      }),
    ).toEqual(site);
    expect(h.iam.count('require')).toBe(0);
    expect(
      (
        await h.failure('sites/create', USER, {
          tenantId: ACME,
          kind: 'custom',
          region: 'us-west-2',
          idempotencyKey: 'my-rack',
        })
      ).code,
    ).toBe('CONFLICT');
  });

  it('gets and lists only the sites the projection holds for the tenant', async () => {
    const platform = await h.seed.site(ROOT, { visibleTo: [ROOT, ACME] });
    const hidden = await h.seed.site(ROOT);
    const theirs = await h.seed.site(OTHER);
    expect(
      await h.call<Site>('sites/get', USER, { tenantId: ACME, siteId: platform }),
    ).toMatchObject({
      id: platform,
      ownerTenantId: ROOT,
    });
    for (const siteId of [hidden, theirs])
      expect((await h.failure('sites/get', USER, { tenantId: ACME, siteId })).code).toBe(
        'NOT_FOUND',
      );
    const page = await h.call<{ items: Site[] }>('sites/list', USER, { tenantId: ACME });
    const ids = page.items.map((site) => site.id);
    expect(ids).toContain(platform);
    expect(ids).not.toContain(hidden);
    expect(ids).not.toContain(theirs);
    const filtered = await h.call<{ items: Site[] }>('sites/list', USER, {
      tenantId: ACME,
      kind: 'custom',
    });
    expect(filtered.items.every((site) => site.kind === 'custom')).toBe(true);
  });
});
