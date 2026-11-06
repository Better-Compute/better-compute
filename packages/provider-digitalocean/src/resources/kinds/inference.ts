import {
  ComputeError,
  field,
  gpuMeterKey,
  isComputeError,
  manifest,
  type CallContext,
  type ProviderDiscoveredResource,
  type ProviderResourceRequest,
  type ProviderResourceState,
} from '@better-compute/core';
import { keyTag } from '../../ids.js';
import {
  assertOwned,
  found,
  managedBy,
  ownershipTags,
  replaceRequired,
  strings,
  type DoKind,
  type DoKindEnv,
} from '../kind.js';

// Dedicated Inference (`do.dedicated-inference`, P8): a model served on dedicated GPUs of one size, scaled between a
// minimum and a maximum of replicas. Its GPUs are booked against the tenant's GPU quota on the pool (`quota`: GPUs
// per replica times the maximum it may scale to), and it bills GPU hours of the size's model at the replicas in
// service (`usage`, the meters vps bills GPU Droplets on). It is reached with model access keys (`do.inference-key`),
// so it has no secret outputs of its own. Ownership is by tags, idempotency by the key tag (DO-D4, DO-D5); scaling
// changes in place, anything else is a new endpoint. Shapes follow the API reference (dedicated_inference), not a
// recording: the live suite captures real bodies before release.

export const dedicatedInferenceKindName = 'do.dedicated-inference';

/** The GPU sizes an endpoint runs on: the size's GPU model (the inventory's name) and GPUs per replica. */
export const inferenceGpuSizes: Readonly<Record<string, { model: string; gpus: number }>> =
  Object.freeze({
    'gpu-h100x1-80gb': { model: 'H100', gpus: 1 },
    'gpu-h100x8-640gb': { model: 'H100', gpus: 8 },
    'gpu-h200x1-141gb': { model: 'H200', gpus: 1 },
    'gpu-h200x8-1128gb': { model: 'H200', gpus: 8 },
    'gpu-l40sx1-48gb': { model: 'L40S', gpus: 1 },
    'gpu-mi300x1-192gb': { model: 'MI300X', gpus: 1 },
    'gpu-mi300x8-1536gb': { model: 'MI300X', gpus: 8 },
    'gpu-6000adax1-48gb': { model: 'RTX-6000-ADA', gpus: 1 },
    'gpu-4000adax1-20gb': { model: 'RTX-4000-ADA', gpus: 1 },
  });

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const maxReplicas = 16;

export interface DedicatedInferenceSpec {
  region: string;
  model: string;
  gpuSize: string;
  replicas: number;
  maxReplicas?: number;
  vpc?: string;
  publicEndpoint: boolean;
}

interface DoEndpoint {
  id: string;
  name: string;
  region: string;
  model_slug: string;
  gpu_size: string;
  scaling?: { min_replicas?: number; max_replicas?: number; current_replicas?: number } | null;
  public?: boolean;
  vpc_uuid?: string | null;
  status?: string;
  endpoints?: { public_url?: string | null; private_url?: string | null } | null;
  tags?: string[] | null;
  created_at: string;
}

const base = '/dedicated-inferences';
const path = (id: string) => `${base}/${encodeURIComponent(id)}`;

function status(value: string | undefined): ProviderResourceState['state'] {
  switch ((value ?? '').toUpperCase()) {
    case 'ACTIVE':
      return 'ready';
    case 'UPDATING':
    case 'SCALING':
      return 'updating';
    case 'DELETING':
      return 'deleting';
    case 'ERROR':
    case 'FAILED':
      return 'error';
    default:
      return 'pending';
  }
}

/** What the endpoint books: GPUs per replica times the most replicas it may run. */
function quotaOf(spec: unknown): Record<string, number> {
  const wanted = spec as Partial<DedicatedInferenceSpec> | undefined;
  const size = inferenceGpuSizes[wanted?.gpuSize ?? ''];
  if (!size) return {};
  const most = Math.max(wanted?.replicas ?? 1, wanted?.maxReplicas ?? 0);
  return { gpu: size.gpus * most };
}

function specOf(endpoint: DoEndpoint): Record<string, unknown> {
  const min = endpoint.scaling?.min_replicas ?? 1;
  const max = endpoint.scaling?.max_replicas ?? min;
  return {
    region: endpoint.region,
    model: endpoint.model_slug,
    gpuSize: endpoint.gpu_size,
    replicas: min,
    ...(max !== min ? { maxReplicas: max } : {}),
    ...(endpoint.vpc_uuid ? { vpc: endpoint.vpc_uuid } : {}),
    publicEndpoint: endpoint.public !== false,
  };
}

