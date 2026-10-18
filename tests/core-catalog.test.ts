import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  apiMethod,
  apiSurface,
  computeActions,
  computeResourceKinds,
  computeResourceTypes,
  fleetResourceId,
  isComputeError,
  resourceType,
  resourceTypeLimits,
  type ComputeAction,
} from '@better-compute/core';

const types = computeResourceTypes();
const a = (area: string, ...verbs: string[]) => verbs.map((verb) => `compute:${area}:${verb}`);

// Transcribed from PLAN.md §12.3.
const planActions: Record<string, string[]> = {
  'compute-fleet': [
    ...a('fleet', 'admin'),
    ...a('sites', 'manage'),
    ...a('pools', 'create'),
    ...a('quotas', 'manage'),
    ...a('secrets', 'manage'),
    ...a('images', 'publish'),
    ...a('providers', 'manage'),
    ...a('drivers', 'read'),
    ...a('billing', 'read', 'manage'),
  ],
  'compute-tenant': [
    ...a('sites', 'read', 'manage'),
    ...a('pools', 'read', 'create'),
    ...a('capacity', 'read'),
    ...a('nodes', 'read'),
    ...a('reservations', 'read'),
    ...a('instances', 'read'),
    ...a('projects', 'read', 'manage'),
    ...a('quotas', 'read'),
    ...a('usage', 'read'),
    ...a('events', 'read'),
    ...a('webhooks', 'manage'),
    ...a('drivers', 'read'),
    ...a('secrets', 'manage'),
    ...a('profiles', 'read', 'manage'),
    ...a('images', 'read', 'publish'),
    ...a('providers', 'read', 'manage'),
    ...a('sandboxes', 'read', 'manage'),
    ...a('networks', 'read'),
    ...a('batches', 'read', 'create', 'approve'),
  ],
  'compute-project': [...a('projects', 'read', 'manage'), ...a('usage', 'read')],
  'compute-site': a('sites', 'read', 'manage'),
  'compute-pool': [
    ...a('pools', 'read', 'manage', 'share'),
    ...a('capacity', 'read'),
    ...a('join-tokens', 'create', 'read', 'revoke'),
    ...a('flavors', 'read', 'manage'),
    ...a('nodes', 'provision'),
  ],
  'compute-node': [
    ...a(
      'nodes',
      'read',
      'update',
      'cordon',
      'drain',
      'provision',
      'power',
      'exec',
      'console',
      'ssh-root',
      'delete',
      'revoke-identity',
    ),
    ...a('workflows', 'read', 'manage'),
  ],
  'compute-reservation': a('reservations', 'create', 'read', 'extend', 'release'),
  'compute-instance': a('instances', 'create', 'read', 'update', 'exec', 'delete', 'attach'),
  'compute-image': a('images', 'read', 'publish'),
  'compute-profile': a('profiles', 'read', 'manage'),
  'compute-provider-account': a('providers', 'read', 'manage'),
  'compute-sandbox': a('sandboxes', 'create', 'read', 'update', 'exec', 'delete'),
  'compute-sandbox-template': a('sandboxes', 'read', 'manage'),
  'compute-sandbox-snapshot': a('sandboxes', 'read', 'delete'),
  'compute-sandbox-volume': a('sandboxes', 'read', 'manage'),
  'compute-network': a('networks', 'create', 'read', 'update', 'delete'),
};

