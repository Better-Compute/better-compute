import { randomUUID } from 'node:crypto';
import type { DoEmulator, RouteContext } from './index.js';
import type { DoState, Json } from './state.js';

// GenAI guardrails (Agent Platform): a jailbreak, sensitive-data or content-moderation check with the response an
// agent gives when it trips. The path (/v2/gen-ai/guardrails) and the shapes are assumed from the API reference, not
// a recording: the live suite captures real bodies before release. Guardrails carry no tags; names are unique per
// account. The type cannot change.

export const guardrailTypes = [
  'GUARDRAIL_TYPE_JAILBREAK',
  'GUARDRAIL_TYPE_SENSITIVE_DATA',
  'GUARDRAIL_TYPE_CONTENT_MODERATION',
] as const;

const body = (guardrail: Json): Json => structuredClone(guardrail);

/** Seeds a guardrail made outside better-compute. */
export function seedGuardrail(state: DoState, fields: Json = {}): Json {
  const uuid = randomUUID();
  const guardrail: Json = {
    uuid,
    name: `by-hand-${uuid.slice(0, 6)}`,
    type: 'GUARDRAIL_TYPE_JAILBREAK',
    description: '',
    default_response: 'I cannot help with that.',
    created_at: new Date(state.now()).toISOString(),
    updated_at: new Date(state.now()).toISOString(),
    ...fields,
  };
  state.guardrails.set(uuid, guardrail);
  return guardrail;
}

export function registerGuardrails(emulator: DoEmulator): void {
  const list = /^\/gen-ai\/guardrails$/;
  const one = /^\/gen-ai\/guardrails\/([^/]+)$/;
  const of = (context: RouteContext) =>
    context.state.guardrails.get(decodeURIComponent(context.match[1]!));
  const text = (value: unknown, max: number) =>
    value === undefined || (typeof value === 'string' && value.length <= max);

  emulator.route('GET', list, (context) =>
    emulator.paged(context, 'guardrails', [...context.state.guardrails.values()].map(body)),
  );

  emulator.route('POST', list, (context) => {
    const input = context.body ?? {};
    if (
      typeof input.name !== 'string' ||
      input.name.length === 0 ||
      input.name.length > 128 ||
      !guardrailTypes.includes(input.type) ||
      typeof input.default_response !== 'string' ||
      !text(input.default_response, 1000) ||
      !text(input.description, 1000)
    )
      return emulator.error('422-unknown');
    if ([...context.state.guardrails.values()].some((entry) => entry.name === input.name))
      return emulator.error('422-name-in-use');
    const made = seedGuardrail(context.state, {
      name: input.name,
      type: input.type,
      description: input.description ?? '',
      default_response: input.default_response,
    });
    return { status: 200, body: { guardrail: body(made) } };
  });

  emulator.route('GET', one, (context) => {
    const guardrail = of(context);
    if (!guardrail) return emulator.error('not-found');
    return { status: 200, body: { guardrail: body(guardrail) } };
  });

  emulator.route('PUT', one, (context) => {
    const guardrail = of(context);
    if (!guardrail) return emulator.error('not-found');
    const input = context.body ?? {};
    if (input.type !== undefined && input.type !== guardrail.type)
      return emulator.error('422-unknown');
    if (!text(input.description, 1000) || !text(input.default_response, 1000))
      return emulator.error('422-unknown');
    if (typeof input.name === 'string') guardrail.name = input.name;
    if (typeof input.description === 'string') guardrail.description = input.description;
    if (typeof input.default_response === 'string')
      guardrail.default_response = input.default_response;
    guardrail.updated_at = new Date(context.state.now()).toISOString();
    return { status: 200, body: { guardrail: body(guardrail) } };
  });

  emulator.route('DELETE', one, (context) => {
    const guardrail = of(context);
    if (!guardrail) return emulator.error('not-found');
    context.state.guardrails.delete(guardrail.uuid);
    return { status: 200, body: { uuid: guardrail.uuid } };
  });
}
