import {
  ComputeError,
  field,
  isComputeError,
  manifest,
  type CallContext,
  type ProviderDiscoveredResource,
  type ProviderResourceState,
} from '@better-compute/core';
import {
  childId,
  found,
  parseChildId,
  replaceRequired,
  strings,
  type DoKind,
  type DoKindEnv,
} from '../kind.js';
import { canonical, isJson, isObject, objectManifest, type Issue } from '../spec.js';

// Functions: a namespace (`do.functions-namespace`) and the scheduled triggers living in one
// (`do.functions-trigger`). A namespace has no tags and nothing that can change after it is made but its triggers,
// so ownership is its label: `<provider name>-bc<deployment hash>`, set at create. The provider name derives from
// the resource id (the idempotency key), so a retried ensure finds the namespace by its label; a label that ends in
// another deployment's hash is that deployment's. The namespace key (its API credential, with the uuid) is a secret
// output, sealed by the module; a namespace cannot be adopted (its label cannot be changed to record an owner).

export const namespaceKindName = 'do.functions-namespace';
export const triggerKindName = 'do.functions-trigger';

const namespaceId = /^fn-[0-9a-f-]{8,64}$/;
const ownLabel = /-bc([0-9a-f]{12})$/;

export interface DoNamespace {
  namespace: string;
  label: string;
  region: string;
  api_host?: string;
  uuid?: string;
  key?: string;
  created_at?: string;
}

interface DoTrigger {
  name: string;
  function: string;
  type?: string;
  is_enabled?: boolean;
  scheduled_details?: { cron?: string; body?: Record<string, unknown> | null };
  scheduled_runs?: { last_run_at?: string | null; next_run_at?: string | null };
}

const deploymentHash = (env: DoKindEnv) =>
  env.deploymentTag.slice(env.deploymentTag.indexOf(':') + 1);
const labelFor = (env: DoKindEnv, name: string) => `${name}-bc${deploymentHash(env)}`;

/** `this`, `other`, or undefined (made by hand) from a namespace's label. */
function labelOwner(env: DoKindEnv, label: string | undefined): 'this' | 'other' | undefined {
  const match = ownLabel.exec(label ?? '');
  if (!match) return undefined;
  return match[1] === deploymentHash(env) ? 'this' : 'other';
}

function assertOwnedNamespace(env: DoKindEnv, namespace: DoNamespace): void {
  if (labelOwner(env, namespace.label) !== 'this')
    throw new ComputeError(
      'INVALID_STATE',
      `Functions namespace ${namespace.namespace} is not managed by this better-compute deployment; it is left alone`,
      undefined,
      { provider: 'digitalocean', reason: 'notManaged' },
    );
}

async function readNamespace(
  env: DoKindEnv,
  id: string,
  signal: AbortSignal,
): Promise<DoNamespace | undefined> {
  const reply = await found(() =>
    env.client.request<{ namespace: DoNamespace }>(
      'GET',
      `/functions/namespaces/${encodeURIComponent(id)}`,
      {
        signal,
        budget: 'observe',
      },
    ),
  );
  return reply?.namespace;
}

async function listNamespaces(env: DoKindEnv, signal: AbortSignal, budget: 'observe' | 'sweep') {
  const reply = await env.client.request<{ namespaces?: DoNamespace[] | null }>(
    'GET',
    '/functions/namespaces',
    {
      signal,
      budget,
    },
  );
  return reply.namespaces ?? [];
}

async function byLabel(env: DoKindEnv, label: string, context: CallContext) {
  return (await listNamespaces(env, context.signal, 'observe')).find(
    (namespace) => namespace.label === label,
  );
}

function namespaceState(namespace: DoNamespace): ProviderResourceState {
  return {
    id: namespace.namespace,
    state: 'ready',
    outputs: strings({
      namespace: namespace.namespace,
      apiHost: namespace.api_host,
      uuid: namespace.uuid,
      region: namespace.region,
      label: namespace.label,
    }),
    ...(namespace.key ? { secretOutputs: { key: namespace.key } } : {}),
    spec: { region: namespace.region },
  };
}

