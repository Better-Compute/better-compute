import {
  ComputeError,
  isComputeError,
  type CallContext,
  type ProviderDiscoveredResource,
  type ProviderResourceState,
} from '@better-compute/core';
import { found, replaceRequired, strings, type DoKind, type DoKindEnv } from '../kind.js';
import { canonical, isObject, objectManifest, type Issue } from '../spec.js';

// Marketplace Add-Ons (`do.addon`): a SaaS add-on resource (`/v2/add-ons/saas`) of a catalog app on a plan. An
// add-on has no tags; its name is the only thing better-compute can write, so ownership is the name suffix
// `-bc<deployment hash>` (as for a Functions namespace). Adopting renames it to carry the suffix, releasing takes
// the suffix off. Only the plan changes in place (`PATCH …/plan`); the app and its provisioning metadata are fixed.
// The add-on's SSO link is never an output (it signs the holder in to the vendor). Shapes follow the API
// reference (add-ons), not a recording: the live suite captures real bodies before release.

export const addonKindName = 'do.addon';

const slug = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ownSuffix = /-bc([0-9a-f]{12})$/;
const metadataName = /^[A-Za-z0-9_.-]{1,64}$/;

export interface AddonSpec {
  app: string;
  plan: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface DoAddon {
  uuid: string;
  name: string;
  app_slug: string;
  plan_slug: string;
  state?: string;
  metadata?: { name: string; value: unknown }[] | null;
  sso_url?: string;
  created_at?: string;
}

function checkAddon(value: unknown, issues: Issue[]): AddonSpec {
  if (!isObject(value)) {
    issues.push({ message: 'an add-on spec is an object', path: [] });
    return value as unknown as AddonSpec;
  }
  for (const key of Object.keys(value))
    if (!['app', 'plan', 'metadata'].includes(key))
      issues.push({ message: `${key} is not an add-on field`, path: [key] });
  if (typeof value.app !== 'string' || !slug.test(value.app))
    issues.push({ message: 'app is a Marketplace add-on slug', path: ['app'] });
  if (typeof value.plan !== 'string' || !slug.test(value.plan))
    issues.push({ message: 'plan is a plan slug of the add-on', path: ['plan'] });
  if (value.metadata !== undefined) {
    if (!isObject(value.metadata) || Object.keys(value.metadata).length > 32)
      issues.push({ message: 'metadata is an object of at most 32 entries', path: ['metadata'] });
    else
      for (const [name, entry] of Object.entries(value.metadata))
        if (
          !metadataName.test(name) ||
          !['string', 'number', 'boolean'].includes(typeof entry) ||
          String(entry).length > 1024
        )
          issues.push({ message: 'a metadata entry is a short scalar', path: ['metadata', name] });
  }
  return value as unknown as AddonSpec;
}

export const addonSpecManifest = objectManifest<AddonSpec>(
  {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['app', 'plan'],
    properties: {
      app: { type: 'string', pattern: slug.source, description: 'The add-on’s catalog slug' },
      plan: { type: 'string', pattern: slug.source, description: 'A plan slug of the add-on' },
      metadata: {
        type: 'object',
        maxProperties: 32,
        additionalProperties: { type: ['string', 'number', 'boolean'] },
        description: 'Provisioning parameters the add-on asks for (its metadata)',
      },
    },
  },
  checkAddon,
);

const deploymentHash = (env: DoKindEnv) =>
  env.deploymentTag.slice(env.deploymentTag.indexOf(':') + 1);
const suffix = (env: DoKindEnv) => `-bc${deploymentHash(env)}`;

function owner(env: DoKindEnv, name: string | undefined): 'this' | 'other' | undefined {
  const match = ownSuffix.exec(name ?? '');
  if (!match) return undefined;
  return match[1] === deploymentHash(env) ? 'this' : 'other';
}

function assertOwnedAddon(env: DoKindEnv, addon: DoAddon): void {
  if (owner(env, addon.name) !== 'this')
    throw new ComputeError(
      'INVALID_STATE',
      `Add-on ${addon.uuid} is not managed by this better-compute deployment; it is left alone`,
      undefined,
      { provider: 'digitalocean', reason: 'notManaged' },
    );
}

const metadataOf = (addon: DoAddon): Record<string, string | number | boolean> =>
  Object.fromEntries(
    (addon.metadata ?? [])
      .filter((entry) => ['string', 'number', 'boolean'].includes(typeof entry.value))
      .map((entry) => [entry.name, entry.value as string | number | boolean]),
  );

function status(value: string | undefined): ProviderResourceState['state'] {
  switch ((value ?? '').toLowerCase()) {
    case 'provisioned':
    case 'active':
      return 'ready';
    case 'deprovisioning':
      return 'deleting';
    case 'deprovisioned':
      return 'deleted';
    case 'failed':
    case 'suspended':
      return 'error';
    default:
      return 'pending';
  }
}

/** One per add-on per hour while it exists. */
export const addonHoursMeter = 'do.addon.hours';

function addonState(addon: DoAddon): ProviderResourceState {
  const state = status(addon.state);
  const metadata = metadataOf(addon);
  return {
    id: addon.uuid,
    state,
    ...(state === 'error' ? { message: `The add-on is ${addon.state}` } : {}),
    outputs: strings({ app: addon.app_slug, plan: addon.plan_slug, status: addon.state }),
    ...(state !== 'deleted' ? { usage: { [addonHoursMeter]: 1 } } : {}),
    spec: {
      app: addon.app_slug,
      plan: addon.plan_slug,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    },
  };
}

const path = (id: string) => `/add-ons/saas/${encodeURIComponent(id)}`;

async function readAddon(env: DoKindEnv, id: string, signal: AbortSignal) {
  const reply = await found(() =>
    env.client.request<{ resource: DoAddon }>('GET', path(id), { signal, budget: 'observe' }),
  );
  return reply?.resource;
}

async function* listAddons(env: DoKindEnv, signal: AbortSignal, budget: 'observe' | 'sweep') {
  yield* env.client.pages<DoAddon>('/add-ons/saas', 'resources', { signal, budget });
}

async function byName(env: DoKindEnv, name: string, context: CallContext) {
  for await (const addon of listAddons(env, context.signal, 'observe'))
    if (addon.name === name && status(addon.state) !== 'deleted') return addon;
  return undefined;
}

export function addonKind(): DoKind {
  const what = (id: string) => `Add-on ${id}`;
  return {
    definition: {
      kind: addonKindName,
      family: 'platform',
      description: 'A DigitalOcean Marketplace SaaS add-on on a plan',
      spec: addonSpecManifest,
      outputs: ['app', 'plan', 'status'],
      regional: false,
      updatable: ['plan'],
      // DigitalOcean bills an add-on by its plan; better-compute meters the hours it exists (the plan prices them).
      meters: [{ meter: addonHoursMeter, unit: 'hour' }],
    },

    async ensure(env, request, context) {
      const wanted = request.spec as AddonSpec;
      const name = `${request.name}${suffix(env)}`;
      let addon: DoAddon | undefined;
      if (request.id !== undefined) {
        addon = await readAddon(env, request.id, context.signal);
        if (!addon || status(addon.state) === 'deleted')
          return {
            id: request.id,
            state: 'error',
            message: `${what(request.id)} is gone at DigitalOcean`,
          };
        assertOwnedAddon(env, addon);
      } else addon = await byName(env, name, context);
      if (!addon) {
        try {
          const created = await env.client.request<{ resource: DoAddon }>('POST', '/add-ons/saas', {
            body: {
              app_slug: wanted.app,
              plan_slug: wanted.plan,
              name,
              metadata: Object.entries(wanted.metadata ?? {}).map(([key, value]) => ({
                name: key,
                value,
              })),
            },
            signal: context.signal,
            budget: 'mutate',
          });
          return addonState(created.resource);
        } catch (error) {
          if (!isComputeError(error, 'CONFLICT')) throw error;
          addon = await byName(env, name, context);
          if (!addon) throw error;
        }
      }
      if (addon.app_slug !== wanted.app) throw replaceRequired(addonKindName, 'app');
      if (
        wanted.metadata !== undefined &&
        canonical(metadataOf(addon)) !== canonical(wanted.metadata)
      )
        throw replaceRequired(addonKindName, 'metadata', 'it is read at provisioning only');
      if (addon.plan_slug === wanted.plan) return addonState(addon);
      if (status(addon.state) !== 'ready') return addonState(addon);
      const changed = await env.client.request<{ resource: DoAddon }>(
        'PATCH',
        `${path(addon.uuid)}/plan`,
        { body: { plan_slug: wanted.plan }, signal: context.signal, budget: 'mutate' },
      );
      const state = addonState(changed.resource);
      return state.state === 'ready' && changed.resource.plan_slug !== wanted.plan
        ? { ...state, state: 'updating' }
        : state;
    },

    async get(env, id, context) {
      const addon = await readAddon(env, id, context.signal);
      return addon && status(addon.state) !== 'deleted' ? addonState(addon) : undefined;
    },

    async delete(env, id, context) {
      const addon = await readAddon(env, id, context.signal);
      if (!addon || status(addon.state) === 'deleted') return { id, state: 'deleted' };
      assertOwnedAddon(env, addon);
      if (status(addon.state) === 'deleting') return { id, state: 'deleting' };
      await found(() =>
        env.client.request('DELETE', path(id), { signal: context.signal, budget: 'mutate' }),
      );
      return { id, state: 'deleting' };
    },

    async *discover(env, context): AsyncIterable<ProviderDiscoveredResource> {
      for await (const addon of listAddons(env, context.signal, 'sweep')) {
        if (status(addon.state) === 'deleted') continue;
        const by = owner(env, addon.name);
        yield {
          id: addon.uuid,
          name: addon.name,
          ...(by !== undefined ? { managedBy: by } : {}),
          outputs: addonState(addon).outputs!,
          spec: addonState(addon).spec!,
        };
      }
    },

    async adopt(env, id, _labels, context) {
      const addon = await readAddon(env, id, context.signal);
      if (!addon || status(addon.state) === 'deleted')
        throw new ComputeError('NOT_FOUND', `${what(id)} not found`);
      const by = owner(env, addon.name);
      if (by === 'other')
        throw new ComputeError(
          'INVALID_STATE',
          `${what(id)} is managed by another deployment`,
          undefined,
          { provider: 'digitalocean', reason: 'managedByAnother' },
        );
      if (by === 'this') return addonState(addon);
      const renamed = await env.client.request<{ resource: DoAddon }>('PATCH', path(id), {
        body: { name: `${addon.name.slice(0, 100)}${suffix(env)}` },
        signal: context.signal,
        budget: 'mutate',
      });
      return addonState(renamed.resource);
    },

    async release(env, id, context) {
      const addon = await readAddon(env, id, context.signal);
      if (!addon || status(addon.state) === 'deleted') return;
      assertOwnedAddon(env, addon);
      await env.client.request('PATCH', path(id), {
        body: { name: addon.name.replace(ownSuffix, '') || addon.uuid },
        signal: context.signal,
        budget: 'mutate',
      });
    },
  };
}
