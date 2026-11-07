import {
  ComputeError,
  field,
  manifest,
  type CallContext,
  type ProviderDiscoveredResource,
  type ProviderResourceRequest,
  type ProviderResourceState,
} from '@better-compute/core';
import { found, type DoKind, type DoKindEnv } from '../kind.js';

// Inference keys (`do.inference-key`, P8): a model access key of the AI platform, the bearer serverless inference
// (chat, completions, embeddings, batch) and dedicated endpoints take. The key's secret is a secret output: DigitalOcean
// answers it on create and on a regenerate only, and the cloud-resources module seals it in the run that received it.
// Model keys carry no tags, so ownership and the applied rotation live in the name: `<name>-r<rotation>-bc<deployment
// hash>`. A create whose answer was lost finds its key by name and regenerates it, so a secret no one sealed is never
// live; bumping `rotation` regenerates it on purpose. Usage is by tokens (`ai.inference.tokens`): the operator proxy
// counts them, or DigitalOcean billing reports them (P9). The kind declares no `meters`: kind meters bill an hourly
// rate the provider reports, and a key has none; its tokens reach billing through the proxy's `record`. Shapes follow the API reference (genai), not a recording.
//
// A model access key is an account-wide bearer: it reaches every model and every Dedicated Inference endpoint of the
// account, and a tenant that reads it can call DigitalOcean directly, past the proxy, on the account's bill. So only
// the tenant's own account may have one (`accountScope: 'tenant'`); on a shared account it is refused before any call.

export const inferenceKeyKindName = 'do.inference-key';
/** Tokens a key's inference uses (input and output), counted by the operator proxy or reported by billing. */
export const inferenceTokensMeter = 'ai.inference.tokens';
/** The serverless inference endpoint (OpenAI-compatible) the keys are for. */
export const defaultInferenceEndpoint = 'https://inference.do-ai.run/v1';

interface DoModelKey {
  uuid: string;
  name: string;
  secret_key?: string | null;
  created_at?: string;
}

export interface InferenceKeySpec {
  rotation: number;
}

const base = '/gen-ai/models/api_keys';
const path = (uuid: string) => `${base}/${encodeURIComponent(uuid)}`;
const nameShape = /^(.+)-r([0-9]{1,7})-bc([0-9a-f]{12})$/;

const deploymentHash = (env: DoKindEnv) =>
  env.deploymentTag.slice(env.deploymentTag.indexOf(':') + 1);

/** The base name, applied rotation and deployment hash a key's name carries; undefined for a name of another shape. */
function parse(name: string): { base: string; rotation: number; deployment: string } | undefined {
  const match = nameShape.exec(name ?? '');
  return match ? { base: match[1]!, rotation: Number(match[2]), deployment: match[3]! } : undefined;
}

const nameFor = (env: DoKindEnv, base: string, rotation: number) =>
  `${base}-r${rotation}-bc${deploymentHash(env)}`;

function owner(env: DoKindEnv, key: DoModelKey): 'this' | 'other' | undefined {
  const parsed = parse(key.name);
  if (!parsed) return undefined;
  return parsed.deployment === deploymentHash(env) ? 'this' : 'other';
}

function assertOwned(env: DoKindEnv, key: DoModelKey): void {
  if (owner(env, key) !== 'this')
    throw new ComputeError(
      'INVALID_STATE',
      `Model access key ${key.uuid} is not managed by this better-compute deployment; it is left alone`,
      undefined,
      { provider: 'digitalocean', reason: 'notManaged' },
    );
}

/** Every key of the account (keys are few; there is no single-key read). */
async function* all(
  env: DoKindEnv,
  signal: AbortSignal,
  budget: 'observe' | 'sweep',
): AsyncIterable<DoModelKey> {
  yield* env.client.pages<DoModelKey>(base, 'api_key_infos', { signal, budget });
}

async function byId(env: DoKindEnv, uuid: string, signal: AbortSignal) {
  for await (const key of all(env, signal, 'observe')) if (key.uuid === uuid) return key;
  return undefined;
}

/**
 * The key with this id, and the other keys of this deployment under the same base name: duplicates two racing creates
 * left (model key names are not unique at DigitalOcean), each a live bearer no one sealed. One listing.
 */
async function withDuplicates(env: DoKindEnv, uuid: string, name: string, signal: AbortSignal) {
  let key: DoModelKey | undefined;
  const duplicates: DoModelKey[] = [];
  for await (const entry of all(env, signal, 'observe')) {
    if (entry.uuid === uuid) key = entry;
    else {
      const parsed = parse(entry.name);
      if (parsed?.base === name && parsed.deployment === deploymentHash(env)) duplicates.push(entry);
    }
  }
  return { key, duplicates };
}