describe('resource types (§12.3)', () => {
  it('match the plan: names, actions, parents, relations and attributes', () => {
    expect(Object.keys(types).sort()).toEqual(Object.keys(planActions).sort());
    for (const [type, actions] of Object.entries(planActions))
      expect(types[type]?.actions).toEqual(actions);
    const parents = Object.fromEntries(
      Object.entries(types)
        .filter(([, definition]) => definition.parent)
        .map(([type, definition]) => [type, definition.parent]),
    );
    expect(parents).toEqual({
      'compute-node': 'compute-pool',
      'compute-reservation': 'compute-pool',
      'compute-instance': 'compute-pool',
      'compute-sandbox': 'compute-pool',
      'compute-sandbox-volume': 'compute-pool',
      'compute-network': 'compute-tenant',
    });
    expect(types['compute-project']?.relations).toEqual(['member', 'admin']);
    expect(types['compute-pool']?.relations).toEqual(['viewer', 'user', 'operator', 'admin']);
    expect(types['compute-node']?.relations).toEqual(['operator']);
    expect(types['compute-site']?.attributes).toEqual({
      region: 'string',
      iamRegion: 'string',
      kind: 'string',
    });
    expect(types['compute-pool']?.attributes).toEqual({
      region: 'string',
      class: 'string',
      gpuModel: 'string',
      gpuMemoryGb: 'number',
      sharing: 'string',
    });
    expect(types['compute-node']?.attributes).toEqual({
      region: 'string',
      gpuModel: 'string',
      gpuCount: 'number',
      lifecycle: 'string',
      trust: 'string',
      dedicatedTo: 'string',
    });
    expect(types['compute-reservation']?.attributes).toEqual({
      region: 'string',
      gpuModel: 'string',
      gpuCount: 'number',
      durationHours: 'number',
      binding: 'string',
      projectId: 'string',
      spot: 'boolean',
    });
    expect(types['compute-instance']?.attributes).toEqual({
      vcpu: 'number',
      memoryGiB: 'number',
      gpus: 'number',
      imageId: 'string',
      imageVerified: 'boolean',
      projectId: 'string',
    });
    expect(types['compute-sandbox']?.attributes).toEqual({
      templateId: 'string',
      vcpu: 'number',
      memoryGiB: 'number',
      gpus: 'number',
      ttlSeconds: 'number',
      fromSnapshot: 'string',
      warm: 'boolean',
    });
    expect(types['compute-image']?.attributes).toEqual({
      visibility: 'string',
      verified: 'boolean',
    });
  });

  it('stay within better-iam limits', () => {
    for (const [type, definition] of Object.entries(types)) {
      expect(type.length).toBeLessThanOrEqual(resourceTypeLimits.typeLength);
      const attributes = Object.entries(definition.attributes ?? {});
      expect(attributes.length).toBeLessThanOrEqual(64);
      for (const [name, kind] of attributes) {
        expect(['string', 'number', 'boolean']).toContain(kind);
        expect(name).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/);
        expect(name).not.toBe('tenantId');
      }
      const relations = definition.relations ?? [];
      expect(relations.length).toBeLessThanOrEqual(32);
      expect(new Set(relations).size).toBe(relations.length);
      for (const relation of relations) expect(relation).toMatch(/^[a-z][a-z0-9_-]{0,63}$/);
      for (const action of definition.actions ?? []) expect(action).not.toMatch(/[*?\s]/);
      if (definition.parent) expect(Object.keys(types)).toContain(definition.parent);
    }
  });

  it('honours the prefix option and rejects bad prefixes', () => {
    const prefixed = computeResourceTypes('acme-');
    expect(Object.keys(prefixed).sort()).toEqual(
      computeResourceKinds.map((kind) => `acme-${kind}`).sort(),
    );
    expect(prefixed['acme-node']?.parent).toBe('acme-pool');
    expect(prefixed['acme-pool']?.actions).toEqual(types['compute-pool']?.actions);
    expect(resourceType('pool')).toBe('compute-pool');
    expect(resourceType('provider-account', 'acme-')).toBe('acme-provider-account');
    for (const prefix of ['', 'Compute-', 'compute:', 'a'.repeat(40)]) {
      let error: unknown;
      try {
        computeResourceTypes(prefix);
      } catch (caught) {
        error = caught;
      }
      expect(isComputeError(error, 'INVALID_CONFIG')).toBe(true);
    }
  });

  it('returns a fresh copy each call', () => {
    const copy = computeResourceTypes();
    copy['compute-pool']!.actions!.push('compute:pools:steal');
    expect(computeResourceTypes()['compute-pool']?.actions).not.toContain('compute:pools:steal');
  });
});

describe('computeActions', () => {
  it('lists every catalog action once, in compute:<area>:<verb> form', () => {
    const all = Object.values(types).flatMap((definition) => definition.actions ?? []);
    expect(new Set(computeActions)).toEqual(new Set(all));
    expect(new Set(computeActions).size).toBe(computeActions.length);
    for (const action of computeActions)
      expect(action).toMatch(/^compute:[a-z][a-z-]*:[a-z][a-z-]*$/);
    expectTypeOf<'compute:reservations:create'>().toExtend<ComputeAction>();
  });
});

