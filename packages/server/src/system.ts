import {
  defineMethod,
  fleetResourceId,
  manifest,
  type Caller,
  type MethodDefinition,
} from '@better-compute/core';
import type { SelfCheckReport } from './self-check.js';
import type { ServerInfo } from './version.js';

/** The input of a method that takes none: `{}`, or nothing at all. */
export type NoInput = Record<string, never>;

/** The caller as `system.whoami` reports it (the session id stays out). */
export type CallerIdentity = Omit<Caller, 'sessionId'>;

/** Who is calling: the authenticated identity, or anonymous when the call carried no credential. */
export type WhoAmI = { authenticated: false } | ({ authenticated: true } & CallerIdentity);

/** The `system` group (§9.2): `whoami` and `version` are public; `selfCheck` needs `compute:fleet:admin`. */
export type SystemApi = {
  system: {
    whoami: MethodDefinition<NoInput, WhoAmI>;
    version: MethodDefinition<NoInput, ServerInfo>;
    selfCheck: MethodDefinition<NoInput, SelfCheckReport>;
  };
};

const empty = manifest({});

/** Accepts `{}` or no input; anything else is `INVALID_INPUT`. Described as the empty strict object. */
export const validateNoInput = Object.assign(
  (input: unknown): NoInput => empty.parse(input ?? {}) as NoInput,
  { jsonSchema: empty.jsonSchema() },
);

function identityOf(caller: Caller): CallerIdentity {
  const identity: CallerIdentity = {
    identityId: caller.identityId,
    identityKind: caller.identityKind,
    tenantId: caller.tenantId,
    sessionKind: caller.sessionKind,
    mfa: caller.mfa,
  };
  if (caller.agentId !== undefined) identity.agentId = caller.agentId;
  if (caller.delegationId !== undefined) identity.delegationId = caller.delegationId;
  return identity;
}

/** The server's own `system` group. */
export function systemApi(host: {
  info(): ServerInfo;
  selfCheck(): Promise<SelfCheckReport>;
}): SystemApi {
  return {
    system: {
      whoami: defineMethod<NoInput, WhoAmI>({
        action: null,
        kind: 'public',
        resource: () => undefined,
        validate: validateNoInput,
        // One IAM authentication when a credential came with the call; none otherwise.
        async handler(context) {
          if (!context.credential) return { authenticated: false };
          return {
            authenticated: true,
            ...identityOf(await context.iam.authenticate(context.credential)),
          };
        },
      }),
      version: defineMethod<NoInput, ServerInfo>({
        action: null,
        kind: 'public',
        resource: () => undefined,
        validate: validateNoInput,
        handler: async () => host.info(),
      }),
      selfCheck: defineMethod<NoInput, SelfCheckReport>({
        action: 'compute:fleet:admin',
        kind: 'read',
        resource: () => ({ type: 'fleet', id: fleetResourceId }),
        validate: validateNoInput,
        handler: () => host.selfCheck(),
      }),
    },
  };
}
