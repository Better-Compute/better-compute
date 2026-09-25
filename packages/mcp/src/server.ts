import { ComputeClientError, createComputeClient } from '@better-compute/client';
import {
  computeTools,
  validateArguments,
  type ComputeApi,
  type ComputeTool,
  type ConfirmationPolling,
  type ToolContext,
} from './tools.js';

/** MCP revisions this server speaks, newest first. */
export const supportedProtocolVersions = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** What the gate (or your own auth) knows about the caller: `@better-iam/mcp`'s `McpCaller` fits. */
export interface McpCallerLike {
  kind: string;
  tenantId?: string;
  identityId?: string;
}

export interface ComputeMcpOptions {
  /**
   * How tools reach compute: a fixed client, or a factory per request. By default, with `baseURL`,
   * each request gets a client that forwards the caller's own `Authorization` header, so compute
   * authorizes every call as the caller.
   */
  client?: ComputeApi | ((request: Request, caller?: McpCallerLike) => ComputeApi);
  baseURL?: string;
  basePath?: string;
  /** The tenant tools act in: fixed, or chosen per caller (default: the caller's `tenantId`). */
  tenantId?: string | ((caller?: McpCallerLike) => string | undefined);
  /** Build `exec_command` (off by default: node commands through a model need a deliberate choice). */
  execCommand?: boolean;
  /** Build the read-only `fleet_export` and `fleet_plan` tools (off by default; platform admins only). */
  fleet?: boolean;
  /**
   * Wait for people to approve held-back actions inside the tool call (see `ConfirmationPolling`):
   * fixed, or per request so the poll runs with the caller's credential (`iamConfirmations`).
   */
  confirmations?:
    | ConfirmationPolling
    | ((request: Request, caller?: McpCallerLike) => ConfirmationPolling | undefined);
  serverInfo?: { name: string; version: string };
  /** Shown to the model at initialize. */
  instructions?: string;
  /** Largest request body (default 1 MiB). */
  maxBodyBytes?: number;
  newKey?: () => string;
}

export interface CallToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ComputeMcp {
  readonly tools: readonly ComputeTool[];
  /** The `tools/list` entries. */
  listTools(): {
    name: string;
    title: string;
    description: string;
    inputSchema: unknown;
    annotations: unknown;
  }[];
  /** Runs one tool as `callTool` would over MCP. */
  callTool(
    name: string,
    args: unknown,
    request: Request,
    caller?: McpCallerLike,
  ): Promise<CallToolResult>;
  /**
   * A Streamable HTTP MCP endpoint (stateless, JSON responses): `handler(request, caller?)`. Put
   * `@better-iam/mcp`'s gate in front: `gate(request, (forwarded, caller) => mcp.handler(forwarded, caller))`.
   */
  handler(request: Request, caller?: McpCallerLike): Promise<Response>;
}

