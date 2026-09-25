import { createComputeClient } from '@better-compute/client';
import {
  iamConfirmations,
  type ConfirmationReader,
  type IamConfirmationsOptions,
} from './confirmations.js';
import { createComputeMcp, type ComputeMcp, type ComputeMcpOptions, type McpCallerLike } from './server.js';
import type { ComputeApi } from './tools.js';

// The MCP endpoint as a host mounts it next to its control plane (PLAN.md §9.3): better-iam's gate decides who may
// call which tool, then the compute tools run against the control plane in this process, as the caller. Every tool
// call becomes a compute API call through `compute.handler` with the caller's own Authorization header, so compute
// authorizes each one exactly as it would over HTTP. Nothing is reachable without the gate.

/** `@better-iam/mcp`'s `createMcpGate(...)` result (structural, so this package needs no import of it). */
export type McpGateLike = (
  request: Request,
  next: (request: Request, caller: McpCallerLike) => Promise<Response> | Response,
) => Promise<Response>;

export interface ComputeMcpEndpointOptions
  extends Omit<ComputeMcpOptions, 'client' | 'baseURL' | 'basePath' | 'confirmations'> {
  /** The control plane in this process (`betterCompute()`): its HTTP handler and public endpoint. */
  compute: {
    handler(request: Request): Promise<Response>;
    endpoint: { origin: string; basePath: string };
  };
  /**
   * The gate in front, required: `createMcpGate({ iam, tenantId, tools: gateTools(), unlisted: 'deny' })`. Its
   * `tenantId` is the organization that runs this endpoint (fixed), or a per-caller choice you make deliberately:
   * deciding in each caller's own tenant would let any organization grant itself access.
   */
  gate: McpGateLike;
  /**
   * better-iam's delegations API (`iam.api.delegations`, or a remote client's `delegations`): tools then wait
   * inside the call for a person to approve a held-back action, polling with the agent's own token.
   */
  delegations?: ConfirmationReader;
  confirmationOptions?: IamConfirmationsOptions;
}

export interface ComputeMcpEndpoint {
  readonly mcp: ComputeMcp;
  /** Answers MCP over Streamable HTTP (POST JSON-RPC), and the gate's metadata and challenges. */
  handler(request: Request): Promise<Response>;
}

export function computeMcpEndpoint(options: ComputeMcpEndpointOptions): ComputeMcpEndpoint {
  const { compute, gate, delegations, confirmationOptions, ...rest } = options;
  if (typeof gate !== 'function')
    throw new Error('computeMcpEndpoint needs a gate (createMcpGate from @better-iam/mcp)');
  const inProcess: typeof globalThis.fetch = async (input, init) =>
    compute.handler(input instanceof Request && !init ? input : new Request(input, init));
  const mcp = createComputeMcp({
    ...rest,
    // One client per request, carrying only the caller's own credential.
    client: (request) =>
      createComputeClient({
        baseURL: compute.endpoint.origin,
        basePath: compute.endpoint.basePath,
        headers: { authorization: request.headers.get('authorization') ?? '' },
        fetch: inProcess,
      }) as unknown as ComputeApi,
    ...(delegations ? { confirmations: iamConfirmations(delegations, confirmationOptions) } : {}),
  });
  return {
    mcp,
    handler: (request) => gate(request, (forwarded, caller) => mcp.handler(forwarded, caller)),
  };
}
