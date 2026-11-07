import { randomUUID } from 'node:crypto';
import type { DoEmulator, RouteContext } from './index.js';
import { touchTags, hasTag } from './tags.js';
import type { DoState, Json } from './state.js';

// Dedicated Inference endpoints (the AI platform's model serving on dedicated GPUs). Shapes follow the API reference,
// not a recording: the live suite captures real bodies before release. A new endpoint is `PROVISIONING` for
// `emulator.inferenceReads` reads, then `ACTIVE` with its replicas at the minimum; a scaling change is `UPDATING` as
// long; a deleted one is `DELETING` as long, then gone. Names are unique per account (a second create under one is the
// name-in-use 422). A GPU size listed in `emulator.inferenceSoldOut` answers the insufficient-capacity 422.

const gpuSizes = new Set([
  'gpu-h100x1-80gb',
  'gpu-h100x8-640gb',
  'gpu-h200x1-141gb',
  'gpu-h200x8-1128gb',
  'gpu-l40sx1-48gb',
  'gpu-mi300x1-192gb',
  'gpu-mi300x8-1536gb',
  'gpu-6000adax1-48gb',
  'gpu-4000adax1-20gb',
]);

function body(endpoint: Json): Json {
  const { _reads, ...rest } = endpoint;
  return structuredClone(rest);
}

function observe(emulator: DoEmulator, state: DoState, endpoint: Json): void {
  if (!['PROVISIONING', 'UPDATING', 'DELETING'].includes(endpoint.status)) return;
  endpoint._reads = (endpoint._reads ?? 0) + 1;
  if (endpoint._reads <= emulator.inferenceReads) return;
  endpoint._reads = 0;
  if (endpoint.status === 'DELETING') {
    state.dedicatedInferences.delete(endpoint.id);
    return;
  }
  endpoint.status = 'ACTIVE';
  endpoint.scaling.current_replicas = endpoint.scaling.min_replicas;
  endpoint.endpoints.public_url = endpoint.public
    ? `https://${endpoint.id}.inference.do-ai.run`
    : null;
  endpoint.endpoints.private_url = `https://${endpoint.id}.private.inference.do-ai.run`;
}

/** Seeds an endpoint made outside better-compute (active). */
export function seedEndpoint(state: DoState, fields: Json = {}): Json {
  const id = randomUUID();
  const endpoint: Json = {
    id,
    name: `by-hand-${id.slice(0, 6)}`,
    region: 'nyc3',
    model_slug: 'llama3.3-70b-instruct',
    gpu_size: 'gpu-h100x1-80gb',
    scaling: { min_replicas: 1, max_replicas: 1, current_replicas: 1 },
    public: true,
    vpc_uuid: null,
    status: 'ACTIVE',
    endpoints: {
      public_url: `https://${id}.inference.do-ai.run`,
      private_url: `https://${id}.private.inference.do-ai.run`,
    },
    tags: [],
    created_at: new Date(state.now()).toISOString(),
    ...fields,
  };
  state.dedicatedInferences.set(id, endpoint);
  return endpoint;
}

const of = (context: RouteContext) =>
  context.state.dedicatedInferences.get(decodeURIComponent(context.match[1]!));

const replicas = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 1;

export function registerInference(emulator: DoEmulator): void {
  const list = /^\/dedicated-inferences$/;
  const one = /^\/dedicated-inferences\/([^/]+)$/;

  emulator.route('GET', list, (context) => {
    for (const endpoint of [...context.state.dedicatedInferences.values()])
      observe(emulator, context.state, endpoint);
    const tag = context.url.searchParams.get('tag_name');
    const items = [...context.state.dedicatedInferences.values()].filter(
      (endpoint) => tag === null || hasTag(endpoint, tag),
    );
    return emulator.paged(context, 'dedicated_inferences', items.map(body));
  });

  emulator.route('POST', list, (context) => {
    const input = context.body ?? {};
    const scaling = input.scaling ?? {};
    if (
      typeof input.name !== 'string' ||
      typeof input.region !== 'string' ||
      typeof input.model_slug !== 'string' ||
      !gpuSizes.has(input.gpu_size) ||
      !replicas(scaling.min_replicas) ||
      !replicas(scaling.max_replicas) ||
      scaling.max_replicas < scaling.min_replicas
    )
      return emulator.error('422-unknown');
    if (emulator.inferenceSoldOut.has(input.gpu_size))
      return emulator.error('422-insufficient-capacity');
    if ([...context.state.dedicatedInferences.values()].some((e) => e.name === input.name))
      return emulator.error('422-name-in-use');
    const tags = Array.isArray(input.tags) ? (input.tags as string[]) : [];
    touchTags(context.state, tags);
    const endpoint = seedEndpoint(context.state, {
      name: input.name,
      region: input.region,
      model_slug: input.model_slug,
      gpu_size: input.gpu_size,
      scaling: {
        min_replicas: scaling.min_replicas,
        max_replicas: scaling.max_replicas,
        current_replicas: 0,
      },
      public: input.public !== false,
      vpc_uuid: typeof input.vpc_uuid === 'string' ? input.vpc_uuid : null,
      status: 'PROVISIONING',
      endpoints: { public_url: null, private_url: null },
      tags,
    });
    return { status: 201, body: { dedicated_inference: body(endpoint) } };
  });

  emulator.route('GET', one, (context) => {
    const endpoint = of(context);
    if (!endpoint) return emulator.error('not-found');
    observe(emulator, context.state, endpoint);
    if (!context.state.dedicatedInferences.has(endpoint.id)) return emulator.error('not-found');
    return { status: 200, body: { dedicated_inference: body(endpoint) } };
  });

  emulator.route('PATCH', one, (context) => {
    const endpoint = of(context);
    if (!endpoint) return emulator.error('not-found');
    const scaling = context.body?.scaling ?? {};
    if (
      !replicas(scaling.min_replicas) ||
      !replicas(scaling.max_replicas) ||
      scaling.max_replicas < scaling.min_replicas ||
      Object.keys(context.body ?? {}).some((key) => key !== 'scaling')
    )
      return emulator.error('422-unknown');
    if (endpoint.status !== 'ACTIVE') return emulator.error('422-unknown');
    endpoint.scaling.min_replicas = scaling.min_replicas;
    endpoint.scaling.max_replicas = scaling.max_replicas;
    endpoint.status = 'UPDATING';
    endpoint._reads = 0;
    return { status: 200, body: { dedicated_inference: body(endpoint) } };
  });

  emulator.route('DELETE', one, (context) => {
    const endpoint = of(context);
    if (!endpoint) return emulator.error('not-found');
    endpoint.status = 'DELETING';
    endpoint._reads = 0;
    return { status: 204 };
  });
}