describe('apiSurface (§9.2)', () => {
  const pairs = apiSurface.flatMap((row) =>
    row.action === null
      ? []
      : [
          { row, action: row.action, resource: row.resource! },
          ...(row.alternatives ?? []).map((alt) => ({ row, ...alt })),
        ],
  );

  it('uses only catalogued actions, each on a type that declares it', () => {
    for (const { row, action, resource } of pairs) {
      expect(computeActions, `${row.group}.${row.method}`).toContain(action);
      expect(
        types[resourceType(resource)]?.actions,
        `${row.group}.${row.method} @ ${resource}`,
      ).toContain(action);
    }
  });

  it('decides every catalogued action somewhere', () => {
    const used = new Set(pairs.map((pair) => pair.action));
    expect(computeActions.filter((action) => !used.has(action))).toEqual([]);
  });

  it('has one row per method, with public rows undecided', () => {
    const keys = apiSurface.map((row) => `${row.group}.${row.method}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const row of apiSurface) {
      if (row.kind === 'public') {
        expect(row.action).toBeNull();
        expect(row.resource).toBeNull();
      } else {
        expect(row.action).not.toBeNull();
        expect(computeResourceKinds).toContain(row.resource);
      }
      expect(row.group).toMatch(/^[a-z][A-Za-z]*$/);
      expect(row.method).toMatch(/^[a-z][A-Za-z]*$/);
    }
    expect(
      apiSurface.filter((row) => row.kind === 'public').map((row) => `${row.group}.${row.method}`),
    ).toEqual(['system.whoami', 'system.version']);
  });

  it('marks exactly the bold rows as v0.1', () => {
    const v01 = apiSurface
      .filter((row) => row.phase === 'v0.1')
      .map((row) => `${row.group}.${row.method}`);
    expect(v01.sort()).toEqual(
      [
        'system.whoami',
        'system.version',
        'system.selfCheck',
        'projects.create',
        'projects.get',
        'projects.list',
        'sites.list',
        'sites.get',
        'sites.create',
        'pools.list',
        'pools.get',
        'pools.create',
        'pools.capacity',
        'pools.offer',
        'pools.unoffer',
        'joinTokens.create',
        'joinTokens.list',
        'joinTokens.revoke',
        'nodes.list',
        'nodes.get',
        'nodes.events',
        'nodes.cordon',
        'nodes.uncordon',
        'nodes.drain',
        'nodes.label',
        'nodes.taint',
        'nodes.adopt',
        'nodes.revokeIdentity',
        'inventory.get',
        'capacity.summary',
        'reservations.create',
        'reservations.get',
        'reservations.list',
        'reservations.release',
        'reservations.extend',
        'reservations.renew',
        'quotas.get',
        'commands.run',
        'commands.get',
        'commands.list',
        'usage.list',
        'events.list',
      ].sort(),
    );
  });

  it('pins the v0.1 authorization of each bold row', () => {
    const decided = Object.fromEntries(
      apiSurface
        .filter((row) => row.phase === 'v0.1' && row.action)
        .map((row) => [
          `${row.group}.${row.method}`,
          `${row.action!.slice('compute:'.length)} @ ${row.resource}`,
        ]),
    );
    expect(decided).toEqual({
      'system.selfCheck': 'fleet:admin @ fleet',
      'projects.create': 'projects:manage @ tenant',
      'projects.get': 'projects:read @ project',
      'projects.list': 'projects:read @ tenant',
      'sites.list': 'sites:read @ tenant',
      'sites.get': 'sites:read @ site',
      'sites.create': 'sites:manage @ fleet',
      'pools.list': 'pools:read @ tenant',
      'pools.get': 'pools:read @ pool',
      'pools.create': 'pools:create @ fleet',
      'pools.capacity': 'capacity:read @ pool',
      'pools.offer': 'pools:share @ pool',
      'pools.unoffer': 'pools:share @ pool',
      'joinTokens.create': 'join-tokens:create @ pool',
      'joinTokens.list': 'join-tokens:read @ pool',
      'joinTokens.revoke': 'join-tokens:revoke @ pool',
      'nodes.list': 'nodes:read @ tenant',
      'nodes.get': 'nodes:read @ node',
      'nodes.events': 'nodes:read @ node',
      'nodes.cordon': 'nodes:cordon @ node',
      'nodes.uncordon': 'nodes:cordon @ node',
      'nodes.drain': 'nodes:drain @ node',
      'nodes.label': 'nodes:update @ node',
      'nodes.taint': 'nodes:update @ node',
      'nodes.adopt': 'nodes:provision @ node',
      'nodes.revokeIdentity': 'nodes:revoke-identity @ node',
      'inventory.get': 'nodes:read @ node',
      'capacity.summary': 'capacity:read @ tenant',
      'reservations.create': 'reservations:create @ reservation',
      'reservations.get': 'reservations:read @ reservation',
      'reservations.list': 'reservations:read @ tenant',
      'reservations.release': 'reservations:release @ reservation',
      'reservations.extend': 'reservations:extend @ reservation',
      'reservations.renew': 'reservations:extend @ reservation',
      'quotas.get': 'quotas:read @ tenant',
      'commands.run': 'nodes:exec @ node',
      'commands.get': 'nodes:read @ node',
      'commands.list': 'nodes:read @ node',
      'usage.list': 'usage:read @ tenant',
      'events.list': 'events:read @ tenant',
    });
    expect(apiMethod('sites', 'create')?.alternatives).toEqual([
      { action: 'compute:sites:manage', resource: 'tenant' },
    ]);
    expect(apiMethod('pools', 'create')?.alternatives).toEqual([
      { action: 'compute:pools:create', resource: 'tenant' },
    ]);
    expect(apiMethod('usage', 'list')?.alternatives).toEqual([
      { action: 'compute:usage:read', resource: 'project' },
    ]);
    expect(apiMethod('tunnels', 'open')?.alternatives).toEqual([
      { action: 'compute:nodes:console', resource: 'node' },
    ]);
  });

  it('marks the list-recipe rows', () => {
    expect(apiSurface.filter((row) => row.list).map((row) => `${row.group}.${row.method}`)).toEqual(
      [
        'projects.list',
        'sites.list',
        'pools.list',
        'nodes.list',
        'reservations.list',
        'profiles.list',
        'images.list',
        'instances.list',
        'providerAccounts.list',
        'sandboxes.list',
        'sandboxTemplates.list',
        'sandboxSnapshots.list',
        'networks.list',
      ],
    );
    // The list recipe checks every item as the group's kind, one by one: only lists of
    // tenant-level kinds follow it. A list read on one resource (an account's reservations, a
    // network's rules) is an ordinary read decided on that resource.
    for (const row of apiSurface.filter((entry) => entry.list))
      expect(row.resource, `${row.group}.${row.method}`).toBe('tenant');
  });

  it('assigns each group to the module and phase the plan names', () => {
    const modules: Record<string, string> = {};
    // Methods another module contributes to a group: break-glass SSH certificates, and sandbox exec
    // (tickets and the sandbox SSH CA live in tunnels).
    const contributed: Record<string, string> = {
      'nodes.issueSshCert': 'tunnels',
      'nodes.revokeSshCert': 'tunnels',
      'sandboxes.exec': 'tunnels',
    };
    for (const row of apiSurface) {
      const path = `${row.group}.${row.method}`;
      if (contributed[path]) {
        expect(row.module, path).toBe(contributed[path]);
        continue;
      }
      modules[row.group] ??= row.module;
      expect(row.module, row.group).toBe(modules[row.group]);
    }
    expect(modules).toMatchObject({
      system: 'server',
      pools: 'capacity',
      inventory: 'inventory',
      capacity: 'capacity',
      reservations: 'capacity',
      quotas: 'capacity',
      metal: 'metal',
      profiles: 'provision',
      images: 'provision',
      workflows: 'provision',
      instances: 'vps',
      flavors: 'vps',
      providerAccounts: 'vps',
      tunnels: 'tunnels',
      // Injected modules outside the plan's original table: `@better-compute/fleet`, `@better-compute/events`.
      fleet: 'fleet',
      webhooks: 'events',
    });
    // Methods added to a group in a later phase than the group's own.
    const later: Record<string, string> = {
      'metal.bulk': 'v1.0',
      'metal.discovered': 'v1.0',
      'metal.confirmMac': 'v1.0',
      'providerAccounts.reservations': 'v1.0',
      'providerAccounts.bindReservation': 'v1.0',
      'providerAccounts.unbindReservation': 'v1.0',
      'providerAccounts.machines': 'v1.0',
      'providerAccounts.discover': 'v1.0',
      'instances.attach': 'v1.0',
      'instances.detach': 'v1.0',
      'instances.reboot': 'v1.0',
    };
    for (const [path, phase] of Object.entries(later))
      expect(apiMethod(...(path.split('.') as [string, string]))?.phase, path).toBe(phase);
    const phaseOf = (group: string) =>
      new Set(
        apiSurface
          .filter((row) => row.group === group && !later[`${row.group}.${row.method}`])
          .map((row) => row.phase),
      );
    for (const group of [
      'siteTokens',
      'joinRequests',
      'secrets',
      'metal',
      'profiles',
      'images',
      'workflows',
      'fleet',
    ])
      expect(phaseOf(group)).toEqual(new Set(['v0.2']));
    for (const group of ['instances', 'flavors', 'providerAccounts', 'tunnels', 'webhooks'])
      expect(phaseOf(group)).toEqual(new Set(['v0.3']));
    expect(apiMethod('nodes', 'issueSshCert')?.phase).toBe('v0.3');
    expect(apiMethod('nodes', 'nope')).toBeUndefined();
    expect(fleetResourceId).toBe('global');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(apiSurface)).toBe(true);
    expect(Object.isFrozen(apiSurface[0])).toBe(true);
  });
});
