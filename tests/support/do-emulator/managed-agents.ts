import { randomUUID } from 'node:crypto';
import type { DoEmulator, RouteContext } from './index.js';
import type { DoState, Json } from './state.js';

// Managed Agents (preview): Harness Runtime agents (a model, instructions, knowledge bases, guardrails and an Action
// Gateway, on a container or MicroVM runtime) and Action Gateways (the tools an agent may call, as upstream URLs).
// The paths (/v2/managed-agents/harnesses, /v2/managed-agents/action-gateways) and the shapes are assumed, not a
// recording: the products are previews, and the live suite captures real bodies before release. Neither carries
// tags; names are unique per account. A new or changed harness is DEPLOYING (UPDATING) for `emulator.managedAgentReads`
// reads, then RUNNING; a gateway is PROVISIONING (UPDATING), then ACTIVE. Delete removes at once.

const body = (entry: Json): Json => {
  const { _reads, ...rest } = entry;
  return structuredClone(rest);
};

const uuidList = (value: unknown) =>
  value === undefined || (Array.isArray(value) && value.every((v) => typeof v === 'string'));

function observe(emulator: DoEmulator, entry: Json, settled: string): void {
  if (entry.status === settled || entry.status === 'FAILED' || entry.status === 'ERROR') return;
  entry._reads = (entry._reads ?? 0) + 1;
  if (entry._reads <= emulator.managedAgentReads) return;
  entry._reads = 0;
  entry.status = settled;
}

/** Seeds a harness agent made outside better-compute (running). */
export function seedHarness(state: DoState, fields: Json = {}): Json {
  const uuid = randomUUID();
  const harness: Json = {
    uuid,
    name: `by-hand-${uuid.slice(0, 6)}`,
    region: 'tor1',
    model: 'llama3.3-70b-instruct',
    instructions: 'Answer questions.',
    runtime: 'CONTAINER',
    knowledge_base_uuids: [],
    guardrail_uuids: [],
    status: 'RUNNING',
    endpoint: `https://${uuid.slice(0, 8)}.agents.do-ai.run`,
    created_at: new Date(state.now()).toISOString(),
    ...fields,
  };
  state.harnesses.set(uuid, harness);
  return harness;
}

/** Seeds an action gateway made outside better-compute (active). */
export function seedActionGateway(state: DoState, fields: Json = {}): Json {
  const uuid = randomUUID();
  const gateway: Json = {
    uuid,
    name: `by-hand-${uuid.slice(0, 6)}`,
    region: 'tor1',
    description: '',
    upstreams: [{ url: 'https://tools.example.com/' }],
    status: 'ACTIVE',
    endpoint: `https://${uuid.slice(0, 8)}.actions.do-ai.run`,
    created_at: new Date(state.now()).toISOString(),
    ...fields,
  };
  state.actionGateways.set(uuid, gateway);
  return gateway;
}

/**
 * Seeds a Signal (read-only: DigitalOcean raises them about a harness or a gateway; nothing writes them through the
 * API). Shape assumed: `resource_type` HARNESS or ACTION_GATEWAY, a `type`, an optional `severity`, a `message`.
 */
export function seedSignal(state: DoState, fields: Json = {}): Json {
  const signal: Json = {
    uuid: randomUUID(),
    resource_type: 'HARNESS',
    resource_uuid: randomUUID(),
    type: 'HUMAN_INPUT_REQUESTED',
    message: 'The agent asks a human to approve a refund.',
    created_at: new Date(state.now()).toISOString(),
    ...fields,
  };
  state.agentSignals.push(signal);
  return signal;
}

