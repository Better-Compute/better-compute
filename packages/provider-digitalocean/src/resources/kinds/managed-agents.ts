import {
  ComputeError,
  field,
  isComputeError,
  manifest,
  type CallContext,
  type ProviderDiscoveredResource,
  type ProviderResourceKind,
  type ProviderResourceRequest,
  type ProviderResourceState,
} from '@better-compute/core';
import { found, replaceRequired, strings, type DoKind, type DoKindEnv } from '../kind.js';
import { assertNameOwned, nameOwner, ownedName } from './named.js';

// Managed Agents (P8 task 5, DigitalOcean previews): Harness Runtime agents (`do.agent-harness`: a model and
// instructions with knowledge bases, guardrails and an Action Gateway, on a container or a MicroVM runtime, so
// "MicroVM-backed agents" are a runtime choice, not a kind of their own) and Action Gateways (`do.action-gateway`: the
// tools an agent may call, as https upstreams). Both kinds are `preview: true`: the dispatcher refuses them, with
// nothing sent, unless the account sets `previews: true`.
//
// Neither object carries tags (assumed), so ownership lives in the name (`<name>-bc<deployment hash>`, named.ts).
// Knowledge bases, guardrails and gateways are named by their DigitalOcean uuid: account-wide objects, so only a
// harness on the tenant's own account may name them (a shared account could reach another tenant's). The paths
// (/v2/managed-agents/harnesses, /v2/managed-agents/action-gateways) and the shapes are assumed, not a recording: the
// live suite captures real bodies before release.

export const agentHarnessKindName = 'do.agent-harness';
export const actionGatewayKindName = 'do.action-gateway';
/** One per harness agent per hour while it exists. */
export const agentHarnessHoursMeter = 'do.agent-harness.hours';
/** One per action gateway per hour while it exists. */
export const actionGatewayHoursMeter = 'do.action-gateway.hours';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const region = () =>
  field.string({ pattern: /^[a-z]{3}[0-9]$/ }).describe('Region slug, e.g. tor1');

interface DoObject {
  uuid: string;
  name: string;
  region: string;
  status?: string;
  endpoint?: string | null;
}

/** What differs between the two kinds; the lifecycle around it is shared. */
interface Shape<Spec, Object extends DoObject> {
  kind: string;
  what: string;
  base: string;
  one: string;
  many: string;
  meter: string;
  settled: string;
  definition: Omit<
    ProviderResourceKind,
    'kind' | 'family' | 'regional' | 'preview' | 'meters' | 'outputs'
  >;
  createBody(name: string, spec: Spec): Record<string, unknown>;
  /** The fields to PUT to reach the spec ({} when none); throws replaceRequired for a field that cannot change. */
  change(current: Object, spec: Spec): Record<string, unknown>;
  specOf(current: Object): Record<string, unknown>;
  accountWide?(spec: unknown): string[];
}

function phase(status: string | undefined, settled: string): ProviderResourceState['state'] {
  const value = (status ?? '').toUpperCase();
  if (value === settled) return 'ready';
  if (value === 'UPDATING') return 'updating';
  if (value === 'DELETING') return 'deleting';
  if (value === 'FAILED' || value === 'ERROR') return 'error';
  return 'pending';
}

