// The IamPort (PLAN.md §12.1): all compute sees of better-iam. Implemented by the IAM bridge
// (`embedded()`, later `remoteIam()`); fleet paths never call it (P7).

/** A caller's credential exactly as presented: request headers, or a bearer token. */
export interface Credential {
  headers?: HeadersInit;
  token?: string;
}

/** The authenticated caller. */
export interface Caller {
  identityId: string;
  identityKind: 'user' | 'service' | 'agent';
  tenantId: string;
  sessionId: string;
  sessionKind: 'user' | 'role' | 'api-key' | 'session-token' | 'delegated';
  mfa: boolean;
  /** Delegated sessions and agent keys: the agent acting. */
  agentId?: string;
  delegationId?: string;
}

/** An IAM resource reference; `type` carries the configured prefix (`compute-pool`). */
export interface IamResource {
  type: string;
  id: string;
}

/** One authorization question. */
export interface Decision {
  tenantId: string;
  action: string;
  resource: IamResource;
}

/** One entry of an `authorizeMany` batch (the tenant is the batch's). */
export interface Check {
  action: string;
  resource: IamResource;
}

export interface SpendCheckInput {
  tenantId: string;
  identityId?: string;
  meter?: string;
}

export interface BudgetState {
  budgetId: string;
  name: string;
  spent: number;
  amount: number;
}

/** Whether usage is within every enforced budget that covers it. */
export interface SpendCheck {
  allowed: boolean;
  budgets: BudgetState[];
  blockedBy?: BudgetState;
}

/** One hourly usage window (§12.7). */
export interface UsageEvent {
  tenantId: string;
  /** `gpu.<model>.hours`, `node.metal.hours`, `vps.vcpu.hours`, `vps.memory.gib.hours`. */
  meter: string;
  quantity: number;
  /** The person for delegated work, or the agent for agent keys; absent once orphaned. */
  identityId?: string;
  occurredAt: number;
  /** Bounded-cardinality tags only: region, pool, gpuModel, project, agent. Never per-allocation ids. */
  tags: Record<string, string>;
  /** `cmp:<allocId>:<windowStartMs>`. */
  idempotencyKey: string;
}

/** What happened to one usage event after poison isolation. */
export interface UsageResult {
  idempotencyKey: string;
  status: 'recorded' | 'duplicate' | 'reattributed' | 'dead-lettered';
  /** For `reattributed`: the identity (successor, or none) the event was recorded under. */
  identityId?: string;
  error?: { code: string; message: string };
}

/** Upstream feature detection (`IamPort.capabilities()`). */
export interface IamCapabilities {
  /** better-iam consults a plugin's own resolver (U3). */
  pluginResolver: boolean;
  /** Audit events carry the detail compute needs (U4). */
  eventDetail: boolean;
  /** `evaluate` with caller-supplied attributes (gap 2). */
  evaluate: boolean;
  /** Decisions run under a shared lock (R1). */
  readOnlyDecisions: boolean;
}

export interface IamPort {
  /**
   * The IAM root tenant (platform). When set, `betterCompute({ rootTenantId })` may be omitted;
   * when both are set they must agree.
   */
  readonly rootTenantId?: string;
  /** Embedded: `iam.authenticate` (1 lock acquisition, may write `lastSeenAt`); cached 30 s by the caller. */
  authenticate(credential: Credential): Promise<Caller>;
  /** Mutations: `ACCESS_DENIED` unless allowed; never cached; authenticate + decide = 2 acquisitions. */
  require(credential: Credential, decision: Decision): Promise<void>;
  /** Reads; the caller may cache the answer 10 s. */
  authorize(credential: Credential, decision: Decision): Promise<boolean>;
  /** Chunks of ≤ 50; any batch error throws, never "all false" (P11). */
  authorizeMany(credential: Credential, tenantId: string, checks: Check[]): Promise<boolean[]>;
  /**
   * Re-decides for a session recorded earlier (`Caller.sessionId`), when the caller presents no
   * credential again: long-lived streams such as tunnels, re-authorized every 60 s (§7.6). False
   * once the session is revoked or expired, or the identity lost the permission. Optional: hosts
   * without it must supply their own check.
   */
  authorizeSession?(
    session: { identityId: string; sessionId: string },
    decision: Decision,
  ): Promise<boolean>;
  /** Delegated confirmation (v0.3); `'not-held-back'` when the action is not confirm-listed. */
  requestConfirmation(
    credential: Credential,
    decision: Decision & { reason: string },
  ): Promise<{ confirmationId: string; expiresAt?: number } | 'not-held-back'>;
  /**
   * Budget check before admitting (`budgetCheck: 'meter'` pools). Embedded ignores `credential`; remote
   * mode needs the caller's credential, because better-iam's HTTP `billing/check` decides for the
   * credential's own tenant and identity only.
   */
  billingCheck(input: SpendCheckInput, credential?: Credential): Promise<SpendCheck>;
  /** Records usage with poison isolation: one result per event, in order. */
  recordUsage(events: UsageEvent[]): Promise<UsageResult[]>;
  /** From the flag cache; never one `isEnabled` call per admission. */
  featureEnabled(tenantId: string, key: string): Promise<boolean>;
  capabilities(): IamCapabilities;
}
