// Remote-IAM MCP (PLAN.md §9.3, v0.4): `@better-iam/mcp`'s gate needs an `McpIam` (authenticate,
// authorize, authorizeMany, and the delegations API for confirmations). Embedded hosts pass their
// `betterIam()` instance; hosts whose IAM runs elsewhere pass `remoteMcpIam(createIamClient(...))`,
// which answers the same calls over better-iam's HTTP API with each caller's own credential, so every
// decision is still made (and audited) as the caller.

interface CallOptions {
  headers?: HeadersInit;
}

/** A credential as the gate hands it over: a bearer token and/or the request's headers. */
export interface McpCredentialInput {
  token?: string;
  headers?: HeadersInit;
}

/**
 * The part of `createIamClient<BetterIam>()` (`@better-iam/client`) the adapter uses. Methods take
 * `(input, options)` with the caller's headers in `options`, as better-iam's client does.
 */
export interface McpIamClient {
  sts: {
    getCallerIdentity(options?: CallOptions): Promise<{
      identityId: string;
      identityKind: string;
      tenantId: string;
      sessionId: string;
      sessionKind: string;
      agentId?: string;
      delegationId?: string;
    }>;
  };
  authorize(
    input: { tenantId: string; action: string; resource: { type: string; id: string } },
    options?: CallOptions,
  ): Promise<{ allowed: boolean; reason?: string }>;
  authorizeMany(
    input: {
      tenantId: string;
      checks: { action: string; resource: { type: string; id: string } }[];
    },
    options?: CallOptions,
  ): Promise<{ results: { allowed: boolean; reason?: string }[] }>;
  delegations?: {
    get(
      input: { tenantId: string; delegationId: string },
      options?: CallOptions,
    ): Promise<{ confirm?: string[] }>;
    requestConfirmation(
      input: {
        tenantId: string;
        action: string;
        resource: { type: string; id: string };
        reason: string;
      },
      options?: CallOptions,
    ): Promise<{ id: string; status: string; expiresAt: number }>;
  };
}

/** Structurally `@better-iam/mcp`'s `McpIam`. */
export interface RemoteMcpIam {
  authenticate(credential: McpCredentialInput): Promise<{
    identity: { id: string; tenantId: string; kind: string };
    session: {
      id: string;
      tenantId: string;
      kind: string;
      agentId?: string;
      delegationId?: string;
    };
  }>;
  authorize(
    request: McpCredentialInput & {
      tenantId: string;
      action: string;
      resource: { type: string; id: string };
    },
  ): Promise<{ allowed: boolean; reason: string }>;
  authorizeMany(
    request: McpCredentialInput & {
      tenantId: string;
      checks: { action: string; resource: { type: string; id: string } }[];
    },
  ): Promise<{ results: { allowed: boolean; reason: string }[] }>;
  api?: { delegations?: NonNullable<McpDelegations> };
}

type McpDelegations = {
  get(
    credential: McpCredentialInput,
    input: { tenantId: string; delegationId: string },
  ): Promise<{ confirm?: string[] }>;
  requestConfirmation(
    credential: McpCredentialInput,
    input: {
      tenantId: string;
      action: string;
      resource: { type: string; id: string };
      reason: string;
    },
  ): Promise<{ id: string; status: string; expiresAt: number }>;
};

/** Headers that carry who the caller is; nothing else of the incoming request is forwarded. */
const forwarded = ['authorization', 'cookie', 'user-agent', 'x-forwarded-for', 'x-request-id'];

function callerOptions(credential: McpCredentialInput): CallOptions {
  const given = new Headers(credential.headers);
  const headers = new Headers();
  for (const name of forwarded) {
    const value = given.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (credential.token !== undefined) headers.set('authorization', `Bearer ${credential.token}`);
  return { headers };
}

const reasonOf = (answer: { allowed: boolean; reason?: string }) =>
  answer.reason ?? (answer.allowed ? 'ALLOWED' : 'ACCESS_DENIED');

/**
 * `createMcpGate({ iam: remoteMcpIam(createIamClient<BetterIam>({ baseURL })), ... })`: the gate's
 * IAM calls over HTTP. Authentication is `sts.getCallerIdentity` as the caller; decisions are
 * `authorize`/`authorizeMany` as the caller; confirmations (when the client has `delegations`)
 * read the caller's delegation and ask its person as the caller.
 */
export function remoteMcpIam(client: McpIamClient): RemoteMcpIam {
  const split = <T extends McpCredentialInput>(request: T) => {
    const { token, headers, ...rest } = request;
    return {
      options: callerOptions({
        ...(token !== undefined ? { token } : {}),
        ...(headers !== undefined ? { headers } : {}),
      }),
      rest,
    };
  };
  const iam: RemoteMcpIam = {
    async authenticate(credential) {
      const who = await client.sts.getCallerIdentity(callerOptions(credential));
      return {
        identity: { id: who.identityId, tenantId: who.tenantId, kind: who.identityKind },
        session: {
          id: who.sessionId,
          tenantId: who.tenantId,
          kind: who.sessionKind,
          ...(who.agentId !== undefined ? { agentId: who.agentId } : {}),
          ...(who.delegationId !== undefined ? { delegationId: who.delegationId } : {}),
        },
      };
    },
    async authorize(request) {
      const { options, rest } = split(request);
      const answer = await client.authorize(rest, options);
      return { allowed: answer.allowed === true, reason: reasonOf(answer) };
    },
    async authorizeMany(request) {
      const { options, rest } = split(request);
      const { results } = await client.authorizeMany(rest, options);
      if (results.length !== rest.checks.length)
        throw new Error(`authorizeMany answered ${results.length} of ${rest.checks.length} checks`);
      return {
        results: results.map((answer) => ({
          allowed: answer.allowed === true,
          reason: reasonOf(answer),
        })),
      };
    },
  };
  const delegations = client.delegations;
  if (delegations)
    iam.api = {
      delegations: {
        get: (credential, input) => delegations.get(input, callerOptions(credential)),
        requestConfirmation: (credential, input) =>
          delegations.requestConfirmation(input, callerOptions(credential)),
      },
    };
  return iam;
}