function namedKind<Spec, Object extends DoObject>(shape: Shape<Spec, Object>): DoKind {
  const path = (id: string) => `${shape.base}/${encodeURIComponent(id)}`;
  const what = (id: string) => `${shape.what} ${id}`;

  function state(current: Object, spec?: Record<string, unknown>): ProviderResourceState {
    const now = phase(current.status, shape.settled);
    return {
      id: current.uuid,
      state: now,
      ...(now === 'error' ? { message: `${what(current.uuid)} is ${current.status}` } : {}),
      outputs: strings({ status: current.status, endpoint: current.endpoint }),
      usage: { [shape.meter]: 1 },
      spec: spec ?? shape.specOf(current),
    };
  }

  async function read(env: DoKindEnv, id: string, signal: AbortSignal) {
    const reply = await found(() =>
      env.client.request<Record<string, Object>>('GET', path(id), { signal, budget: 'observe' }),
    );
    return reply?.[shape.one];
  }

  async function byName(env: DoKindEnv, name: string, signal: AbortSignal) {
    for await (const entry of env.client.pages<Object>(shape.base, shape.many, {
      signal,
      budget: 'observe',
    }))
      if (entry.name === name) return entry;
    return undefined;
  }

  return {
    definition: {
      ...shape.definition,
      kind: shape.kind,
      family: 'ai',
      regional: true,
      preview: true,
      outputs: ['status', 'endpoint'],
      meters: [{ meter: shape.meter, unit: 'hour' }],
      ...(shape.accountWide ? { accountWide: shape.accountWide } : {}),
    },

    async ensure(env, request: ProviderResourceRequest, context: CallContext) {
      const wanted = request.spec as Spec;
      const reaching = shape.accountWide?.(wanted) ?? [];
      if (reaching.length > 0 && request.accountScope !== 'tenant')
        throw new ComputeError(
          'INVALID_INPUT',
          `${shape.kind}: ${reaching[0]} is account-wide; only a resource on the tenant's own account may name it`,
          undefined,
          { provider: 'digitalocean', reason: 'accountWide', fields: reaching },
        );
      let current: Object | undefined;
      if (request.id !== undefined) {
        current = await read(env, request.id, context.signal);
        if (!current)
          return {
            id: request.id,
            state: 'error',
            message: `${what(request.id)} is gone at DigitalOcean`,
          };
        assertNameOwned(env, current.name, what(current.uuid));
      } else {
        const name = ownedName(env, request.name);
        // The answer of an earlier create was lost: the name finds it.
        current = await byName(env, name, context.signal);
        if (!current)
          try {
            const created = await env.client.request<Record<string, Object>>('POST', shape.base, {
              body: shape.createBody(name, wanted),
              signal: context.signal,
              budget: 'mutate',
            });
            return state(created[shape.one]!);
          } catch (error) {
            // A racing create of ours took the name first.
            if (!isComputeError(error, 'CONFLICT')) throw error;
            current = await byName(env, name, context.signal);
            if (!current) throw error;
          }
      }
      const change = shape.change(current, wanted);
      const now = state(current);
      if (now.state !== 'ready' || Object.keys(change).length === 0) return now;
      const reply = await env.client.request<Record<string, Object>>('PUT', path(current.uuid), {
        body: change,
        signal: context.signal,
        budget: 'mutate',
      });
      const updated = reply[shape.one] ?? current;
      return { ...state(updated), state: 'updating' };
    },

    async get(env, id, context) {
      const current = await read(env, id, context.signal);
      if (!current) return undefined;
      return { ...state(current), managedBy: nameOwner(env, current.name) ?? 'none' };
    },

    async delete(env, id, context) {
      const current = await read(env, id, context.signal);
      if (!current) return { id, state: 'deleted' };
      assertNameOwned(env, current.name, what(id));
      await found(() =>
        env.client.request('DELETE', path(id), { signal: context.signal, budget: 'mutate' }),
      );
      return { id, state: 'deleting' };
    },

    async *discover(env, context): AsyncIterable<ProviderDiscoveredResource> {
      for await (const entry of env.client.pages<Object>(shape.base, shape.many, {
        signal: context.signal,
        budget: 'sweep',
      })) {
        const by = nameOwner(env, entry.name);
        yield {
          id: entry.uuid,
          name: entry.name,
          region: entry.region,
          ...(by !== undefined ? { managedBy: by } : {}),
          outputs: strings({ status: entry.status, endpoint: entry.endpoint }),
          spec: shape.specOf(entry),
        };
      }
    },
  };
}

// --- do.agent-harness -------------------------------------------------------------------------------------------

export interface AgentHarnessSpec {
  region: string;
  model: string;
  instructions: string;
  runtime?: 'container' | 'microvm';
  knowledgeBases?: string[];
  guardrails?: string[];
  actionGateway?: string;
}

interface DoHarness extends DoObject {
  model: string;
  instructions: string;
  runtime: string;
  knowledge_base_uuids?: string[] | null;
  guardrail_uuids?: string[] | null;
  action_gateway_uuid?: string | null;
}

const runtimes = { container: 'CONTAINER', microvm: 'MICROVM' } as const;
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((value, i) => value === [...b].sort()[i]);

function harnessAccountWide(spec: unknown): string[] {
  const wanted = spec as Partial<AgentHarnessSpec> | undefined;
  return [
    ...((wanted?.knowledgeBases ?? []).length > 0 ? ['knowledgeBases'] : []),
    ...((wanted?.guardrails ?? []).length > 0 ? ['guardrails'] : []),
    ...(wanted?.actionGateway !== undefined ? ['actionGateway'] : []),
  ];
}

