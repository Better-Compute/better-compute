import { ComputeClientError } from '@better-compute/client';

// The §9.3 MCP tools. Each is a thin, validated call to one compute API route as the caller: the
// compute server makes the real IAM decision, so a tool never grants more than the caller has.

/** The part of a compute client the tools use (`createComputeClient()` satisfies it). */
export interface ComputeApi {
  $request<Output = unknown>(path: string, input?: unknown): Promise<Output>;
}

/** A JSON Schema subset: what the tools declare and `validateArguments` checks. */
export interface JsonSchema {
  type: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: readonly (string | number)[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  items?: JsonSchema;
  maxItems?: number;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** How a tool waits for a person to confirm a held-back action (§3.4 step 7, delegated agents). */
export interface ConfirmationPolling {
  /** Asks better-iam for the confirmation's state (e.g. `delegations.getConfirmation`). */
  status(confirmationId: string): Promise<'pending' | 'approved' | 'denied' | 'expired'>;
  /** How long a tool call waits for an answer before telling the model to retry later (default 25 s). */
  timeoutMs?: number;
  /** Poll interval (default 2 s). */
  intervalMs?: number;
}

export interface ToolContext {
  api: ComputeApi;
  /** The tenant the caller acts in. */
  tenantId: string;
  confirmations?: ConfirmationPolling;
  /** Idempotency keys for tools that create things (overridable for tests). */
  newKey(): string;
  sleep(ms: number): Promise<void>;
}

export interface ComputeTool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: ToolAnnotations;
  run(args: Record<string, unknown>, context: ToolContext): Promise<unknown>;
}

const id = (prefix: string, description: string): JsonSchema => ({
  type: 'string',
  pattern: `^${prefix}_[0-9a-z]{26,52}$`,
  description,
});
const duration: JsonSchema = {
  type: 'string',
  pattern: '^\\d+(ms|s|m|h|d)$',
  description: 'How long, e.g. "30m", "8h", "3d"',
};
const idempotencyKey: JsonSchema = {
  type: 'string',
  pattern: '^[A-Za-z0-9._:-]{1,128}$',
  description:
    'Reuse the key a previous call returned to retry the same request (after a confirmation, a timeout or an error); omit it for a new request',
};
const selector: JsonSchema = {
  type: 'array',
  maxItems: 32,
  description:
    'Extra device constraints: [{ key, op, values }] with op In, NotIn, Exists, DoesNotExist, Gt, Gte, Lt or Lte, e.g. { key: "vramGiB", op: "Gte", values: [80] }',
  items: {
    type: 'object',
    required: ['key', 'op'],
    properties: {
      key: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9._/-]{0,127}$' },
      op: {
        type: 'string',
        enum: ['In', 'NotIn', 'Exists', 'DoesNotExist', 'Gt', 'Gte', 'Lt', 'Lte'],
      },
      values: { type: 'array', maxItems: 64 },
    },
  },
};

function deviceRequest(args: Record<string, unknown>) {
  const expressions: Record<string, unknown>[] = [
    ...((args.selector as Record<string, unknown>[]) ?? []),
  ];
  if (args.gpuModel) expressions.push({ key: 'gpuModel', op: 'In', values: [args.gpuModel] });
  if (args.gpuProduct) expressions.push({ key: 'gpuProduct', op: 'In', values: [args.gpuProduct] });
  return {
    class: 'gpu',
    count: args.gpus,
    ...(expressions.length ? { selector: { matchExpressions: expressions } } : {}),
    ...(args.nvlink ? { topology: 'nvlink-all' } : {}),
  };
}

const reservationShape: Record<string, JsonSchema> = {
  poolId: id('pool', 'The pool to reserve from (list_pools shows the pools you can use)'),
  gpus: { type: 'integer', minimum: 1, maximum: 64, description: 'Whole GPUs' },
  duration,
  gpuModel: { type: 'string', maxLength: 64, description: 'GPU model family, e.g. "H100"' },
  gpuProduct: { type: 'string', maxLength: 64, description: 'GPU product, e.g. "H100-SXM5-80GB"' },
  nvlink: { type: 'boolean', description: 'All GPUs must share one NVLink domain' },
  selector,
};

