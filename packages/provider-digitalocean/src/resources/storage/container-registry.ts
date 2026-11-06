import { field, manifest, type CallContext } from '@better-compute/core';
import type { DoClient } from '../../client/http.js';
import { docrHost } from '../../registry/credentials.js';
import {
  checkManagedName,
  hasCode,
  managedResourceName,
  notManaged,
  storageError,
  type DoResourceKind,
  type DoResourceState,
} from './kind.js';

// DigitalOcean Container Registry as resources:
// - `do.container-registry`: a registry (`/v2/registries`, the multi-registry API). Registries
//   take no tags, so ownership is the managed name (`bc-…`, DO-D4). `delete` refuses a registry
//   without one, and one that still holds repositories: images are never deleted to delete a
//   registry.
// - `do.registry-garbage-collection`: "this registry was garbage-collected within the last
//   `intervalHours`". `ensure` adopts the newest collection inside the window (running or done)
//   and starts one only when there is none, so a reconciler calling it again never starts a
//   second; `delete` cancels a running collection.

const regionPattern = /^[a-z]{3}[0-9]$/;

export const containerRegistrySpec = manifest({
  region: field
    .string({ pattern: regionPattern })
    .describe('The region the registry stores its images in (nyc3, sfo3, ams3, sgp1, fra1, …)'),
});

export interface ContainerRegistrySpec {
  region: string;
}

interface DoRegistry {
  name: string;
  region?: string;
  storage_usage_bytes?: number;
  created_at?: string;
}

interface DoRepository {
  registry_name?: string;
  name: string;
  tag_count?: number;
  manifest_count?: number;
}

export interface ContainerRegistryKind extends DoResourceKind<ContainerRegistrySpec> {
  /** The repositories of a registry (read-only; they are created by pushes). */
  repositories(name: string, context: CallContext): AsyncIterable<{ name: string; tags: number }>;
}

function registryState(registry: DoRegistry): DoResourceState {
  return {
    id: registry.name,
    state: 'ready',
    outputs: {
      name: registry.name,
      region: registry.region ?? '',
      endpoint: `${docrHost}/${registry.name}`,
      storageUsageBytes: String(registry.storage_usage_bytes ?? 0),
    },
  };
}

async function readRegistry(
  client: DoClient,
  name: string,
  signal: AbortSignal,
): Promise<DoRegistry | undefined> {
  if (!/^[a-z0-9-]{1,63}$/.test(name))
    throw storageError('INVALID_INPUT', 'Not a registry name', 'registryName');
  try {
    return (
      await client.request<{ registry: DoRegistry }>('GET', `/registries/${name}`, {
        signal,
        budget: 'observe',
      })
    ).registry;
  } catch (error) {
    if (hasCode(error, 'NOT_FOUND')) return undefined;
    throw error;
  }
}

function refuseUnmanaged(name: string): void {
  if (!managedResourceName.test(name))
    throw notManaged(`Registry ${name} is not one better-compute manages; it was left alone`);
}