export function agentHarnessKind(): DoKind {
  return namedKind<AgentHarnessSpec, DoHarness>({
    kind: agentHarnessKindName,
    what: 'Harness agent',
    base: '/managed-agents/harnesses',
    one: 'harness',
    many: 'harnesses',
    meter: agentHarnessHoursMeter,
    settled: 'RUNNING',
    definition: {
      description:
        'A DigitalOcean Managed Agents harness agent (preview): a model with instructions, knowledge bases, guardrails and tools, on a container or a MicroVM',
      spec: manifest({
        region: region(),
        model: field
          .string({ pattern: /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/ })
          .describe('The model slug, e.g. llama3.3-70b-instruct'),
        instructions: field
          .string({ pattern: /^[\s\S]+$/, maxLength: 10_000 })
          .describe('The system instructions the agent runs with'),
        runtime: field
          .option(['container', 'microvm'])
          .default('container')
          .describe('What the agent runs on; microvm isolates each session in a MicroVM'),
        knowledgeBases: field
          .list(field.string({ pattern: uuid }), { max: 10 })
          .optional()
          .describe("Knowledge bases of the tenant's own account (their uuids)"),
        guardrails: field
          .list(field.string({ pattern: uuid }), { max: 10 })
          .optional()
          .describe("Guardrails of the tenant's own account (their uuids)"),
        actionGateway: field
          .string({ pattern: uuid })
          .optional()
          .describe("An action gateway of the tenant's own account (its uuid)"),
      }),
      updatable: ['model', 'instructions', 'knowledgeBases', 'guardrails', 'actionGateway'],
    },
    createBody: (name, spec) => ({
      name,
      region: spec.region,
      model: spec.model,
      instructions: spec.instructions,
      runtime: runtimes[spec.runtime ?? 'container'],
      knowledge_base_uuids: spec.knowledgeBases ?? [],
      guardrail_uuids: spec.guardrails ?? [],
      ...(spec.actionGateway !== undefined ? { action_gateway_uuid: spec.actionGateway } : {}),
    }),
    change(current, spec) {
      if (spec.region !== current.region) throw replaceRequired(agentHarnessKindName, 'region');
      if (runtimes[spec.runtime ?? 'container'] !== current.runtime)
        throw replaceRequired(agentHarnessKindName, 'runtime');
      const out: Record<string, unknown> = {};
      if (spec.model !== current.model) out.model = spec.model;
      if (spec.instructions !== current.instructions) out.instructions = spec.instructions;
      if (!sameSet(spec.knowledgeBases ?? [], current.knowledge_base_uuids ?? []))
        out.knowledge_base_uuids = spec.knowledgeBases ?? [];
      if (!sameSet(spec.guardrails ?? [], current.guardrail_uuids ?? []))
        out.guardrail_uuids = spec.guardrails ?? [];
      if ((spec.actionGateway ?? null) !== (current.action_gateway_uuid ?? null))
        out.action_gateway_uuid = spec.actionGateway ?? null;
      return out;
    },
    specOf(current) {
      const runtime = (Object.keys(runtimes) as (keyof typeof runtimes)[]).find(
        (key) => runtimes[key] === current.runtime,
      );
      return {
        region: current.region,
        model: current.model,
        instructions: current.instructions,
        ...(runtime !== undefined && runtime !== 'container' ? { runtime } : {}),
        ...((current.knowledge_base_uuids ?? []).length > 0
          ? { knowledgeBases: [...current.knowledge_base_uuids!] }
          : {}),
        ...((current.guardrail_uuids ?? []).length > 0
          ? { guardrails: [...current.guardrail_uuids!] }
          : {}),
        ...(current.action_gateway_uuid ? { actionGateway: current.action_gateway_uuid } : {}),
      };
    },
    accountWide: harnessAccountWide,
  });
}

// --- do.action-gateway ------------------------------------------------------------------------------------------

export interface ActionGatewaySpec {
  region: string;
  upstreams: string[];
  description?: string;
}

interface DoActionGateway extends DoObject {
  description?: string | null;
  upstreams?: { url: string }[] | null;
}

export function actionGatewayKind(): DoKind {
  return namedKind<ActionGatewaySpec, DoActionGateway>({
    kind: actionGatewayKindName,
    what: 'Action gateway',
    base: '/managed-agents/action-gateways',
    one: 'action_gateway',
    many: 'action_gateways',
    meter: actionGatewayHoursMeter,
    settled: 'ACTIVE',
    definition: {
      description:
        'A DigitalOcean Managed Agents action gateway (preview): the tools an agent may call, as https upstreams',
      spec: manifest({
        region: region(),
        upstreams: field
          .list(field.string({ pattern: /^https:\/\/[^\s]{1,2040}$/ }), { min: 1, max: 20 })
          .describe('The tool endpoints the gateway forwards to (https URLs)'),
        description: field.string({ maxLength: 1000 }).optional().describe('Free text'),
      }),
      updatable: ['upstreams', 'description'],
    },
    createBody: (name, spec) => ({
      name,
      region: spec.region,
      upstreams: spec.upstreams.map((url) => ({ url })),
      ...(spec.description ? { description: spec.description } : {}),
    }),
    change(current, spec) {
      if (spec.region !== current.region) throw replaceRequired(actionGatewayKindName, 'region');
      const out: Record<string, unknown> = {};
      const have = (current.upstreams ?? []).map((entry) => entry.url);
      if (have.length !== spec.upstreams.length || have.some((url, i) => url !== spec.upstreams[i]))
        out.upstreams = spec.upstreams.map((url) => ({ url }));
      if ((current.description ?? '') !== (spec.description ?? ''))
        out.description = spec.description ?? '';
      return out;
    },
    specOf: (current) => ({
      region: current.region,
      upstreams: (current.upstreams ?? []).map((entry) => entry.url),
      ...(current.description ? { description: current.description } : {}),
    }),
  });
}