/** Retries `call` after a person approves a held-back action, with the same idempotency key. */
async function withConfirmation(
  context: ToolContext,
  key: string,
  call: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof ComputeClientError) || error.code !== 'CONFIRMATION_REQUIRED')
      throw error;
    const confirmationId = String(error.details?.confirmationId ?? '');
    const pending = {
      status: 'confirmation-required',
      confirmationId,
      idempotencyKey: key,
      message:
        'A person must approve this action. Once they have, call the tool again with the same idempotencyKey.',
    };
    const polling = context.confirmations;
    if (!polling || !confirmationId) return pending;
    const deadline = Date.now() + (polling.timeoutMs ?? 25_000);
    while (Date.now() < deadline) {
      const state = await polling.status(confirmationId);
      if (state === 'approved') return call();
      if (state === 'denied' || state === 'expired')
        return { status: `confirmation-${state}`, confirmationId, idempotencyKey: key };
      await context.sleep(polling.intervalMs ?? 2000);
    }
    return pending;
  }
}

/** A fleet plan without its call list: what a model needs to explain a change to a person. */
function planView(plan: unknown): unknown {
  if (typeof plan !== 'object' || plan === null) return plan;
  const { calls, ...rest } = plan as { calls?: unknown[] } & Record<string, unknown>;
  return { ...rest, callCount: Array.isArray(calls) ? calls.length : 0 };
}

/**
 * The tools of PLAN.md §9.3. `exec_command` and the read-only fleet tools (`fleet_export`,
 * `fleet_plan`) are only built when asked for. There is deliberately no fleet apply tool: a person
 * applies a reviewed plan (`better-compute fleet apply --plan-hash`).
 */
