import { randomBytes, randomUUID } from 'node:crypto';
import type { DoEmulator, RouteContext } from './index.js';
import type { DoState, Json } from './state.js';

// Functions: namespaces (with their API key, returned on create and on every read) and scheduled triggers. Shapes
// follow the API reference (functions.yml), not a recording: the live suite captures real bodies before release.

let keys = 0;
/** A fresh namespace key, recognisable in a test. */
export const newNamespaceKey = () => `fnkey${++keys}${randomBytes(12).toString('hex')}`;

const regions = new Set(['nyc1', 'sfo3', 'ams3', 'fra1', 'lon1', 'blr1', 'sgp1', 'syd1', 'tor1']);

function body(namespace: Json): Json {
  const { _triggers, ...rest } = namespace;
  return structuredClone(rest);
}

/** Seeds a namespace made outside better-compute. */
export function seedNamespace(state: DoState, fields: Json = {}): Json {
  const uuid = randomUUID();
  const namespace: Json = {
    namespace: `fn-${uuid}`,
    uuid: randomUUID(),
    key: newNamespaceKey(),
    label: `by-hand-${uuid.slice(0, 6)}`,
    region: 'nyc1',
    api_host: 'https://faas-nyc1-2ef2e6cc.doserverless.co',
    created_at: new Date(state.now()).toISOString(),
    updated_at: new Date(state.now()).toISOString(),
    ...fields,
    _triggers: [],
  };
  state.functionsNamespaces.set(namespace.namespace, namespace);
  return namespace;
}

const namespaceOf = (context: RouteContext) =>
  context.state.functionsNamespaces.get(decodeURIComponent(context.match[1]!));

export function registerFunctions(emulator: DoEmulator): void {
  emulator.route('GET', /^\/functions\/namespaces$/, (context) => ({
    status: 200,
    body: { namespaces: [...context.state.functionsNamespaces.values()].map(body) },
  }));

  emulator.route('POST', /^\/functions\/namespaces$/, (context) => {
    const input = context.body ?? {};
    if (!regions.has(input.region) || typeof input.label !== 'string' || input.label.length === 0)
      return emulator.error('422-unknown');
    if ([...context.state.functionsNamespaces.values()].some((n) => n.label === input.label))
      return emulator.error('422-name-in-use');
    const namespace = seedNamespace(context.state, { label: input.label, region: input.region });
    return { status: 200, body: { namespace: body(namespace) } };
  });

  emulator.route('GET', /^\/functions\/namespaces\/([^/]+)$/, (context) => {
    const namespace = namespaceOf(context);
    if (!namespace) return emulator.error('not-found');
    return { status: 200, body: { namespace: body(namespace) } };
  });

  emulator.route('DELETE', /^\/functions\/namespaces\/([^/]+)$/, (context) => {
    const namespace = namespaceOf(context);
    if (!namespace) return emulator.error('not-found');
    context.state.functionsNamespaces.delete(namespace.namespace);
    return { status: 204 };
  });

  // Triggers.
  const triggerBody = (namespace: Json, trigger: Json) => ({
    namespace: namespace.namespace,
    ...structuredClone(trigger),
  });
  const triggerOf = (context: RouteContext) => {
    const namespace = namespaceOf(context);
    const trigger = namespace?._triggers.find(
      (t: Json) => t.name === decodeURIComponent(context.match[2]!),
    );
    return { namespace, trigger };
  };

  emulator.route('GET', /^\/functions\/namespaces\/([^/]+)\/triggers$/, (context) => {
    const namespace = namespaceOf(context);
    if (!namespace) return emulator.error('not-found');
    return {
      status: 200,
      body: { triggers: namespace._triggers.map((t: Json) => triggerBody(namespace, t)) },
    };
  });

  emulator.route('POST', /^\/functions\/namespaces\/([^/]+)\/triggers$/, (context) => {
    const namespace = namespaceOf(context);
    if (!namespace) return emulator.error('not-found');
    const input = context.body ?? {};
    if (
      typeof input.name !== 'string' ||
      typeof input.function !== 'string' ||
      input.type !== 'SCHEDULED' ||
      typeof input.scheduled_details?.cron !== 'string'
    )
      return emulator.error('422-unknown');
    if (namespace._triggers.some((t: Json) => t.name === input.name))
      return emulator.error('422-name-in-use');
    const now = new Date(context.state.now()).toISOString();
    const trigger = {
      name: input.name,
      function: input.function,
      type: 'SCHEDULED',
      is_enabled: input.is_enabled !== false,
      created_at: now,
      updated_at: now,
      scheduled_details: structuredClone(input.scheduled_details),
      scheduled_runs: { last_run_at: null, next_run_at: now },
    };
    namespace._triggers.push(trigger);
    return { status: 200, body: { trigger: triggerBody(namespace, trigger) } };
  });

  emulator.route('GET', /^\/functions\/namespaces\/([^/]+)\/triggers\/([^/]+)$/, (context) => {
    const { namespace, trigger } = triggerOf(context);
    if (!trigger) return emulator.error('not-found');
    return { status: 200, body: { trigger: triggerBody(namespace!, trigger) } };
  });

  emulator.route('PUT', /^\/functions\/namespaces\/([^/]+)\/triggers\/([^/]+)$/, (context) => {
    const { namespace, trigger } = triggerOf(context);
    if (!trigger) return emulator.error('not-found');
    const input = context.body ?? {};
    if (input.is_enabled !== undefined) trigger.is_enabled = input.is_enabled;
    if (input.scheduled_details !== undefined)
      trigger.scheduled_details = structuredClone(input.scheduled_details);
    trigger.updated_at = new Date(context.state.now()).toISOString();
    return { status: 200, body: { trigger: triggerBody(namespace!, trigger) } };
  });

  emulator.route('DELETE', /^\/functions\/namespaces\/([^/]+)\/triggers\/([^/]+)$/, (context) => {
    const { namespace, trigger } = triggerOf(context);
    if (!trigger) return emulator.error('not-found');
    namespace!._triggers = namespace!._triggers.filter((t: Json) => t !== trigger);
    return { status: 204 };
  });
}