export function registerManagedAgents(emulator: DoEmulator): void {
  emulator.route('GET', /^\/managed-agents\/signals$/, (context) =>
    emulator.paged(context, 'signals', structuredClone(context.state.agentSignals)),
  );
  const harnesses = /^\/managed-agents\/harnesses$/;
  const harness = /^\/managed-agents\/harnesses\/([^/]+)$/;
  const gateways = /^\/managed-agents\/action-gateways$/;
  const gateway = /^\/managed-agents\/action-gateways\/([^/]+)$/;
  const harnessOf = (context: RouteContext) =>
    context.state.harnesses.get(decodeURIComponent(context.match[1]!));
  const gatewayOf = (context: RouteContext) =>
    context.state.actionGateways.get(decodeURIComponent(context.match[1]!));

  emulator.route('GET', harnesses, (context) => {
    for (const entry of context.state.harnesses.values()) observe(emulator, entry, 'RUNNING');
    return emulator.paged(context, 'harnesses', [...context.state.harnesses.values()].map(body));
  });

  emulator.route('POST', harnesses, (context) => {
    const input = context.body ?? {};
    if (
      typeof input.name !== 'string' ||
      typeof input.region !== 'string' ||
      typeof input.model !== 'string' ||
      typeof input.instructions !== 'string' ||
      !['CONTAINER', 'MICROVM'].includes(input.runtime) ||
      !uuidList(input.knowledge_base_uuids) ||
      !uuidList(input.guardrail_uuids)
    )
      return emulator.error('422-unknown');
    if ([...context.state.harnesses.values()].some((entry) => entry.name === input.name))
      return emulator.error('422-name-in-use');
    const made = seedHarness(context.state, {
      name: input.name,
      region: input.region,
      model: input.model,
      instructions: input.instructions,
      runtime: input.runtime,
      knowledge_base_uuids: input.knowledge_base_uuids ?? [],
      guardrail_uuids: input.guardrail_uuids ?? [],
      ...(typeof input.action_gateway_uuid === 'string'
        ? { action_gateway_uuid: input.action_gateway_uuid }
        : {}),
      status: 'DEPLOYING',
    });
    return { status: 200, body: { harness: body(made) } };
  });

  emulator.route('GET', harness, (context) => {
    const entry = harnessOf(context);
    if (!entry) return emulator.error('not-found');
    observe(emulator, entry, 'RUNNING');
    return { status: 200, body: { harness: body(entry) } };
  });

  emulator.route('PUT', harness, (context) => {
    const entry = harnessOf(context);
    if (!entry) return emulator.error('not-found');
    const input = context.body ?? {};
    if (input.region !== undefined || input.runtime !== undefined)
      return emulator.error('422-unknown');
    if (!uuidList(input.knowledge_base_uuids) || !uuidList(input.guardrail_uuids))
      return emulator.error('422-unknown');
    for (const key of ['model', 'instructions', 'knowledge_base_uuids', 'guardrail_uuids'])
      if (input[key] !== undefined) entry[key] = structuredClone(input[key]);
    if (input.action_gateway_uuid === null) delete entry.action_gateway_uuid;
    else if (typeof input.action_gateway_uuid === 'string')
      entry.action_gateway_uuid = input.action_gateway_uuid;
    entry.status = 'UPDATING';
    entry._reads = 0;
    return { status: 200, body: { harness: body(entry) } };
  });

  emulator.route('DELETE', harness, (context) => {
    const entry = harnessOf(context);
    if (!entry) return emulator.error('not-found');
    context.state.harnesses.delete(entry.uuid);
    return { status: 204 };
  });

  emulator.route('GET', gateways, (context) => {
    for (const entry of context.state.actionGateways.values()) observe(emulator, entry, 'ACTIVE');
    return emulator.paged(
      context,
      'action_gateways',
      [...context.state.actionGateways.values()].map(body),
    );
  });

  emulator.route('POST', gateways, (context) => {
    const input = context.body ?? {};
    if (
      typeof input.name !== 'string' ||
      typeof input.region !== 'string' ||
      !Array.isArray(input.upstreams) ||
      input.upstreams.length === 0 ||
      !input.upstreams.every((u: Json) => typeof u?.url === 'string')
    )
      return emulator.error('422-unknown');
    if ([...context.state.actionGateways.values()].some((entry) => entry.name === input.name))
      return emulator.error('422-name-in-use');
    const made = seedActionGateway(context.state, {
      name: input.name,
      region: input.region,
      description: typeof input.description === 'string' ? input.description : '',
      upstreams: structuredClone(input.upstreams),
      status: 'PROVISIONING',
    });
    return { status: 200, body: { action_gateway: body(made) } };
  });

  emulator.route('GET', gateway, (context) => {
    const entry = gatewayOf(context);
    if (!entry) return emulator.error('not-found');
    observe(emulator, entry, 'ACTIVE');
    return { status: 200, body: { action_gateway: body(entry) } };
  });

  emulator.route('PUT', gateway, (context) => {
    const entry = gatewayOf(context);
    if (!entry) return emulator.error('not-found');
    const input = context.body ?? {};
    if (input.region !== undefined) return emulator.error('422-unknown');
    if (input.upstreams !== undefined) {
      if (
        !Array.isArray(input.upstreams) ||
        input.upstreams.length === 0 ||
        !input.upstreams.every((u: Json) => typeof u?.url === 'string')
      )
        return emulator.error('422-unknown');
      entry.upstreams = structuredClone(input.upstreams);
    }
    if (typeof input.description === 'string') entry.description = input.description;
    entry.status = 'UPDATING';
    entry._reads = 0;
    return { status: 200, body: { action_gateway: body(entry) } };
  });

  emulator.route('DELETE', gateway, (context) => {
    const entry = gatewayOf(context);
    if (!entry) return emulator.error('not-found');
    context.state.actionGateways.delete(entry.uuid);
    return { status: 204 };
  });
}