export function computeTools(
  options: { execCommand?: boolean; fleet?: boolean } = {},
): ComputeTool[] {
  const tools: ComputeTool[] = [
    {
      name: 'list_pools',
      title: 'List GPU pools',
      description:
        'Lists the pools this tenant owns or is offered: site, GPU model, sharing, and whether it is owned or offered. Start here to find a poolId.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: (_args, context) => context.api.$request('pools/list', { tenantId: context.tenantId }),
    },
    {
      name: 'capacity_summary',
      title: 'Show GPU capacity',
      description:
        'Shows total, allocated, reserved and available GPUs per pool and per GPU model, or for one pool when poolId is given.',
      inputSchema: {
        type: 'object',
        properties: { poolId: id('pool', 'Only this pool') },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: (args, context) =>
        args.poolId
          ? context.api.$request('capacity/byPool', {
              tenantId: context.tenantId,
              poolId: args.poolId,
            })
          : context.api.$request('capacity/summary', { tenantId: context.tenantId }),
    },
    {
      name: 'preview_reservation',
      title: 'Preview a GPU reservation',
      description:
        'Checks where a reservation would fit right now, without booking anything: whether it fits, candidate nodes, or why nothing fits.',
      inputSchema: {
        type: 'object',
        required: ['poolId', 'gpus', 'duration'],
        properties: reservationShape,
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: (args, context) =>
        context.api.$request('capacity/preview', {
          tenantId: context.tenantId,
          poolId: args.poolId,
          devices: [deviceRequest(args)],
          duration: args.duration,
          binding: 'hold',
          idempotencyKey: context.newKey(),
        }),
    },
    {
      name: 'reserve_gpus',
      title: 'Reserve GPUs',
      description:
        'Reserves whole GPUs from a pool for a duration. The result includes the reservation id and, once active, the booked GPU UUIDs. If a person must approve it, the result says so: retry with the returned idempotencyKey after they do. Always pass the idempotencyKey from an earlier attempt when retrying.',
      inputSchema: {
        type: 'object',
        required: ['poolId', 'gpus', 'duration'],
        properties: {
          ...reservationShape,
          idempotencyKey,
          waitSeconds: {
            type: 'integer',
            minimum: 0,
            maximum: 30,
            description: 'How long to wait for placement (default 20)',
          },
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async run(args, context) {
        const key = (args.idempotencyKey as string | undefined) ?? context.newKey();
        const reservation = await withConfirmation(context, key, () =>
          context.api.$request('reservations/create', {
            tenantId: context.tenantId,
            poolId: args.poolId,
            devices: [deviceRequest(args)],
            duration: args.duration,
            binding: 'hold',
            idempotencyKey: key,
            wait: { timeoutMs: ((args.waitSeconds as number | undefined) ?? 20) * 1000 },
          }),
        );
        return { idempotencyKey: key, reservation };
      },
    },
    {
      name: 'release_reservation',
      title: 'Release a reservation',
      description:
        'Ends a reservation now and returns its GPUs to the pool; billing stops at release.',
      inputSchema: {
        type: 'object',
        required: ['reservationId'],
        properties: { reservationId: id('rsv', 'The reservation to release') },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      run: (args, context) =>
        context.api.$request('reservations/release', {
          tenantId: context.tenantId,
          reservationId: args.reservationId,
        }),
    },
    {
      name: 'list_reservations',
      title: 'List reservations',
      description:
        'Lists reservations in this tenant: your own by default, or every one you may see with scope "all". Filter by state or pool; pass the returned cursor for the next page.',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['mine', 'all'], description: 'Default mine' },
          state: {
            type: 'string',
            enum: [
              'awaiting-confirmation',
              'pending',
              'placed',
              'binding',
              'active',
              'releasing',
              'released',
              'failed',
              'cancelled',
              'expired',
            ],
            description: 'Only reservations in this state',
          },
          poolId: id('pool', 'Only this pool'),
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 200,
            description: 'Page size (default 50)',
          },
          cursor: id('rsv', 'The cursor a previous page returned'),
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: (args, context) =>
        context.api.$request('reservations/list', { tenantId: context.tenantId, ...args }),
    },
    {
      name: 'get_reservation',
      title: 'Show a reservation',
      description:
        'Shows one reservation: state, pool, devices, start and end, and once active the booked GPU UUIDs and CDI device names.',
      inputSchema: {
        type: 'object',
        required: ['reservationId'],
        properties: { reservationId: id('rsv', 'The reservation') },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: (args, context) =>
        context.api.$request('reservations/get', {
          tenantId: context.tenantId,
          reservationId: args.reservationId,
        }),
    },
    {
      name: 'extend_reservation',
      title: 'Extend a reservation',
      description:
        'Extends a placed or active reservation by a duration. The result says whether it was extended, or until when it can be (another booking follows). If a person must approve it, retry with the returned idempotencyKey after they do.',
      inputSchema: {
        type: 'object',
        required: ['reservationId', 'by'],
        properties: {
          reservationId: id('rsv', 'The reservation to extend'),
          by: duration,
          idempotencyKey,
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async run(args, context) {
        const key = (args.idempotencyKey as string | undefined) ?? context.newKey();
        const extension = await withConfirmation(context, key, () =>
          context.api.$request('reservations/extend', {
            tenantId: context.tenantId,
            reservationId: args.reservationId,
            by: args.by,
            idempotencyKey: key,
          }),
        );
        return { idempotencyKey: key, extension };
      },
    },
    {
      name: 'node_status',
      title: 'Show a node',
      description:
        'Shows one node: provisioning state, connectivity, cordon and maintenance, conditions and GPUs.',
      inputSchema: {
        type: 'object',
        required: ['nodeId'],
        properties: { nodeId: id('node', 'The node') },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: (args, context) =>
        context.api.$request('nodes/get', { tenantId: context.tenantId, nodeId: args.nodeId }),
    },
    {
      name: 'run_diagnostic',
      title: 'Run a GPU diagnostic',
      description:
        'Runs a read-only diagnostic on a node (diag.nvml: GPU inventory, health and ECC counters) and returns the command, whose result arrives when it finishes.',
      inputSchema: {
        type: 'object',
        required: ['nodeId'],
        properties: {
          nodeId: id('node', 'The node'),
          kind: {
            type: 'string',
            enum: ['diag.nvml'],
            description: 'The diagnostic (default diag.nvml)',
          },
          idempotencyKey,
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      run: (args, context) =>
        context.api.$request('commands/run', {
          tenantId: context.tenantId,
          nodeId: args.nodeId,
          kind: args.kind ?? 'diag.nvml',
          idempotencyKey: args.idempotencyKey ?? context.newKey(),
        }),
    },
    {
      name: 'create_instance',
      title: 'Create a VPS instance',
      description:
        'Creates a virtual machine from a flavor and an image in a pool (v0.3). If a person must approve it, retry with the returned idempotencyKey after they do.',
      inputSchema: {
        type: 'object',
        required: ['poolId', 'flavor', 'imageId'],
        properties: {
          poolId: id('pool', 'The pool'),
          flavor: {
            type: 'string',
            pattern: '^[a-z0-9][a-z0-9._-]{0,62}$',
            description: 'The flavor (size) name offered by the pool, e.g. "g1.small"',
          },
          imageId: {
            type: 'string',
            pattern: '^[A-Za-z0-9][A-Za-z0-9._@:/-]{0,199}$',
            description: 'The image, e.g. "ubuntu-24.04"',
          },
          sshKeys: {
            type: 'array',
            maxItems: 32,
            items: { type: 'string', maxLength: 8192, description: 'An OpenSSH public key line' },
            description: 'Public keys to install for the default user',
          },
          idempotencyKey,
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async run(args, context) {
        const key = (args.idempotencyKey as string | undefined) ?? context.newKey();
        const instance = await withConfirmation(context, key, () =>
          context.api.$request('instances/create', {
            tenantId: context.tenantId,
            poolId: args.poolId,
            flavor: args.flavor,
            imageId: args.imageId,
            ...(args.sshKeys ? { sshKeys: args.sshKeys } : {}),
            idempotencyKey: key,
          }),
        );
        return { idempotencyKey: key, instance };
      },
    },
    {
      name: 'list_instances',
      title: 'List VPS instances',
      description:
        'Lists VPS instances in this tenant: your own by default, or every one you may see with scope "all". Filter by pool; pass the returned cursor for the next page.',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['mine', 'all'], description: 'Default mine' },
          poolId: id('pool', 'Only this pool'),
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Page size' },
          cursor: id('inst', 'The cursor a previous page returned'),
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: (args, context) =>
        context.api.$request('instances/list', { tenantId: context.tenantId, ...args }),
    },
    ...(['get', 'start', 'stop', 'delete'] as const).map(
      (verb): ComputeTool => ({
        name: `${verb}_instance`,
        title: {
          get: 'Show a VPS instance',
          start: 'Start a VPS instance',
          stop: 'Stop a VPS instance',
          delete: 'Delete a VPS instance',
        }[verb],
        description: {
          get: 'Shows one instance: state, flavor, image, addresses and conditions.',
          start: 'Starts a stopped instance; it runs again with the same disk and addresses.',
          stop: 'Stops an instance (a graceful shutdown); its disk and addresses are kept.',
          delete:
            'Deletes an instance and its disk for good, and returns its capacity and addresses to the pool.',
        }[verb],
        inputSchema: {
          type: 'object',
          required: ['instanceId'],
          properties: { instanceId: id('inst', 'The instance') },
          additionalProperties: false,
        },
        annotations:
          verb === 'get'
            ? { readOnlyHint: true, openWorldHint: false }
            : {
                readOnlyHint: false,
                destructiveHint: verb !== 'start',
                idempotentHint: true,
                openWorldHint: false,
              },
        run: (args, context) =>
          context.api.$request(`instances/${verb}`, {
            tenantId: context.tenantId,
            instanceId: args.instanceId,
          }),
      }),
    ),
  ];
  if (options.execCommand)
    tools.push({
      name: 'exec_command',
      title: 'Run a node command',
      description:
        'Runs an allowlisted command on a node: inventory.refresh, logs.collect or node.reboot. node.reboot restarts the machine.',
      inputSchema: {
        type: 'object',
        required: ['nodeId', 'kind'],
        properties: {
          nodeId: id('node', 'The node'),
          kind: { type: 'string', enum: ['inventory.refresh', 'logs.collect', 'node.reboot'] },
          idempotencyKey,
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      run: (args, context) =>
        context.api.$request('commands/run', {
          tenantId: context.tenantId,
          nodeId: args.nodeId,
          kind: args.kind,
          idempotencyKey: args.idempotencyKey ?? context.newKey(),
        }),
    });
  if (options.fleet)
    tools.push(
      {
        name: 'fleet_export',
        title: 'Export the fleet configuration',
        description:
          "Returns the tenant's platform configuration as a FleetConfig document: sites, provider accounts, pools with owner quotas and offers to other tenants, and VPS flavors, keyed by name. Start here before proposing a change.",
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
        run: (_args, context) =>
          context.api.$request('fleet/export', { tenantId: context.tenantId }),
      },
      {
        name: 'fleet_plan',
        title: 'Plan a fleet configuration change',
        description:
          'Diffs a FleetConfig document (fleet_export returns one) against the current fleet and lists each change: create, update (with fields), delete (only with prune) or blocked (with the reason). It changes nothing. To apply, give a person the document and the returned planHash to run `better-compute fleet apply FILE --plan-hash HASH`.',
        inputSchema: {
          type: 'object',
          required: ['config'],
          properties: {
            config: {
              type: 'object',
              description: 'The whole FleetConfig document ({ version: 1, sites, pools, … })',
            },
            prune: {
              type: 'boolean',
              description: 'Also plan deletes for what the document no longer lists',
            },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
        run: async (args, context) =>
          planView(
            await context.api.$request('fleet/plan', {
              tenantId: context.tenantId,
              config: args.config,
              prune: args.prune === true,
            }),
          ),
      },
    );
  return tools;
}

/** Checks arguments against a tool's schema; returns the first problem, or undefined. */
export function validateArguments(
  schema: JsonSchema,
  value: unknown,
  path = 'arguments',
): string | undefined {
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        return `${path} must be an object`;
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? [])
        if (record[key] === undefined) return `${path}.${key} is required`;
      for (const [key, item] of Object.entries(record)) {
        const property = schema.properties?.[key];
        if (!property) {
          if (schema.additionalProperties === false)
            return `${path}.${key} is not a known argument`;
          continue;
        }
        if (item === undefined) continue;
        const problem = validateArguments(property, item, `${path}.${key}`);
        if (problem) return problem;
      }
      return undefined;
    }
    case 'array': {
      if (!Array.isArray(value)) return `${path} must be an array`;
      if (schema.maxItems !== undefined && value.length > schema.maxItems)
        return `${path} has more than ${schema.maxItems} items`;
      if (schema.items)
        for (const [index, item] of value.entries()) {
          const problem = validateArguments(schema.items, item, `${path}[${index}]`);
          if (problem) return problem;
        }
      return undefined;
    }
    case 'string': {
      if (typeof value !== 'string') return `${path} must be a string`;
      if (schema.enum && !schema.enum.includes(value))
        return `${path} must be one of ${schema.enum.join(', ')}`;
      if (schema.pattern && !new RegExp(schema.pattern).test(value))
        return `${path} is not in the expected form`;
      if (schema.maxLength !== undefined && value.length > schema.maxLength)
        return `${path} is too long`;
      if (schema.minLength !== undefined && value.length < schema.minLength)
        return `${path} is too short`;
      return undefined;
    }
    case 'integer':
    case 'number': {
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (schema.type === 'integer' && !Number.isInteger(value))
      )
        return `${path} must be ${schema.type === 'integer' ? 'an integer' : 'a number'}`;
      if (schema.minimum !== undefined && value < schema.minimum)
        return `${path} must be at least ${schema.minimum}`;
      if (schema.maximum !== undefined && value > schema.maximum)
        return `${path} must be at most ${schema.maximum}`;
      return undefined;
    }
    case 'boolean':
      return typeof value === 'boolean' ? undefined : `${path} must be true or false`;
  }
}