function namespaceKind(): DoKind {
  const what = (id: string) => `Functions namespace ${id}`;
  return {
    definition: {
      kind: namespaceKindName,
      family: 'platform',
      description: 'A DigitalOcean Functions namespace; its key is sealed',
      spec: manifest({
        region: field.string({ pattern: /^[a-z]{3}[0-9]$/ }).describe('Region slug, e.g. nyc1'),
      }),
      outputs: ['namespace', 'apiHost', 'uuid', 'region', 'label'],
      secretOutputs: ['key'],
      regional: true,
      updatable: [],
      meters: [{ meter: 'do.functions.gib.seconds', unit: 'GiB-second' }],
    },

    async ensure(env, request, context) {
      const { region } = request.spec as { region: string };
      const label = labelFor(env, request.name);
      let namespace: DoNamespace | undefined;
      if (request.id !== undefined) {
        namespace = await readNamespace(env, request.id, context.signal);
        if (!namespace)
          return {
            id: request.id,
            state: 'error',
            message: `${what(request.id)} is gone at DigitalOcean`,
          };
        assertOwnedNamespace(env, namespace);
      } else namespace = await byLabel(env, label, context);
      if (!namespace) {
        try {
          const created = await env.client.request<{ namespace: DoNamespace }>(
            'POST',
            '/functions/namespaces',
            {
              body: { region, label },
              signal: context.signal,
              budget: 'mutate',
            },
          );
          return namespaceState(created.namespace);
        } catch (error) {
          if (!isComputeError(error, 'CONFLICT')) throw error;
          namespace = await byLabel(env, label, context);
          if (!namespace) throw error;
        }
      }
      if (namespace.region !== region) throw replaceRequired(namespaceKindName, 'region');
      return namespaceState(namespace);
    },

    async get(env, id, context) {
      const namespace = await readNamespace(env, id, context.signal);
      return namespace ? namespaceState(namespace) : undefined;
    },

    async delete(env, id, context) {
      const namespace = await readNamespace(env, id, context.signal);
      if (!namespace) return { id, state: 'deleted' };
      assertOwnedNamespace(env, namespace);
      await found(() =>
        env.client.request('DELETE', `/functions/namespaces/${encodeURIComponent(id)}`, {
          signal: context.signal,
          budget: 'mutate',
        }),
      );
      return { id, state: 'deleted' };
    },

    async *discover(env, context): AsyncIterable<ProviderDiscoveredResource> {
      for (const namespace of await listNamespaces(env, context.signal, 'sweep')) {
        const owner = labelOwner(env, namespace.label);
        yield {
          id: namespace.namespace,
          name: namespace.label,
          region: namespace.region,
          ...(owner !== undefined ? { managedBy: owner } : {}),
          spec: { region: namespace.region },
        };
      }
    },
  };
}

// --- scheduled triggers ------------------------------------------------------------------------------------------

export interface TriggerSpec {
  name: string;
  function: string;
  cron: string;
  body?: Record<string, unknown>;
  enabled: boolean;
}

const triggerName = /^[A-Za-z0-9_-]{1,64}$/;
const functionPath = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)?$/;
const cronField = /^[0-9*,/-]+$/;

function checkTrigger(value: unknown, issues: Issue[]): TriggerSpec {
  if (!isObject(value)) {
    issues.push({ message: 'a trigger spec is an object', path: [] });
    return value as unknown as TriggerSpec;
  }
  for (const key of Object.keys(value))
    if (!['name', 'function', 'cron', 'body', 'enabled'].includes(key))
      issues.push({ message: `${key} is not a trigger field`, path: [key] });
  if (typeof value.name !== 'string' || !triggerName.test(value.name))
    issues.push({ message: 'name is 1-64 letters, digits, _ and -', path: ['name'] });
  if (typeof value.function !== 'string' || !functionPath.test(value.function))
    issues.push({
      message: 'function is a function in the namespace, e.g. sample/hello',
      path: ['function'],
    });
  const fields = typeof value.cron === 'string' ? value.cron.trim().split(/\s+/) : [];
  if (fields.length !== 5 || !fields.every((part) => cronField.test(part)))
    issues.push({ message: 'cron is a five-field cron expression', path: ['cron'] });
  if (
    value.body !== undefined &&
    (!isObject(value.body) || !isJson(value.body) || JSON.stringify(value.body).length > 4096)
  )
    issues.push({ message: 'body is a JSON object of at most 4 KiB', path: ['body'] });
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean')
    issues.push({ message: 'enabled is a boolean', path: ['enabled'] });
  return {
    name: value.name as string,
    function: value.function as string,
    cron: typeof value.cron === 'string' ? fields.join(' ') : (value.cron as string),
    ...(value.body !== undefined ? { body: value.body as Record<string, unknown> } : {}),
    enabled: value.enabled === undefined ? true : (value.enabled as boolean),
  };
}

export const triggerSpecManifest = objectManifest<TriggerSpec>(
  {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['name', 'function', 'cron'],
    properties: {
      name: { type: 'string', pattern: triggerName.source },
      function: { type: 'string', pattern: functionPath.source, description: 'e.g. sample/hello' },
      cron: { type: 'string', description: 'Five-field cron expression' },
      body: { type: 'object', description: 'JSON the function is invoked with (at most 4 KiB)' },
      enabled: { type: 'boolean', default: true },
    },
  },
  checkTrigger,
);

