import { beforeEach, describe, expect, it } from 'vitest';
import { isComputeError, type ComputeError, type Logger } from '@better-compute/core';
// From vps, as a provider's own tests run them (a provider never depends on the cloud-resources module).
import {
  providerResourcesConformanceCases,
  type ProviderResourcesConformanceSubject,
} from '@better-compute/vps';
import {
  deploymentTag,
  digitaloceanProvider,
  keyTag,
  managedTag,
  tagFor,
} from '@better-compute/provider-digitalocean';
import { seedDatabase } from './support/do-emulator/databases.js';
import { DoEmulator, type RecordedRequest } from './support/do-emulator/index.js';
import {
  build,
  ctx,
  doAccount,
  freshBudgets,
  platformAccount,
  secrets,
} from './support/do-harness.js';

// provider-digitalocean's ProviderResources (P7) against the emulator: the conformance cases the fake also passes,
// then Managed Databases in depth: the key-tag protocol, secret outputs, in-place changes and replaceRequired,
// deletion safety, the resources living in a cluster, and discover/adopt/release.

const t0 = Date.parse('2026-11-05T10:00:00Z');
const emulator = () => new DoEmulator({ now: () => t0 });
const pg = { region: 'nyc3', version: '16', size: 'db-s-1vcpu-1gb', nodes: 1 };
const labels = {
  'better-compute-managed': 'true',
  'better-compute-resource': 'crs_abc',
  'better-compute-tenant': 'acme',
};
const ours = [managedTag, deploymentTag('default')];
const mutations = (emu: DoEmulator, method: string, path: RegExp): RecordedRequest[] =>
  emu.requests.filter((r) => r.method === method && path.test(r.url.pathname));