/** The oldest key of this deployment under the base name, whatever rotation it carries. */
async function byName(env: DoKindEnv, name: string, signal: AbortSignal) {
  const keys: DoModelKey[] = [];
  for await (const key of all(env, signal, 'observe')) {
    const parsed = parse(key.name);
    if (parsed?.base === name && parsed.deployment === deploymentHash(env)) keys.push(key);
  }
  return keys.sort(
    (a, b) =>
      (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.uuid.localeCompare(b.uuid),
  )[0];
}

function assertTenantAccount(request: Pick<ProviderResourceRequest, 'accountScope'>): void {
  if (request.accountScope !== 'tenant')
    throw new ComputeError(
      'INVALID_INPUT',
      `${inferenceKeyKindName} is a bearer for the whole account; only the tenant's own account may have one`,
      undefined,
      { provider: 'digitalocean', reason: 'accountWide', fields: ['rotation'] },
    );
}

function state(key: DoModelKey, endpoint: string, secret?: string | null): ProviderResourceState {
  const parsed = parse(key.name);
  return {
    id: key.uuid,
    state: 'ready',
    outputs: { endpoint },
    ...(typeof secret === 'string' && secret.length > 0 ? { secretOutputs: { key: secret } } : {}),
    ...(parsed ? { spec: { rotation: parsed.rotation } } : {}),
  };
}

export function inferenceKeyKind(endpoint: string = defaultInferenceEndpoint): DoKind {
  async function regenerate(
    env: DoKindEnv,
    key: DoModelKey,
    name: string,
    context: CallContext,
  ): Promise<ProviderResourceState> {
    // The secret first, the name (the applied rotation) after. A lost regenerate answer leaves the name behind, so the
    // next run regenerates again and no secret that was never sealed stays live. Once the new secret is in hand it is
    // always returned, to be sealed: a failed rename (DigitalOcean may have applied it and lost the answer) answers
    // `updating` with the rotation the name had, so the next run reads the name again and renames (or regenerates
    // and renames) until it is applied; the secret is never dropped while the old one already stopped working.
    const reply = await env.client.request<{ api_key_info: DoModelKey }>(
      'PUT',
      `${path(key.uuid)}/regenerate`,
      { signal: context.signal, budget: 'mutate' },
    );
    const secret = reply.api_key_info.secret_key;
    if (key.name !== name)
      try {
        await env.client.request('PUT', path(key.uuid), {
          body: { name },
          signal: context.signal,
          budget: 'mutate',
        });
      } catch (error) {
        context.log?.warn('digitalocean: a model access key was regenerated but its rename failed', {
          key: key.uuid,
          error: error instanceof Error ? error.message : String(error),
        });
        const behind = state({ ...reply.api_key_info, name: key.name }, endpoint, secret);
        return { ...behind, state: 'updating' };
      }
    return state({ ...reply.api_key_info, name }, endpoint, secret);
  }

  return {
    definition: {
      kind: inferenceKeyKindName,
      family: 'ai',
      description:
        'A DigitalOcean model access key for serverless and dedicated inference; the key is sealed',
      spec: manifest({
        rotation: field
          .int({ min: 0, max: 9_999_999 })
          .default(0)
          .describe('Raise it to regenerate the key (the old one stops working)'),
      }),
      outputs: ['endpoint'],
      secretOutputs: ['key'],
      regional: false,
      updatable: ['rotation'],
      // An account-wide bearer: the tenant's own account only, whatever the spec.
      accountWide: () => ['rotation'],
    },

    async ensure(env, request: ProviderResourceRequest, context) {
      assertTenantAccount(request);
      const wanted = request.spec as InferenceKeySpec;
      const name = nameFor(env, request.name, wanted.rotation);
      if (request.id !== undefined) {
        const { key, duplicates } = await withDuplicates(env, request.id, request.name, context.signal);
        // The key the caller recorded is the one kept: any other of this resource's name is a racing create's.
        for (const duplicate of duplicates)
          await found(() =>
            env.client.request('DELETE', path(duplicate.uuid), {
              signal: context.signal,
              budget: 'mutate',
            }),
          );
        if (!key)
          return {
            id: request.id,
            state: 'error',
            message: `Model access key ${request.id} is gone at DigitalOcean`,
          };
        assertOwned(env, key);
        // The applied rotation, and a key the caller holds sealed: nothing to do. A sealed key that is missing (its
        // seal failed, so the secret DigitalOcean answered is lost) is minted again: the old one stops working.
        const sealed = request.secretOutputs === undefined || request.secretOutputs.includes('key');
        if (parse(key.name)?.rotation === wanted.rotation && sealed) return state(key, endpoint);
        return regenerate(env, key, name, context);
      }
      const existing = await byName(env, request.name, context.signal);
      // The answer of an earlier create was lost: its secret was never sealed, so it is replaced.
      if (existing) return regenerate(env, existing, name, context);
      const created = await env.client.request<{ api_key_info: DoModelKey }>('POST', base, {
        body: { name },
        signal: context.signal,
        budget: 'mutate',
      });
      return state(created.api_key_info, endpoint, created.api_key_info.secret_key);
    },

    // A create whose answer was lost: this deployment's key under the base name, whatever rotation it carries (the
    // stored spec may trail a rotation DigitalOcean applied), as ensure finds it. Read-only, on any account: a
    // teardown never refuses.
    async find(env, request, context) {
      return (await byName(env, request.name, context.signal))?.uuid;
    },

    async get(env, id, context) {
      const key = await byId(env, id, context.signal);
      if (!key) return undefined;
      return { ...state(key, endpoint), managedBy: owner(env, key) ?? 'none' };
    },

    async delete(env, id, context) {
      const key = await byId(env, id, context.signal);
      if (!key) return { id, state: 'deleted' };
      assertOwned(env, key);
      await found(() =>
        env.client.request('DELETE', path(id), { signal: context.signal, budget: 'mutate' }),
      );
      return { id, state: 'deleted' };
    },

    async *discover(env, context): AsyncIterable<ProviderDiscoveredResource> {
      for await (const key of all(env, context.signal, 'sweep')) {
        const by = owner(env, key);
        const parsed = parse(key.name);
        yield {
          id: key.uuid,
          name: key.name,
          ...(by !== undefined ? { managedBy: by } : {}),
          ...(parsed ? { spec: { rotation: parsed.rotation } } : {}),
        };
      }
    },
  };
}