function state(endpoint: DoEndpoint): ProviderResourceState {
  const phase = status(endpoint.status);
  const size = inferenceGpuSizes[endpoint.gpu_size];
  const current = endpoint.scaling?.current_replicas ?? 0;
  return {
    id: endpoint.id,
    state: phase,
    ...(phase === 'error' ? { message: `The endpoint is ${endpoint.status}` } : {}),
    outputs: strings({
      status: endpoint.status,
      endpoint: endpoint.endpoints?.public_url,
      privateEndpoint: endpoint.endpoints?.private_url,
      model: endpoint.model_slug,
      gpuSize: endpoint.gpu_size,
      replicas: phase === 'pending' ? undefined : current,
    }),
    // GPU hours of the size's model at the replicas in service (none while it provisions or goes).
    ...(size
      ? {
          usage: {
            [gpuMeterKey(size.model)]:
              phase === 'ready' || phase === 'updating' ? size.gpus * current : 0,
          },
        }
      : {}),
    spec: specOf(endpoint),
  };
}

async function read(env: DoKindEnv, id: string, signal: AbortSignal) {
  const reply = await found(() =>
    env.client.request<{ dedicated_inference: DoEndpoint }>('GET', path(id), {
      signal,
      budget: 'observe',
    }),
  );
  return reply?.dedicated_inference;
}

/** The oldest endpoint carrying the key's tag that this deployment manages (another deployment's never is ours). */
async function byKey(env: DoKindEnv, context: CallContext): Promise<DoEndpoint | undefined> {
  const reply = await env.client.request<{ dedicated_inferences?: DoEndpoint[] | null }>(
    'GET',
    base,
    {
      query: { tag_name: keyTag(context.idempotencyKey) },
      signal: context.signal,
      budget: 'observe',
    },
  );
  return (reply.dedicated_inferences ?? [])
    .filter((endpoint) => managedBy(env, endpoint.tags) === 'this')
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))[0];
}

function assertReplicas(wanted: DedicatedInferenceSpec): void {
  if (wanted.maxReplicas !== undefined && wanted.maxReplicas < wanted.replicas)
    throw new ComputeError(
      'INVALID_INPUT',
      `${dedicatedInferenceKindName}: maxReplicas (${wanted.maxReplicas}) is below replicas (${wanted.replicas})`,
      undefined,
      { provider: 'digitalocean', reason: 'replicas', fields: ['maxReplicas'] },
    );
}

const meters = [...new Set(Object.values(inferenceGpuSizes).map((size) => size.model))].map(
  (model) => ({ meter: gpuMeterKey(model), unit: 'hour' }),
);