async function failure(promise: Promise<unknown>): Promise<ComputeError> {
  try {
    await promise;
  } catch (error) {
    if (isComputeError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

/** Ensures until ready (the emulator moves on reads). */
async function ready(
  resources: Awaited<ReturnType<typeof build>>['resources'],
  request: any,
  key = 'crs_abc',
) {
  let state = await resources.ensure(request, ctx(key));
  for (let round = 0; round < 10 && state.state !== 'ready'; round++)
    state = await resources.ensure({ ...request, id: state.id }, ctx(key));
  return state;
}

beforeEach(freshBudgets);

describe('ProviderResources conformance (DigitalOcean emulator)', () => {
  const subject = (): ProviderResourcesConformanceSubject => {
    const emu = emulator();
    const unmanaged = seedDatabase(emu.state, { name: 'by-hand' });
    return {
      provider: digitaloceanProvider({ fetch: emu.fetch }),
      config: doAccount,
      context: { secrets, account: platformAccount },
      kind: 'do.database.pg',
      spec: pg,
      updatedSpec: { ...pg, size: 'db-s-2vcpu-4gb' },
      replaceSpec: { ...pg, region: 'ams3' },
      unmanaged: unmanaged.id,
    };
  };
  for (const test of providerResourcesConformanceCases())
    it(test.name, async () => {
      freshBudgets();
      await test.run(subject());
    });
});

describe('Managed Databases kinds', () => {
  it('lists a cluster kind per engine and what lives in each; passwords and URIs are secret outputs', async () => {
    const { resources } = await build(emulator());
    const kinds = resources.kinds();
    const names = kinds.map((kind) => kind.kind);
    for (const engine of ['pg', 'mysql', 'valkey', 'mongodb', 'kafka', 'opensearch'])
      expect(names).toContain(`do.database.${engine}`);
    expect(names).toEqual(
      expect.arrayContaining([
        'do.database.pg.user',
        'do.database.pg.pool',
        'do.database.pg.replica',
        'do.database.pg.firewall',
        'do.database.mysql.replica',
        'do.database.kafka.user',
      ]),
    );
    expect(names).not.toContain('do.database.valkey.user');
    expect(names).not.toContain('do.database.mysql.pool');
    const cluster = kinds.find((kind) => kind.kind === 'do.database.pg')!;
    expect(cluster).toMatchObject({
      family: 'data',
      regional: true,
      secretOutputs: ['password', 'uri', 'privateUri'],
    });
    expect(cluster.outputs).not.toContain('password');
    expect(cluster.outputs).not.toContain('uri');
    expect(cluster.updatable).toEqual(['size', 'nodes', 'storageMiB', 'version']);
    expect(kinds.find((kind) => kind.kind === 'do.database.valkey')!.updatable).not.toContain(
      'version',
    );
    for (const kind of kinds.filter((entry) => entry.parent !== undefined))
      expect(names).toContain(kind.parent);
    // Kafka needs three nodes.
    const kafka = kinds.find((kind) => kind.kind === 'do.database.kafka')!;
    expect((await kafka.spec['~standard'].validate({ ...pg, nodes: 1 })).issues).toBeDefined();
  });
});

describe('Managed Database clusters', () => {
  it('creates with the ownership, deployment and key tags; the password only ever in secretOutputs', async () => {
    const emu = emulator();
    const logs: string[] = [];
    const log = Object.fromEntries(
      ['debug', 'info', 'warn', 'error'].map((level) => [
        level,
        (m: string, f?: unknown) => logs.push(JSON.stringify([m, f])),
      ]),
    ) as unknown as Logger;
    const { resources } = await build(emu, doAccount, {}, { log });
    const first = await resources.ensure(
      { kind: 'do.database.pg', name: 'bc-r-orders', spec: pg, labels },
      ctx('crs_abc'),
    );
    expect(first.state).toBe('pending');
    const [create] = mutations(emu, 'POST', /^\/v2\/databases$/);
    expect(create!.body).toMatchObject({
      name: 'bc-r-orders',
      engine: 'pg',
      version: '16',
      region: 'nyc3',
      num_nodes: 1,
    });
    expect((create!.body as any).tags).toEqual(
      expect.arrayContaining([
        ...ours,
        keyTag('crs_abc'),
        tagFor('better-compute-resource', 'crs_abc'),
        tagFor('better-compute-tenant', 'acme'),
      ]),
    );
    const state = await ready(resources, {
      kind: 'do.database.pg',
      name: 'bc-r-orders',
      spec: pg,
      labels,
    });
    expect(state.id).toBe(first.id);
    const cluster = emu.state.databases.get(state.id)!;
    expect(state.secretOutputs).toEqual({
      password: cluster._admin.password,
      uri: expect.stringContaining(cluster._admin.password),
      privateUri: expect.stringContaining(cluster._admin.password),
    });
    expect(state.outputs).toMatchObject({
      host: expect.stringContaining('bc-r-orders'),
      port: '25060',
      user: 'doadmin',
      engine: 'pg',
    });
    expect(JSON.stringify(state.outputs)).not.toContain(cluster._admin.password);
    // It bills by its nodes: the module samples this rate for do.database.pg.node.hours.
    expect(state.usage).toEqual({ 'do.database.pg.node.hours': 1 });
    // Neither the password nor the token is ever logged.
    expect(logs.join('\n')).not.toContain(cluster._admin.password);
    expect(logs.join('\n')).not.toContain('do-token');
  });

  it('a retried ensure without the id finds the cluster by its key tag; a racing create converges on it', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const first = await resources.ensure(
      { kind: 'do.database.pg', name: 'bc-r-race', spec: pg, labels },
      ctx('crs_race'),
    );
    const again = await resources.ensure(
      { kind: 'do.database.pg', name: 'bc-r-race', spec: pg, labels },
      ctx('crs_race'),
    );
    expect(again.id).toBe(first.id);
    expect(mutations(emu, 'POST', /^\/v2\/databases$/)).toHaveLength(1);
    // A create whose lookup missed the other one (the race): DO refuses the name, and the key tag finds ours.
    const emu2 = emulator();
    const other = await build(emu2);
    emu2.beforeAction('POST /databases', (context) => {
      seedDatabase(context.state, {
        name: 'bc-r-race',
        tags: [...ours, keyTag('crs_race')],
        status: 'creating',
      });
    });
    const raced = await other.resources.ensure(
      { kind: 'do.database.pg', name: 'bc-r-race', spec: pg, labels },
      ctx('crs_race'),
    );
    expect(emu2.state.databases.size).toBe(1);
    expect(raced.id).toBe([...emu2.state.databases.keys()][0]);
  });

  it('resizes and upgrades in place; a downgrade, a region change or a shrink is replaceRequired', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const request = { kind: 'do.database.pg', name: 'bc-r-grow', spec: pg, labels };
    const state = await ready(resources, request);
    const resized = await resources.ensure(
      { ...request, id: state.id, spec: { ...pg, size: 'db-s-2vcpu-4gb', nodes: 2 } },
      ctx('crs_abc'),
    );
    expect(resized.state).toBe('updating');
    expect(mutations(emu, 'PUT', /\/resize$/)[0]!.body).toEqual({
      size: 'db-s-2vcpu-4gb',
      num_nodes: 2,
    });
    await ready(resources, {
      ...request,
      id: state.id,
      spec: { ...pg, size: 'db-s-2vcpu-4gb', nodes: 2 },
    });
    const upgraded = await resources.ensure(
      {
        ...request,
        id: state.id,
        spec: { ...pg, size: 'db-s-2vcpu-4gb', nodes: 2, version: '17' },
      },
      ctx('crs_abc'),
    );
    expect(upgraded.state).toBe('updating');
    expect(mutations(emu, 'PUT', /\/upgrade$/)[0]!.body).toEqual({ version: '17' });
    await ready(resources, {
      ...request,
      id: state.id,
      spec: { ...pg, size: 'db-s-2vcpu-4gb', nodes: 2, version: '17' },
    });
    for (const spec of [
      { ...pg, version: '15' },
      { ...pg, region: 'ams3' },
      { ...pg, storageMiB: 1 },
    ]) {
      const error = await failure(
        resources.ensure({ ...request, id: state.id, spec }, ctx('crs_abc')),
      );
      expect(error.code).toBe('INVALID_STATE');
      expect(error.details?.reason).toBe('replaceRequired');
    }
    // An engine without in-place upgrades refuses any version change.
    const valkey = await ready(
      resources,
      {
        kind: 'do.database.valkey',
        name: 'bc-r-cache',
        spec: { region: 'nyc3', version: '8', size: 'db-s-1vcpu-1gb', nodes: 1 },
        labels,
      },
      'crs_cache',
    );
    const error = await failure(
      resources.ensure(
        {
          kind: 'do.database.valkey',
          name: 'bc-r-cache',
          id: valkey.id,
          spec: { region: 'nyc3', version: '9', size: 'db-s-1vcpu-1gb', nodes: 1 },
        },
        ctx('crs_cache'),
      ),
    );
    expect(error.details?.reason).toBe('replaceRequired');
  });

  it('a cluster joins a VPC only on the tenant’s own account; the VPC cannot change in place', async () => {
    const vpc = '5a4981aa-9653-4bd1-bef5-d6bff52042e4';
    const emu = emulator();
    const { resources } = await build(emu);
    const request = { kind: 'do.database.pg', name: 'bc-r-private', spec: { ...pg, vpc }, labels };
    for (const accountScope of [undefined, 'shared'] as const) {
      const error = await failure(
        resources.ensure({ ...request, ...(accountScope ? { accountScope } : {}) }, ctx('crs_p')),
      );
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.details?.reason).toBe('accountWide');
    }
    expect(mutations(emu, 'POST', /^\/v2\/databases$/)).toEqual([]);
    const state = await ready(resources, { ...request, accountScope: 'tenant' }, 'crs_p');
    expect(mutations(emu, 'POST', /^\/v2\/databases$/)[0]!.body).toMatchObject({
      private_network_uuid: vpc,
    });
    expect(state.spec).toMatchObject({ vpc });
    const moved = await failure(
      resources.ensure(
        {
          ...request,
          id: state.id,
          accountScope: 'tenant',
          spec: { ...pg, vpc: 'f2b1a3c4-0000-4000-8000-000000000001' },
        },
        ctx('crs_p'),
      ),
    );
    expect(moved.details?.reason).toBe('replaceRequired');
    // A cluster without a VPC in its spec stays where DigitalOcean put it.
    const plain = await ready(
      resources,
      { kind: 'do.database.pg', name: 'bc-r-plain', spec: pg, labels },
      'crs_q',
    );
    expect(plain.state).toBe('ready');
  });

  it('the key-tag lookup ignores a cluster another deployment manages: it is never resized', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    // A staging control plane restored from prod's backup shares resource ids, so the key tag matches.
    const prod = seedDatabase(emu.state, {
      name: 'prod-orders',
      tags: [managedTag, deploymentTag('prod'), keyTag('crs_shared')],
    });
    const state = await resources.ensure(
      {
        kind: 'do.database.pg',
        name: 'bc-r-staging',
        spec: { ...pg, size: 'db-s-2vcpu-4gb' },
        labels,
      },
      ctx('crs_shared'),
    );
    expect(state.id).not.toBe(prod.id);
    expect(prod.size).toBe('db-s-1vcpu-1gb');
    expect(mutations(emu, 'PUT', /\/(resize|upgrade)$/)).toEqual([]);
    // The name taken too: the create is refused, and the lookup after it still never takes theirs.
    const emu2 = emulator();
    const other = await build(emu2);
    const theirs = seedDatabase(emu2.state, {
      name: 'bc-r-same',
      tags: [managedTag, deploymentTag('prod'), keyTag('crs_shared')],
    });
    const refused = await failure(
      other.resources.ensure(
        { kind: 'do.database.pg', name: 'bc-r-same', spec: { ...pg, nodes: 2 }, labels },
        ctx('crs_shared'),
      ),
    );
    expect(refused.code).toBe('CONFLICT');
    expect(theirs.num_nodes).toBe(1);
    expect(mutations(emu2, 'PUT', /\/(resize|upgrade)$/)).toEqual([]);
  });

  it('delete refuses an unmanaged or another deployment’s cluster, and sends no DELETE', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const byHand = seedDatabase(emu.state, {});
    const foreign = seedDatabase(emu.state, { tags: [managedTag, deploymentTag('another')] });
    for (const cluster of [byHand, foreign]) {
      const error = await failure(resources.delete('do.database.pg', cluster.id, ctx()));
      expect(error.code).toBe('INVALID_STATE');
      expect(error.details?.reason).toBe('notManaged');
    }
    expect(mutations(emu, 'DELETE', /^\/v2\/databases\//)).toEqual([]);
    const mine = seedDatabase(emu.state, { tags: ours });
    expect((await resources.delete('do.database.pg', mine.id, ctx())).state).toBe('deleting');
    expect((await resources.delete('do.database.pg', mine.id, ctx())).state).toBe('deleted');
    expect(mutations(emu, 'DELETE', /^\/v2\/databases\//)).toHaveLength(1);
  });
});

describe('what lives in a cluster', () => {
  async function cluster() {
    const emu = emulator();
    const built = await build(emu);
    const mine = seedDatabase(emu.state, { tags: ours });
    return { emu, resources: built.resources, mine };
  }

  it('users: created once with a sealed-to-be password; the admin user is never deleted', async () => {
    const { emu, resources, mine } = await cluster();
    const request = {
      kind: 'do.database.pg.user',
      name: 'bc-r-u',
      spec: { name: 'app' },
      parent: mine.id,
    };
    const created = await resources.ensure(request, ctx('crs_u'));
    expect(created).toMatchObject({
      id: `${mine.id}/app`,
      state: 'ready',
      outputs: { user: 'app', role: 'normal' },
    });
    expect(created.secretOutputs!.password).toBe(
      mine._users.find((u: any) => u.name === 'app').password,
    );
    expect((await resources.ensure({ ...request, id: created.id }, ctx('crs_u'))).id).toBe(
      created.id,
    );
    expect(mutations(emu, 'POST', /\/users$/)).toHaveLength(1);
    // The admin user goes with the cluster: deleting it sends nothing and answers deleted, so nothing waits on it.
    expect(
      (await resources.delete('do.database.pg.user', `${mine.id}/doadmin`, ctx())).state,
    ).toBe('deleted');
    expect(mutations(emu, 'DELETE', /\/users\//)).toEqual([]);
    expect(mine._users.some((u: any) => u.name === 'doadmin')).toBe(true);
    expect((await resources.delete('do.database.pg.user', created.id, ctx())).state).toBe(
      'deleted',
    );
    expect(await resources.get('do.database.pg.user', created.id, ctx())).toBeUndefined();
  });

  it('a user resource is never bound to the cluster’s primary (admin) user', async () => {
    const { emu, resources, mine } = await cluster();
    const error = await failure(
      resources.ensure(
        { kind: 'do.database.pg.user', name: 'bc-r-a', spec: { name: 'doadmin' }, parent: mine.id },
        ctx('crs_admin'),
      ),
    );
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details?.reason).toBe('primaryUser');
    expect(mutations(emu, 'POST', /\/users$/)).toEqual([]);
  });

  it('a child of a cluster this deployment does not manage is refused; one of a creating cluster waits', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const theirs = seedDatabase(emu.state, {});
    const error = await failure(
      resources.ensure(
        { kind: 'do.database.pg.user', name: 'x', spec: { name: 'app' }, parent: theirs.id },
        ctx(),
      ),
    );
    expect(error.details?.reason).toBe('notManaged');
    const deleting = await failure(
      resources.delete('do.database.pg.user', `${theirs.id}/doadmin`, ctx()),
    );
    expect(deleting.details?.reason).toBe('notManaged');
    const creating = seedDatabase(emu.state, { tags: ours, status: 'creating' });
    const waiting = await resources.ensure(
      {
        kind: 'do.database.pg.firewall',
        name: 'x',
        spec: { ipAddresses: [], tags: [], droplets: [] },
        parent: creating.id,
      },
      ctx(),
    );
    expect(waiting.state).toBe('pending');
    expect(mutations(emu, 'PUT', /\/firewall$/)).toEqual([]);
  });

  it('trusted sources replace the cluster firewall; deleting them restores none', async () => {
    const { emu, resources, mine } = await cluster();
    const spec = { ipAddresses: ['203.0.113.0/24'], tags: ['bc-pool-1'], droplets: ['42'] };
    const state = await resources.ensure(
      { kind: 'do.database.pg.firewall', name: 'fw', spec, parent: mine.id, accountScope: 'tenant' },
      ctx(),
    );
    expect(state).toMatchObject({ id: `${mine.id}/firewall`, state: 'ready' });
    expect(mutations(emu, 'PUT', /\/firewall$/)[0]!.body).toEqual({
      rules: [
        { type: 'ip_addr', value: '203.0.113.0/24' },
        { type: 'tag', value: 'bc-pool-1' },
        { type: 'droplet', value: '42' },
      ],
    });
    // The same rules again: nothing sent.
    await resources.ensure(
      { kind: 'do.database.pg.firewall', name: 'fw', spec, parent: mine.id, accountScope: 'tenant' },
      ctx(),
    );
    expect(mutations(emu, 'PUT', /\/firewall$/)).toHaveLength(1);
    expect((await resources.get('do.database.pg.firewall', state.id, ctx()))!.spec).toEqual({
      ...spec,
      instances: [],
    });
    expect((await resources.delete('do.database.pg.firewall', state.id, ctx())).state).toBe(
      'deleted',
    );
    expect(mine._firewall).toEqual([]);
  });

  it('trusted Droplet ids and tags are account-wide: refused on a shared account, nothing sent', async () => {
    const { emu, resources, mine } = await cluster();
    const kind = resources.kinds().find((entry) => entry.kind === 'do.database.pg.firewall')!;
    expect(kind.accountWide!({ ipAddresses: ['203.0.113.0/24'], tags: [], droplets: [] })).toEqual([]);
    expect(kind.accountWide!({ ipAddresses: [], tags: ['bc-pool-1'], droplets: ['42'] })).toEqual([
      'tags',
      'droplets',
    ]);
    for (const spec of [
      { ipAddresses: [], tags: ['bc-net-other'], droplets: [] },
      { ipAddresses: [], tags: [], droplets: ['424242'] },
    ])
      for (const accountScope of [undefined, 'shared'] as const) {
        const error = await failure(
          resources.ensure(
            {
              kind: 'do.database.pg.firewall',
              name: 'fw',
              spec,
              parent: mine.id,
              ...(accountScope ? { accountScope } : {}),
            },
            ctx(),
          ),
        );
        expect(error.code).toBe('INVALID_INPUT');
        expect(error.details?.reason).toBe('accountWide');
      }
    expect(mutations(emu, 'PUT', /\/firewall$/)).toEqual([]);
    // Addresses, and the tenant's instances (by their Droplets' instance tag), are fine on a shared account.
    const instance = 'inst_0123456789abcdefghjkmnpqrs';
    expect(kind.accountWide!({ ipAddresses: [], instances: [instance], tags: [], droplets: [] })).toEqual(
      [],
    );
    expect(kind.instances!({ instances: [instance] })).toEqual([instance]);
    const state = await resources.ensure(
      {
        kind: 'do.database.pg.firewall',
        name: 'fw',
        spec: { ipAddresses: ['198.51.100.7'], instances: [instance], tags: [], droplets: [] },
        parent: mine.id,
        accountScope: 'shared',
      },
      ctx(),
    );
    expect(state.state).toBe('ready');
    expect(mutations(emu, 'PUT', /\/firewall$/)[0]!.body).toEqual({
      rules: [
        { type: 'ip_addr', value: '198.51.100.7' },
        { type: 'tag', value: tagFor('better-compute-instance', instance) },
      ],
    });
    expect((await resources.get('do.database.pg.firewall', state.id, ctx()))!.spec).toEqual({
      ipAddresses: ['198.51.100.7'],
      instances: [instance],
      tags: [],
      droplets: [],
    });
  });

  it('pools: created, changed in place, with the password a secret output', async () => {
    const { emu, resources, mine } = await cluster();
    const request = {
      kind: 'do.database.pg.pool',
      name: 'p',
      spec: { name: 'web', mode: 'transaction', size: 10, database: 'defaultdb' },
      parent: mine.id,
    };
    const created = await resources.ensure(request, ctx());
    expect(created.secretOutputs!.uri).toContain(mine._admin.password);
    expect(created.outputs!.password).toBeUndefined();
    const changed = await resources.ensure(
      { ...request, id: created.id, spec: { ...request.spec, size: 20 } },
      ctx(),
    );
    expect(changed.state).toBe('updating');
    expect(mutations(emu, 'PUT', /\/pools\/web$/)[0]!.body).toMatchObject({
      size: 20,
      mode: 'transaction',
    });
  });

  it('replicas: forked, then online; a different region is replaceRequired', async () => {
    const { resources, mine } = await cluster();
    const request = {
      kind: 'do.database.pg.replica',
      name: 'r',
      spec: { name: 'read-1', region: 'ams3', size: 'db-s-1vcpu-1gb' },
      parent: mine.id,
      labels,
    };
    const first = await resources.ensure(request, ctx());
    expect(first.state).toBe('updating');
    const online = await ready(resources, request);
    expect(online.state).toBe('ready');
    expect(online.usage).toEqual({ 'do.database.pg.node.hours': 1 });
    const error = await failure(
      resources.ensure(
        { ...request, id: online.id, spec: { ...request.spec, region: 'sfo3' } },
        ctx(),
      ),
    );
    expect(error.details?.reason).toBe('replaceRequired');
  });
});

describe('discover, adopt and release', () => {
  it('discovers by engine with who manages each; adopt tags it; another deployment’s is refused', async () => {
    const emu = emulator();
    const { resources } = await build(emu);
    const byHand = seedDatabase(emu.state, { name: 'legacy' });
    const foreign = seedDatabase(emu.state, {
      name: 'theirs',
      tags: [managedTag, deploymentTag('another')],
    });
    seedDatabase(emu.state, { name: 'a-cache', engine: 'valkey' });
    const found = [];
    for await (const item of resources.discover('do.database.pg', ctx())) found.push(item);
    expect(found.map((item) => item.name).sort()).toEqual(['legacy', 'theirs']);
    expect(found.find((item) => item.name === 'theirs')!.managedBy).toBe('other');
    expect(found.find((item) => item.name === 'legacy')!.managedBy).toBeUndefined();
    // get says who manages a cluster, so an adopt's pre-check needs no listing.
    expect((await resources.get('do.database.pg', byHand.id, ctx()))!.managedBy).toBe('none');
    expect((await resources.get('do.database.pg', foreign.id, ctx()))!.managedBy).toBe('other');
    expect(await resources.get('do.database.mysql', byHand.id, ctx())).toBeUndefined();
    const refused = await failure(
      resources.adopt('do.database.pg', foreign.id, labels, ctx('crs_x')),
    );
    expect(refused.details?.reason).toBe('managedByAnother');
    const adopted = await resources.adopt('do.database.pg', byHand.id, labels, ctx('crs_adopt'));
    expect(adopted.spec).toMatchObject({
      region: 'nyc3',
      version: '16',
      size: 'db-s-1vcpu-1gb',
      nodes: 1,
    });
    expect(byHand.tags).toEqual(
      expect.arrayContaining([...ours, tagFor('better-compute-resource', 'crs_abc')]),
    );
    // Now ours: it can be deleted, or released, which takes every better-compute tag off and leaves it running.
    await resources.release('do.database.pg', byHand.id, ctx());
    expect(byHand.tags).toEqual([]);
    expect(emu.state.databases.has(byHand.id)).toBe(true);
    const after = await failure(resources.delete('do.database.pg', byHand.id, ctx()));
    expect(after.details?.reason).toBe('notManaged');
  });
});