function triggerKind(): DoKind {
  const parseId = (id: string) => parseChildId(triggerKindName, id, namespaceId);
  const path = (namespace: string, name: string) =>
    `/functions/namespaces/${encodeURIComponent(namespace)}/triggers/${encodeURIComponent(name)}`;
  const read = async (env: DoKindEnv, namespace: string, name: string, signal: AbortSignal) =>
    (
      await found(() =>
        env.client.request<{ trigger: DoTrigger }>('GET', path(namespace, name), {
          signal,
          budget: 'observe',
        }),
      )
    )?.trigger;
  const specOf = (trigger: DoTrigger): TriggerSpec => ({
    name: trigger.name,
    function: trigger.function,
    cron: trigger.scheduled_details?.cron ?? '',
    ...(trigger.scheduled_details?.body ? { body: trigger.scheduled_details.body } : {}),
    enabled: trigger.is_enabled !== false,
  });
  const state = (namespace: string, trigger: DoTrigger): ProviderResourceState => ({
    id: childId(namespace, trigger.name),
    state: 'ready',
    outputs: strings({
      name: trigger.name,
      function: trigger.function,
      enabled: trigger.is_enabled !== false,
      nextRunAt: trigger.scheduled_runs?.next_run_at,
      lastRunAt: trigger.scheduled_runs?.last_run_at,
    }),
    spec: { ...specOf(trigger) },
  });
  /** The namespace, managed by this deployment; `notManaged` otherwise (nothing is sent). */
  const ownedNamespace = async (
    env: DoKindEnv,
    parent: string | undefined,
    signal: AbortSignal,
  ) => {
    if (parent === undefined)
      throw new ComputeError(
        'INVALID_INPUT',
        `${triggerKindName} needs the namespace it lives in`,
        undefined,
        {
          provider: 'digitalocean',
          reason: 'parent',
        },
      );
    const namespace = await readNamespace(env, parent, signal);
    if (namespace) assertOwnedNamespace(env, namespace);
    return namespace;
  };
  const details = (spec: TriggerSpec) => ({ cron: spec.cron, body: spec.body ?? {} });

  return {
    definition: {
      kind: triggerKindName,
      family: 'platform',
      description: 'A scheduled trigger of a DigitalOcean Functions namespace',
      spec: triggerSpecManifest,
      outputs: ['name', 'function', 'enabled', 'nextRunAt', 'lastRunAt'],
      regional: false,
      updatable: ['cron', 'body', 'enabled'],
      parent: namespaceKindName,
    },

    async ensure(env, request, context) {
      const wanted = request.spec as TriggerSpec;
      if (request.id !== undefined && parseId(request.id).name !== wanted.name)
        throw replaceRequired(triggerKindName, 'name');
      const namespace = await ownedNamespace(env, request.parent, context.signal);
      if (!namespace)
        return {
          id: childId(request.parent!, wanted.name),
          state: 'error',
          message: 'Its namespace is gone',
        };
      let trigger = await read(env, namespace.namespace, wanted.name, context.signal);
      if (!trigger)
        try {
          const created = await env.client.request<{ trigger: DoTrigger }>(
            'POST',
            `/functions/namespaces/${encodeURIComponent(namespace.namespace)}/triggers`,
            {
              body: {
                name: wanted.name,
                function: wanted.function,
                type: 'SCHEDULED',
                is_enabled: wanted.enabled,
                scheduled_details: details(wanted),
              },
              signal: context.signal,
              budget: 'mutate',
            },
          );
          return state(namespace.namespace, created.trigger);
        } catch (error) {
          if (!isComputeError(error, 'CONFLICT')) throw error;
          trigger = await read(env, namespace.namespace, wanted.name, context.signal);
          if (!trigger) throw error;
        }
      const have = specOf(trigger);
      if (have.function !== wanted.function) throw replaceRequired(triggerKindName, 'function');
      if (
        have.cron === wanted.cron &&
        have.enabled === wanted.enabled &&
        canonical(have.body ?? {}) === canonical(wanted.body ?? {})
      )
        return state(namespace.namespace, trigger);
      const updated = await env.client.request<{ trigger: DoTrigger }>(
        'PUT',
        path(namespace.namespace, wanted.name),
        {
          body: { is_enabled: wanted.enabled, scheduled_details: details(wanted) },
          signal: context.signal,
          budget: 'mutate',
        },
      );
      return state(namespace.namespace, updated.trigger);
    },

    async get(env, id, context) {
      const { parent, name } = parseId(id);
      const trigger = await read(env, parent, name, context.signal);
      return trigger ? state(parent, trigger) : undefined;
    },

    async delete(env, id, context) {
      const { parent, name } = parseId(id);
      const namespace = await ownedNamespace(env, parent, context.signal);
      if (!namespace) return { id, state: 'deleted' };
      await found(() =>
        env.client.request('DELETE', path(parent, name), {
          signal: context.signal,
          budget: 'mutate',
        }),
      );
      return { id, state: 'deleted' };
    },
  };
}

export function functionsKinds(): DoKind[] {
  return [namespaceKind(), triggerKind()];
}