export function dedicatedInferenceKind(): DoKind {
  const what = (id: string) => `Dedicated inference endpoint ${id}`;
  return {
    definition: {
      kind: dedicatedInferenceKindName,
      family: 'ai',
      description:
        'A DigitalOcean Dedicated Inference endpoint: a model on dedicated GPUs, booked against the GPU quota',
      spec: manifest({
        region: field.string({ pattern: /^[a-z]{3}[0-9]$/ }).describe('Region slug, e.g. nyc3'),
        model: field
          .string({ pattern: /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/ })
          .describe('The model to serve: a catalog slug, e.g. llama3.3-70b-instruct'),
        gpuSize: field
          .option(Object.keys(inferenceGpuSizes) as [string, ...string[]])
          .describe('The GPU size of each replica, e.g. gpu-h100x1-80gb'),
        replicas: field
          .int({ min: 1, max: maxReplicas })
          .default(1)
          .describe('Replicas always running (the minimum)'),
        maxReplicas: field
          .int({ min: 1, max: maxReplicas })
          .optional()
          .describe('The most replicas it scales to (default: replicas); its GPUs are booked'),
        vpc: field
          .string({ pattern: uuid })
          .optional()
          .describe(
            "A VPC of the tenant's own account for the private endpoint (refused on a shared account)",
          ),
        publicEndpoint: field
          .boolean()
          .default(true)
          .describe('Serve a public endpoint as well as the private one'),
      }),
      outputs: ['status', 'endpoint', 'privateEndpoint', 'model', 'gpuSize', 'replicas'],
      regional: true,
      updatable: ['replicas', 'maxReplicas'],
      meters,
      accountWide: (spec: unknown) =>
        (spec as Partial<DedicatedInferenceSpec> | undefined)?.vpc !== undefined ? ['vpc'] : [],
      quota: quotaOf,
    },

    async ensure(env, request: ProviderResourceRequest, context) {
      const wanted = request.spec as DedicatedInferenceSpec;
      assertReplicas(wanted);
      let endpoint: DoEndpoint | undefined;
      if (request.id !== undefined) {
        endpoint = await read(env, request.id, context.signal);
        if (!endpoint)
          return {
            id: request.id,
            state: 'error',
            message: `${what(request.id)} is gone at DigitalOcean`,
          };
        assertOwned(env, endpoint.tags, what(endpoint.id));
      } else endpoint = await byKey(env, context);
      if (!endpoint) {
        if (wanted.vpc !== undefined && request.accountScope !== 'tenant')
          throw new ComputeError(
            'INVALID_INPUT',
            `${dedicatedInferenceKindName}: vpc is account-wide; only an endpoint on the tenant's own account may name one`,
            undefined,
            { provider: 'digitalocean', reason: 'accountWide', fields: ['vpc'] },
          );
        try {
          const created = await env.client.request<{ dedicated_inference: DoEndpoint }>(
            'POST',
            base,
            {
              body: {
                name: request.name,
                region: wanted.region,
                model_slug: wanted.model,
                gpu_size: wanted.gpuSize,
                scaling: {
                  min_replicas: wanted.replicas,
                  max_replicas: wanted.maxReplicas ?? wanted.replicas,
                },
                public: wanted.publicEndpoint !== false,
                ...(wanted.vpc !== undefined ? { vpc_uuid: wanted.vpc } : {}),
                tags: ownershipTags(env, request.labels, context),
              },
              signal: context.signal,
              budget: 'mutate',
            },
          );
          return state(created.dedicated_inference);
        } catch (error) {
          // The name is taken: a racing create of ours made it (its key tag finds it), or it is someone else's.
          if (!isComputeError(error, 'CONFLICT')) throw error;
          endpoint = await byKey(env, context);
          if (!endpoint) throw error;
        }
      }
      const have = specOf(endpoint);
      for (const fixed of ['region', 'model', 'gpuSize', 'vpc'] as const)
        if ((wanted[fixed] ?? undefined) !== (have[fixed] ?? undefined))
          throw replaceRequired(dedicatedInferenceKindName, fixed);
      if ((wanted.publicEndpoint !== false) !== (endpoint.public !== false))
        throw replaceRequired(dedicatedInferenceKindName, 'publicEndpoint');
      const min = wanted.replicas;
      const max = wanted.maxReplicas ?? wanted.replicas;
      if (min === endpoint.scaling?.min_replicas && max === endpoint.scaling?.max_replicas)
        return state(endpoint);
      // One scaling change at a time: while the endpoint provisions or scales, it is looked at again later.
      if (status(endpoint.status) !== 'ready') return state(endpoint);
      const updated = await env.client.request<{ dedicated_inference: DoEndpoint }>(
        'PATCH',
        path(endpoint.id),
        {
          body: { scaling: { min_replicas: min, max_replicas: max } },
          signal: context.signal,
          budget: 'mutate',
        },
      );
      return { ...state(updated.dedicated_inference), state: 'updating' };
    },

    async get(env, id, context) {
      const endpoint = await read(env, id, context.signal);
      if (!endpoint) return undefined;
      return { ...state(endpoint), managedBy: managedBy(env, endpoint.tags) ?? 'none' };
    },

    async delete(env, id, context) {
      const endpoint = await read(env, id, context.signal);
      if (!endpoint) return { id, state: 'deleted' };
      assertOwned(env, endpoint.tags, what(id));
      if (status(endpoint.status) === 'deleting') return { id, state: 'deleting' };
      await found(() =>
        env.client.request('DELETE', path(id), { signal: context.signal, budget: 'mutate' }),
      );
      return { id, state: 'deleting' };
    },

    async *discover(env, context): AsyncIterable<ProviderDiscoveredResource> {
      for await (const endpoint of env.client.pages<DoEndpoint>(base, 'dedicated_inferences', {
        signal: context.signal,
        budget: 'sweep',
      })) {
        const owner = managedBy(env, endpoint.tags);
        yield {
          id: endpoint.id,
          name: endpoint.name,
          region: endpoint.region,
          ...(owner !== undefined ? { managedBy: owner } : {}),
          spec: specOf(endpoint),
        };
      }
    },
  };
}
