import {
  ComputeError,
  type Caller,
  type Check,
  type Credential,
  type Decision,
  type IamPort,
} from '@better-compute/core';

// A scripted IamPort: bearer tokens map to callers, decisions follow allow/deny rules (deny wins;
// nothing is allowed by default), and every call is recorded in order. It stands in for the IAM
// bridge's embedded() until v0.1, and stays the tool for tests that count IAM calls (P7).

export type FakeIamMethod =
  | 'authenticate'
  | 'require'
  | 'authorize'
  | 'authorizeMany'
  | 'requestConfirmation'
  | 'billingCheck'
  | 'recordUsage'
  | 'featureEnabled';

export interface FakeIamCall {
  method: FakeIamMethod;
  /** The bearer (or IAM cookie) token presented, when there was one. */
  token?: string;
  /** The credential exactly as compute passed it. */
  credential?: Credential;
  decision?: Decision;
}

/** Matches a decision when every given field equals the decision's; omitted fields match anything. */
export interface FakeIamRule {
  token?: string;
  tenantId?: string;
  action?: string;
  type?: string;
  id?: string;
}

/** What a fake IAM knows from the start; `addCaller`, `allow` and `deny` add more later. */
export interface FakeIamOptions {
  /** Bearer tokens and the callers they authenticate as (defaults as in `addCaller`). */
  callers?: Record<string, Partial<Caller> & { tenantId: string }>;
  /** Rules that allow decisions (`[{}]` allows everything). */
  allow?: FakeIamRule[];
  /** Rules that deny decisions, whatever allows them. */
  deny?: FakeIamRule[];
}

export interface FakeIam extends IamPort {
  readonly calls: FakeIamCall[];
  /** Makes `token` authenticate as a caller; unspecified fields get plausible defaults. */
  addCaller(token: string, caller: Partial<Caller> & { tenantId: string }): Caller;
  /** Allows decisions matching `rule` (`{}` allows everything). */
  allow(rule?: FakeIamRule): void;
  /** Denies decisions matching `rule`, whatever allows them. */
  deny(rule: FakeIamRule): void;
  /** How many calls of `method` were recorded. */
  count(method: FakeIamMethod): number;
  /** Forgets the recorded calls (callers and rules stay). */
  reset(): void;
}

/** The token a credential carries: `token`, a bearer header, or the IAM session cookie. */
export function tokenOf(credential: Credential | undefined): string | undefined {
  if (!credential) return undefined;
  if (credential.token) return credential.token;
  const headers = new Headers(credential.headers);
  const bearer = /^Bearer (.+)$/i.exec(headers.get('authorization') ?? '')?.[1];
  if (bearer) return bearer;
  return /(?:^|;\s*)better-iam\.session=([^;]+)/.exec(headers.get('cookie') ?? '')?.[1];
}

/**
 * A scripted `IamPort` for tests. Unknown tokens are `UNAUTHENTICATED`; a decision is allowed only
 * when an allow rule matches and no deny rule does; a denied `require` is `ACCESS_DENIED`.
 * `billingCheck` allows, `recordUsage` records every event, `featureEnabled` is false and
 * `requestConfirmation` answers `'not-held-back'`.
 *
 * ```ts
 * const iam = fakeIam({ callers: { 'token-acme': { tenantId: 'tenant-acme' } } });
 * iam.allow({ token: 'token-acme', action: 'compute:nodes:read' });
 * // … exercise compute …
 * expect(iam.count('require')).toBe(0);
 * ```
 */
export function fakeIam(options: FakeIamOptions = {}): FakeIam {
  const callers = new Map<string, Caller>();
  const allows: FakeIamRule[] = [...(options.allow ?? [])];
  const denies: FakeIamRule[] = [...(options.deny ?? [])];
  const calls: FakeIamCall[] = [];
  let sessions = 0;

  const record = (method: FakeIamMethod, credential?: Credential, decision?: Decision) => {
    const token = tokenOf(credential);
    calls.push({
      method,
      ...(token ? { token } : {}),
      ...(credential ? { credential } : {}),
      ...(decision ? { decision } : {}),
    });
    return token;
  };
  const callerOf = (token: string | undefined): Caller => {
    const caller = token === undefined ? undefined : callers.get(token);
    if (!caller) throw new ComputeError('UNAUTHENTICATED', 'Invalid or expired credential');
    return caller;
  };
  const matches = (rule: FakeIamRule, token: string, decision: Decision) =>
    (rule.token === undefined || rule.token === token) &&
    (rule.tenantId === undefined || rule.tenantId === decision.tenantId) &&
    (rule.action === undefined || rule.action === decision.action) &&
    (rule.type === undefined || rule.type === decision.resource.type) &&
    (rule.id === undefined || rule.id === decision.resource.id);
  const decide = (token: string | undefined, decision: Decision): boolean => {
    callerOf(token);
    return (
      allows.some((rule) => matches(rule, token!, decision)) &&
      !denies.some((rule) => matches(rule, token!, decision))
    );
  };
  const addCaller = (token: string, caller: Partial<Caller> & { tenantId: string }): Caller => {
    const full: Caller = {
      identityId: `identity-${++sessions}`,
      identityKind: 'user',
      sessionId: `session-${sessions}`,
      sessionKind: 'user',
      mfa: false,
      ...caller,
    };
    callers.set(token, full);
    return full;
  };
  for (const [token, caller] of Object.entries(options.callers ?? {})) addCaller(token, caller);

  return {
    calls,
    addCaller,
    allow(rule = {}) {
      allows.push(rule);
    },
    deny(rule) {
      denies.push(rule);
    },
    count: (method) => calls.filter((call) => call.method === method).length,
    reset() {
      calls.length = 0;
    },
    async authenticate(credential) {
      return { ...callerOf(record('authenticate', credential)) };
    },
    async require(credential, decision) {
      if (!decide(record('require', credential, decision), decision))
        throw new ComputeError('ACCESS_DENIED', 'Access denied');
    },
    async authorize(credential, decision) {
      return decide(record('authorize', credential, decision), decision);
    },
    async authorizeMany(credential, tenantId, checks: Check[]) {
      const token = record('authorizeMany', credential);
      return checks.map((check) => decide(token, { tenantId, ...check }));
    },
    async requestConfirmation(credential) {
      record('requestConfirmation', credential);
      return 'not-held-back';
    },
    async billingCheck() {
      record('billingCheck');
      return { allowed: true, budgets: [] };
    },
    async recordUsage(events) {
      record('recordUsage');
      return events.map((event) => ({ idempotencyKey: event.idempotencyKey, status: 'recorded' }));
    },
    async featureEnabled() {
      record('featureEnabled');
      return false;
    },
    capabilities: () => ({
      pluginResolver: false,
      eventDetail: false,
      evaluate: false,
      readOnlyDecisions: false,
    }),
  };
}