export function containerRegistryKind(client: DoClient): ContainerRegistryKind {
  async function* repositories(name: string, signal: AbortSignal): AsyncIterable<DoRepository> {
    yield* client.pages<DoRepository>(`/registry/${name}/repositoriesV2`, 'repositories', {
      signal,
      budget: 'sweep',
    });
  }

  return {
    kind: 'do.container-registry',
    family: 'storage',
    description:
      'A DigitalOcean Container Registry (registry.digitalocean.com/<name>) in one region, owned by its bc- name',
    spec: containerRegistrySpec as unknown as DoResourceKind<ContainerRegistrySpec>['spec'],
    outputs: ['name', 'region', 'endpoint', 'storageUsageBytes'],
    regional: true,
    updatable: [],

    async ensure(request, ctx) {
      // A registry's id is its name.
      const name = request.id ?? request.name;
      const { spec } = request;
      checkManagedName(name, 'A registry');
      const existing = await readRegistry(client, name, ctx.signal);
      if (existing) {
        if (existing.region && existing.region !== spec.region)
          throw storageError(
            'INVALID_STATE',
            `Registry ${name} is in ${existing.region}; a registry cannot move regions`,
            'replaceRequired',
          );
        return registryState(existing);
      }
      const created = await client.request<{ registry: DoRegistry }>('POST', '/registries', {
        body: { name, region: spec.region },
        signal: ctx.signal,
        budget: 'mutate',
      });
      ctx.log.info('digitalocean.registry.created', { name, region: spec.region });
      return registryState(created.registry);
    },

    async get(id, ctx) {
      const registry = await readRegistry(client, id, ctx.signal);
      return registry
        ? { ...registryState(registry), ...(registry.region ? { spec: { region: registry.region } } : {}) }
        : undefined;
    },

    async delete(id, ctx) {
      const registry = await readRegistry(client, id, ctx.signal);
      if (!registry) return { id, state: 'deleted' };
      refuseUnmanaged(registry.name);
      const first = await repositories(id, ctx.signal)[Symbol.asyncIterator]().next();
      if (!first.done)
        throw storageError(
          'INVALID_STATE',
          `Registry ${id} still holds repositories; delete them before deleting it`,
          'registryNotEmpty',
        );
      try {
        await client.request('DELETE', `/registries/${id}`, {
          signal: ctx.signal,
          budget: 'mutate',
        });
      } catch (error) {
        if (!hasCode(error, 'NOT_FOUND')) throw error;
      }
      return { id, state: 'deleted' };
    },

    async *discover(ctx) {
      for await (const registry of client.pages<DoRegistry>('/registries', 'registries', {
        signal: ctx.signal,
        budget: 'sweep',
      }))
        yield {
          id: registry.name,
          name: registry.name,
          ...(registry.region ? { region: registry.region, spec: { region: registry.region } } : {}),
          // Registries carry no tags: a managed name is all there is.
          ...(managedResourceName.test(registry.name) ? { managedBy: 'this' as const } : {}),
          outputs: registryState(registry).outputs!,
        };
    },

    async *repositories(name, ctx) {
      if (!(await readRegistry(client, name, ctx.signal)))
        throw storageError('NOT_FOUND', `Registry ${name} not found`, 'registry');
      for await (const repository of repositories(name, ctx.signal))
        yield { name: repository.name, tags: repository.tag_count ?? 0 };
    },
  };
}

// --- Garbage collection -------------------------------------------------------------------------

const gcTypes = {
  'untagged-manifests': 'untagged manifests only',
  'unreferenced-blobs': 'unreferenced blobs only',
  all: 'untagged manifests and unreferenced blobs',
} as const;

export const registryGcSpec = manifest({
  registry: field
    .string({ pattern: managedResourceName })
    .describe('The registry to collect: one better-compute manages (bc-…)'),
  type: field
    .option(['untagged-manifests', 'unreferenced-blobs', 'all'])
    .default('all')
    .describe('What to remove: untagged manifests, unreferenced blobs, or both'),
  intervalHours: field
    .int({ min: 1, max: 24 * 90 })
    .default(24)
    .describe('A collection newer than this counts as done; an older one starts a new collection'),
});

export interface RegistryGcSpec {
  registry: string;
  type: keyof typeof gcTypes;
  intervalHours: number;
}

interface DoGarbageCollection {
  uuid: string;
  registry_name: string;
  status: string;
  type?: string;
  created_at?: string;
  blobs_deleted?: number;
  freed_bytes?: number;
}

const finished = new Set(['succeeded', 'failed', 'cancelled']);

function gcState(gc: DoGarbageCollection): DoResourceState {
  const outputs = {
    registry: gc.registry_name,
    uuid: gc.uuid,
    status: gc.status,
    blobsDeleted: String(gc.blobs_deleted ?? 0),
    freedBytes: String(gc.freed_bytes ?? 0),
  };
  const id = `${gc.registry_name}/${gc.uuid}`;
  if (gc.status === 'succeeded') return { id, state: 'ready', outputs };
  if (gc.status === 'failed' || gc.status === 'cancelled')
    return { id, state: 'error', outputs, message: `garbage collection ${gc.status}` };
  return { id, state: 'pending', outputs };
}

