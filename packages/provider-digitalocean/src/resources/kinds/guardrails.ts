import {
  field,
  manifest,
  type CallContext,
  type ProviderDiscoveredResource,
  type ProviderResourceRequest,
  type ProviderResourceState,
} from '@better-compute/core';
import { found, replaceRequired, type DoKind, type DoKindEnv } from '../kind.js';
import { assertNameOwned, nameOwner, ownedName } from './named.js';

// Guardrails (`do.guardrail`, P8, Agent Platform): a jailbreak, sensitive-data or content-moderation check, with the
// response an agent gives when it trips. The response and description change in place; the type is a new guardrail.
// Guardrails carry no tags, so ownership lives in the name, as for model access keys: `<name>-bc<deployment hash>`.
// A create whose answer was lost is found again by that name. No agents are deployed (DO-D21), so a guardrail is
// attached by whoever runs the agent. The path (/v2/gen-ai/guardrails) and the shapes are assumed from the API
// reference, not a recording: the live suite captures real bodies before release.

export const guardrailKindName = 'do.guardrail';

/** The spec's guardrail types and DigitalOcean's names for them. */
const types = {
  jailbreak: 'GUARDRAIL_TYPE_JAILBREAK',
  'sensitive-data': 'GUARDRAIL_TYPE_SENSITIVE_DATA',
  'content-moderation': 'GUARDRAIL_TYPE_CONTENT_MODERATION',
} as const;
type GuardrailType = keyof typeof types;

export interface GuardrailSpec {
  type: GuardrailType;
  defaultResponse: string;
  description?: string;
}

interface DoGuardrail {
  uuid: string;
  name: string;
  type: string;
  description?: string | null;
  default_response?: string | null;
}

const base = '/gen-ai/guardrails';
const path = (uuid: string) => `${base}/${encodeURIComponent(uuid)}`;

const owner = (env: DoKindEnv, guardrail: DoGuardrail) => nameOwner(env, guardrail.name);
const assertOwned = (env: DoKindEnv, guardrail: DoGuardrail) =>
  assertNameOwned(env, guardrail.name, `Guardrail ${guardrail.uuid}`);

function typeOf(doType: string): GuardrailType | undefined {
  return (Object.keys(types) as GuardrailType[]).find((key) => types[key] === doType);
}

function specOf(guardrail: DoGuardrail): Record<string, unknown> {
  const type = typeOf(guardrail.type);
  return {
    ...(type !== undefined ? { type } : {}),
    defaultResponse: guardrail.default_response ?? '',
    ...(guardrail.description ? { description: guardrail.description } : {}),
  };
}

function state(guardrail: DoGuardrail): ProviderResourceState {
  return {
    id: guardrail.uuid,
    state: 'ready',
    outputs: { type: guardrail.type },
    spec: specOf(guardrail),
  };
}

async function byId(env: DoKindEnv, uuid: string, signal: AbortSignal) {
  const reply = await found(() =>
    env.client.request<{ guardrail: DoGuardrail }>('GET', path(uuid), {
      signal,
      budget: 'observe',
    }),
  );
  return reply?.guardrail;
}

async function byName(env: DoKindEnv, name: string, signal: AbortSignal) {
  for await (const guardrail of env.client.pages<DoGuardrail>(base, 'guardrails', {
    signal,
    budget: 'observe',
  }))
    if (guardrail.name === name) return guardrail;
  return undefined;
}

/** Brings an owned guardrail to the spec: the type cannot change; the response and description are one PUT. */
async function converge(
  env: DoKindEnv,
  guardrail: DoGuardrail,
  wanted: GuardrailSpec,
  context: CallContext,
): Promise<ProviderResourceState> {
  if (guardrail.type !== types[wanted.type]) throw replaceRequired(guardrailKindName, 'type');
  const change: Record<string, string> = {};
  if ((guardrail.default_response ?? '') !== wanted.defaultResponse)
    change.default_response = wanted.defaultResponse;
  if ((guardrail.description ?? '') !== (wanted.description ?? ''))
    change.description = wanted.description ?? '';
  if (Object.keys(change).length === 0) return state(guardrail);
  const reply = await env.client.request<{ guardrail: DoGuardrail }>('PUT', path(guardrail.uuid), {
    body: change,
    signal: context.signal,
    budget: 'mutate',
  });
  return state(reply.guardrail);
}

export function guardrailKind(): DoKind {
  return {
    definition: {
      kind: guardrailKindName,
      family: 'ai',
      description:
        'A DigitalOcean Agent Platform guardrail (jailbreak, sensitive data or content moderation)',
      spec: manifest({
        type: field
          .option(['jailbreak', 'sensitive-data', 'content-moderation'])
          .describe('What the guardrail checks for; a new guardrail to change'),
        defaultResponse: field
          .string({ pattern: /^[\s\S]+$/, maxLength: 1000 })
          .describe('What the agent answers when the guardrail trips'),
        description: field.string({ maxLength: 1000 }).optional().describe('Free text'),
      }),
      outputs: ['type'],
      regional: false,
      updatable: ['defaultResponse', 'description'],
    },

    async ensure(env, request: ProviderResourceRequest, context) {
      const wanted = request.spec as GuardrailSpec;
      if (request.id !== undefined) {
        const guardrail = await byId(env, request.id, context.signal);
        if (!guardrail)
          return {
            id: request.id,
            state: 'error',
            message: `Guardrail ${request.id} is gone at DigitalOcean`,
          };
        assertOwned(env, guardrail);
        return converge(env, guardrail, wanted, context);
      }
      const name = ownedName(env, request.name);
      // The answer of an earlier create was lost: the name finds it.
      const existing = await byName(env, name, context.signal);
      if (existing) return converge(env, existing, wanted, context);
      const created = await env.client.request<{ guardrail: DoGuardrail }>('POST', base, {
        body: {
          name,
          type: types[wanted.type],
          default_response: wanted.defaultResponse,
          ...(wanted.description ? { description: wanted.description } : {}),
        },
        signal: context.signal,
        budget: 'mutate',
      });
      return state(created.guardrail);
    },

    async get(env, id, context) {
      const guardrail = await byId(env, id, context.signal);
      if (!guardrail) return undefined;
      return { ...state(guardrail), managedBy: owner(env, guardrail) ?? 'none' };
    },

    async delete(env, id, context) {
      const guardrail = await byId(env, id, context.signal);
      if (!guardrail) return { id, state: 'deleted' };
      assertOwned(env, guardrail);
      await found(() =>
        env.client.request('DELETE', path(id), { signal: context.signal, budget: 'mutate' }),
      );
      return { id, state: 'deleted' };
    },

    async *discover(env, context): AsyncIterable<ProviderDiscoveredResource> {
      for await (const guardrail of env.client.pages<DoGuardrail>(base, 'guardrails', {
        signal: context.signal,
        budget: 'sweep',
      })) {
        const by = owner(env, guardrail);
        yield {
          id: guardrail.uuid,
          name: guardrail.name,
          ...(by !== undefined ? { managedBy: by } : {}),
          outputs: { type: guardrail.type },
          spec: specOf(guardrail),
        };
      }
    },
  };
}