const defaultInstructions =
  'Tools for GPU capacity on better-compute. Find pools with list_pools and capacity_summary, check fit with preview_reservation, then reserve_gpus. When a result says a person must approve, wait, then call the same tool again with the idempotencyKey it returned. Release reservations you no longer need.';

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `mcp-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function toolResult(value: unknown): CallToolResult {
  const structured =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { result: value };
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: structured,
  };
}

function errorResult(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): CallToolResult {
  return {
    content: [{ type: 'text', text: `${code}: ${message}` }],
    structuredContent: { error: { code, message, ...extra } },
    isError: true,
  };
}

/**
 * The better-compute MCP server (PLAN.md §9.3): the §9.3 tools over the compute API, answered as a
 * stateless Streamable HTTP endpoint. It has no MCP SDK dependency: it speaks JSON-RPC 2.0 for
 * `initialize`, `ping`, `tools/list` and `tools/call` and accepts notifications.
 */
export function createComputeMcp(options: ComputeMcpOptions): ComputeMcp {
  if (!options.client && !options.baseURL)
    throw new Error('createComputeMcp needs client or baseURL');
  const tools = computeTools({
    execCommand: options.execCommand ?? false,
    fleet: options.fleet ?? false,
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const serverInfo = options.serverInfo ?? { name: 'better-compute', version: '0.1.0' };

  const apiFor = (request: Request, caller?: McpCallerLike): ComputeApi => {
    if (typeof options.client === 'function') return options.client(request, caller);
    if (options.client) return options.client;
    const authorization = request.headers.get('authorization');
    return createComputeClient({
      baseURL: options.baseURL!,
      ...(options.basePath ? { basePath: options.basePath } : {}),
      ...(authorization ? { headers: { authorization } } : {}),
      requestId: true,
    });
  };
  const tenantFor = (caller?: McpCallerLike): string | undefined =>
    typeof options.tenantId === 'function'
      ? options.tenantId(caller)
      : (options.tenantId ?? caller?.tenantId);

  const callTool: ComputeMcp['callTool'] = async (name, args, request, caller) => {
    const tool = byName.get(name);
    if (!tool) return errorResult('UNKNOWN_TOOL', `No tool named ${name}`);
    const input = args ?? {};
    const problem = validateArguments(tool.inputSchema, input);
    if (problem) return errorResult('INVALID_INPUT', problem);
    const tenantId = tenantFor(caller);
    if (!tenantId) return errorResult('ACCESS_DENIED', 'No tenant to act in');
    const confirmations =
      typeof options.confirmations === 'function'
        ? options.confirmations(request, caller)
        : options.confirmations;
    const context: ToolContext = {
      api: apiFor(request, caller),
      tenantId,
      newKey: options.newKey ?? randomKey,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      ...(confirmations ? { confirmations } : {}),
    };
    try {
      return toolResult(await tool.run(input as Record<string, unknown>, context));
    } catch (error) {
      if (error instanceof ComputeClientError)
        return errorResult(error.code, error.message, {
          ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
          ...(error.details ? { details: error.details } : {}),
        });
      return errorResult('INTERNAL_ERROR', 'The tool failed; try again later');
    }
  };

  const listTools = () =>
    tools.map(({ name, title, description, inputSchema, annotations }) => ({
      name,
      title,
      description,
      inputSchema,
      annotations: { title, ...annotations },
    }));

  const rpcError = (id: unknown, code: number, message: string, status = 200) =>
    Response.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, { status });

  return {
    tools,
    listTools,
    callTool,
    async handler(request, caller) {
      if (request.method !== 'POST')
        return new Response('This MCP endpoint takes JSON-RPC over POST only', {
          status: 405,
          headers: { allow: 'POST' },
        });
      if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json'))
        return rpcError(null, -32700, 'Expected application/json', 415);
      const text = await request.text();
      if (text.length > maxBodyBytes) return rpcError(null, -32600, 'Request too large', 413);
      let message: {
        jsonrpc?: unknown;
        id?: unknown;
        method?: unknown;
        params?: Record<string, unknown>;
      };
      try {
        message = JSON.parse(text);
      } catch {
        return rpcError(null, -32700, 'Parse error', 400);
      }
      if (Array.isArray(message)) return rpcError(null, -32600, 'Batches are not supported', 400);
      if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string')
        return rpcError(message?.id, -32600, 'Invalid request', 400);
      // Notifications and client responses get 202 and no body.
      if (message.id === undefined) return new Response(null, { status: 202 });
      const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: message.id, result });
      switch (message.method) {
        case 'initialize': {
          const asked = String(message.params?.protocolVersion ?? '');
          const protocolVersion = (supportedProtocolVersions as readonly string[]).includes(asked)
            ? asked
            : supportedProtocolVersions[0];
          return reply({
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo,
            instructions: options.instructions ?? defaultInstructions,
          });
        }
        case 'ping':
          return reply({});
        case 'tools/list':
          return reply({ tools: listTools() });
        case 'tools/call': {
          const name = message.params?.name;
          if (typeof name !== 'string')
            return rpcError(message.id, -32602, 'params.name is required');
          return reply(await callTool(name, message.params?.arguments, request, caller));
        }
        default:
          return rpcError(message.id, -32601, `Method not found: ${message.method}`);
      }
    },
  };
}

/** One tool's rule for `@better-iam/mcp`'s `createMcpGate` (structurally its `McpToolRule`). */
export interface GateToolRule {
  action?: string;
  resource?:
    | { type: string; id: string }
    | ((args: Record<string, unknown>) => { type: string; id: string });
  public?: boolean;
}

/**
 * Rules for `createMcpGate({ tools: gateTools(), unlisted: 'deny' })` (§9.3). The gate checks
 * visibility only: `compute:pools:read` on the pool a tool names, `compute:nodes:read` on the node;
 * tools without a resource argument are open to authenticated callers because the compute API makes
 * the real decision on every call. Confirm-listed actions are never gate actions, so nobody is asked
 * twice about different resources.
 */
export function gateTools(
  options: { typePrefix?: string; execCommand?: boolean; fleet?: boolean } = {},
): Record<string, GateToolRule> {
  const prefix = options.typePrefix ?? 'compute-';
  const pool = (args: Record<string, unknown>) => ({
    type: `${prefix}pool`,
    id: String(args.poolId ?? ''),
  });
  const node = (args: Record<string, unknown>) => ({
    type: `${prefix}node`,
    id: String(args.nodeId ?? ''),
  });
  const poolRead = { action: 'compute:pools:read', resource: pool };
  const nodeRead = { action: 'compute:nodes:read', resource: node };
  const rules: Record<string, GateToolRule> = {
    list_pools: { public: true },
    capacity_summary: { public: true },
    preview_reservation: poolRead,
    reserve_gpus: poolRead,
    release_reservation: { public: true },
    // Compute decides each on the reservation (OwnReservations, BoundedExtend, confirmations).
    list_reservations: { public: true },
    get_reservation: { public: true },
    extend_reservation: { public: true },
    node_status: nodeRead,
    run_diagnostic: nodeRead,
    create_instance: poolRead,
    // Compute decides each on the instance.
    list_instances: { public: true },
    get_instance: { public: true },
    start_instance: { public: true },
    stop_instance: { public: true },
    delete_instance: { public: true },
    // Sandboxes (v0.5): creating one needs to see its template; compute decides the rest.
    list_sandbox_templates: { public: true },
    create_sandbox: {
      action: 'compute:sandboxes:read',
      resource: (args: Record<string, unknown>) => ({
        type: `${prefix}sandbox-template`,
        id: String(args.templateId ?? ''),
      }),
    },
    list_sandboxes: { public: true },
    extend_sandbox: { public: true },
    get_sandbox: { public: true },
    delete_sandbox: { public: true },
  };
  if (options.execCommand) rules.exec_command = nodeRead;
  if (options.fleet) {
    // The fleet scope resolves only in the root tenant, so other tenants never see these tools work.
    const fleetAdmin = {
      action: 'compute:fleet:admin',
      resource: () => ({ type: `${prefix}fleet`, id: 'global' }),
    };
    rules.fleet_export = fleetAdmin;
    rules.fleet_plan = fleetAdmin;
  }
  return rules;
}