function parseGcId(id: string): { registry: string; uuid: string } {
  const match = /^([a-z0-9-]{1,63})\/([0-9a-f-]{36})$/.exec(id);
  if (!match)
    throw storageError('INVALID_INPUT', 'Not a garbage collection id (<registry>/<uuid>)', 'gcId');
  return { registry: match[1]!, uuid: match[2]! };
}

export function registryGcKind(client: DoClient): DoResourceKind<RegistryGcSpec> {
  async function find(
    registry: string,
    signal: AbortSignal,
    pick: (gc: DoGarbageCollection) => boolean,
  ): Promise<DoGarbageCollection | undefined> {
    try {
      for await (const gc of client.pages<DoGarbageCollection>(
        `/registry/${registry}/garbage-collections`,
        'garbage_collections',
        { signal, budget: 'observe' },
      ))
        if (pick(gc)) return gc;
    } catch (error) {
      if (hasCode(error, 'NOT_FOUND')) return undefined;
      throw error;
    }
    return undefined;
  }

  return {
    kind: 'do.registry-garbage-collection',
    family: 'storage',
    description:
      'Garbage collection of a registry: collected within the last intervalHours, started when it was not',
    spec: registryGcSpec as unknown as DoResourceKind<RegistryGcSpec>['spec'],
    outputs: ['registry', 'uuid', 'status', 'blobsDeleted', 'freedBytes'],
    regional: false,
    updatable: ['type', 'intervalHours'],
    parent: 'do.container-registry',

    async ensure({ spec, parent }, ctx) {
      if (parent !== undefined && parent !== spec.registry)
        throw storageError(
          'INVALID_INPUT',
          `The collection names registry ${spec.registry} but lives in ${parent}`,
          'parent',
        );
      if (!(await readRegistry(client, spec.registry, ctx.signal)))
        throw storageError('NOT_FOUND', `Registry ${spec.registry} not found`, 'registry');
      const since = ctx.clock.now() - spec.intervalHours * 3_600_000;
      // Newest first: the newest collection inside the window, or one still running.
      const recent = await find(
        spec.registry,
        ctx.signal,
        (gc) => !finished.has(gc.status) || Date.parse(gc.created_at ?? '') >= since,
      );
      if (recent) return gcState(recent);
      try {
        const started = await client.request<{ garbage_collection: DoGarbageCollection }>(
          'POST',
          `/registry/${spec.registry}/garbage-collection`,
          { body: { type: gcTypes[spec.type] }, signal: ctx.signal, budget: 'mutate' },
        );
        ctx.log.info('digitalocean.registry.gc-started', { registry: spec.registry });
        return gcState(started.garbage_collection);
      } catch (error) {
        // One started meanwhile (a racing pass, or by hand): adopt it.
        if (!hasCode(error, 'CONFLICT')) throw error;
        const running = await find(spec.registry, ctx.signal, (gc) => !finished.has(gc.status));
        if (!running) throw error;
        return gcState(running);
      }
    },

    async get(id, ctx) {
      const { registry, uuid } = parseGcId(id);
      const gc = await find(registry, ctx.signal, (entry) => entry.uuid === uuid);
      return gc ? gcState(gc) : undefined;
    },

    async delete(id, ctx) {
      const { registry, uuid } = parseGcId(id);
      // A collection is this deployment's only on a registry it manages (a bc- name).
      refuseUnmanaged(registry);
      const gc = await find(registry, ctx.signal, (entry) => entry.uuid === uuid);
      if (!gc || finished.has(gc.status)) return { id, state: 'deleted' };
      await client.request('PUT', `/registry/${registry}/garbage-collection/${uuid}`, {
        body: { cancel: true },
        signal: ctx.signal,
        budget: 'mutate',
      });
      return { id, state: 'deleting' };
    },
  };
}
