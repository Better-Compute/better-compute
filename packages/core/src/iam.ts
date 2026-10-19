// The IamPort (PLAN.md §12.1): all compute sees of better-iam. Implemented by the IAM bridge
// (`embedded()`, later `remoteIam()`); fleet paths never call it (P7).

/** A caller's credential exactly as presented: request headers, or a bearer token. */
export interface Credential {
  headers?: HeadersInit;
  token?: string;
  /**
   * The caller's address as the host verified it: the socket peer, or the hop a trusted proxy reported. Remote IAM
   * receives it as `x-forwarded-for` (for `request.sourceIp` policy conditions); forwarding headers the client sent
   * itself never pass on.
   */
  sourceIp?: string;
}

/** The authenticated caller. */
export interface Caller {
  identityId: string;
  identityKind: 'user' | 'service' | 'agent';
  tenantId: string;
  sessionId: string;
  sessionKind: 'user' | 'role' | 'api-key' | 'session-token' | 'delegated';
  mfa: boolean;
  /**
   * When the caller's session (or its MFA/break-glass activation) ends, epoch ms, when IAM says:
   * credentials compute issues on its behalf (break-glass SSH certificates) never outlive it.
   */
  sessionExpiresAt?: number;
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
  /**
   * A meter key of compute's catalog (`/^[a-z][a-z0-9_.-]{0,63}$/`): hosted (`gpu.<model>.hours`,
   * `node.metal.hours`, `vps.vcpu.hours`, …), provider VMs (`vm.*`, `disk.<type>.gib.hours`, `ip.public.hours`),
   * grants (`vm.grant.*`), networks and snapshots, or a `reported` meter for pass-through.
   */
  meter: string;
  quantity: number;
  /** The person for delegated work, or the agent for agent keys; absent once orphaned. */
  identityId?: string;
  occurredAt: number;
  /**
   * Bounded-cardinality tags only: region, pool, gpuModel, project, agent, provider, flavor, source. Never instance,
   * allocation, network or grant ids.
   */
  tags: Record<string, string>;
  /**
   * `cmp:<allocationId>:<windowStartMs>` for an allocation window, `cmp:<kind>:<sourceId>:<windowStartMs>:<meter>`
   * for another source (instance, grant, network, snapshot), and `costx:<accountId>:<sourceRowId>` for a
   * pass-through cost row.
   */
  idempotencyKey: string;
  /**
   * (billing) A reported cost in currency units (pass-through, better-iam `cost`), for meters with
   * `pricing: 'reported'`. Absent for priced meters.
   */
  cost?: number;
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

/**
 * A billing meter compute keeps on the IAM root tenant. `key` matches `/^[a-z][a-z0-9_.-]{0,63}$/`; `pricing` is
 * better-iam's: `rate-card` meters are priced by the platform's prices, `reported` meters carry their cost on each
 * usage event.
 */
export interface MeterSpec {
  key: string;
  name: string;
  unit: string;
  pricing: 'rate-card' | 'reported';
}

/** A meter as the IAM root tenant lists it (`IamPort.listMeters`). */
export interface MeterListing {
  key: string;
  pricing: 'rate-card' | 'reported';
  /** An archived meter still exists: `ensureMeters` leaves it alone and takes it for present. */
  archived?: boolean;
}

/** better-iam's `PriceSpec`, in micros (1 currency unit = 1,000,000 micros). */
export interface PriceSpecInput {
  model: 'per-unit' | 'graduated' | 'volume' | 'package';
  unitAmountMicros?: number;
  tiers?: { upTo: number | null; unitAmountMicros: number; flatAmountMicros?: number }[];
  packageSize?: number;
  packageAmountMicros?: number;
  includedQuantity?: number;
  minimumAmountMicros?: number;
  maximumAmountMicros?: number;
}

/** One price entry of a meter's rate card. */
export interface PriceView {
  meter: string;
  /** The tenant (and subtree) the price applies to; the root tenant itself for the list price. */
  targetTenantId?: string;
  /** `YYYY-MM`: the first billing period the price applies to. */
  effectiveFrom: string;
  spec: PriceSpecInput;
}

/** What a quantity of one meter costs a tenant. */
export interface QuoteLine {
  meter: string;
  quantity: number;
  /** Micros of the deployment currency; `null` when the tenant's account has no price for the meter. */
  amountMicros: number | null;
}

/**
 * A spend report over `[from, to)` (epoch ms) for `tenantId` and the tenants below it. better-iam bills by calendar
 * period, so the answer covers every whole billing period the range touches (`SpendResult.coveredFrom/coveredTo`).
 */
export interface SpendQuery {
  tenantId: string;
  from: number;
  to: number;
  groupBy: 'tenant' | 'meter' | 'tag';
  /** The tag to group by when `groupBy` is `tag`. */
  tag?: string;
}

export interface SpendRow {
  /** The tenant id, meter key or tag value of the group. */
  key: string;
  meter?: string;
  tenantId?: string;
  amountMicros: number;
  /** Units of the meter for a `meter` group; the sum over the group's meters otherwise. */
  quantity: number;
}

/** The answer to a `SpendQuery`: the rows, and the exact time range they cover. */
export interface SpendResult {
  rows: SpendRow[];
  /** Start of the first billing period summed, epoch ms. */
  coveredFrom: number;
  /** End (exclusive) of the last billing period summed, epoch ms. */
  coveredTo: number;
}

export interface IamPort {
  /**
   * The IAM root tenant (platform). When set, `betterCompute({ rootTenantId })` may be omitted;
   * when both are set they must agree. The port in `ModuleContext.iam` always names the resolved root,
   * also when only `betterCompute({ rootTenantId })` does.
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
   * Admissions (§12.4): the envelope calls this after transaction 1 committed a draft or a pending
   * change and before `require`, so the decision reads that row as committed, never a stale copy
   * (`extend` decides on the pending total). Embedded ports reload the row into the in-process
   * projection, failing closed (a failed reload drops the row, so the decision takes the bounded
   * miss path). Optional: ports whose resolver does not cache rows need nothing.
   */
  refreshResource?(tenantId: string, resource: { type: string; id: string }): Promise<void>;
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
  /**
   * (v1.0) Whether `identityId` is an active identity of `tenantId`. Compute asks before it makes
   * someone other than the caller the owner of a resource (`instances.create`/`attach` with
   * `ownerIdentityId`), outside any transaction. Optional: without it the owner is checked for
   * shape only.
   */
  isMember?(tenantId: string, identityId: string): Promise<boolean>;
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
  /**
   * (billing) Defines the meters on the root tenant that do not exist yet; a meter that already reaches the root
   * is reported in `existing` and left as it is. Optional: only ports that hold a root billing credential have it.
   */
  ensureMeters?(meters: readonly MeterSpec[]): Promise<{ created: string[]; existing: string[] }>;
  /** (billing) The meters the root tenant has, archived ones included. Optional like `ensureMeters`. */
  listMeters?(): Promise<MeterListing[]>;
  /**
   * (billing) Sets a rate-card price of a root meter: its list price, or with `targetTenantId` a negotiated price for
   * that tenant's subtree. `effectiveFrom` is a billing period (`YYYY-MM`).
   */
  setPrice?(input: {
    meter: string;
    targetTenantId?: string;
    effectiveFrom: string;
    spec: PriceSpecInput;
  }): Promise<PriceView>;
  /** (billing) Price entries of one meter, or of every rate-card meter, newest first; `targetTenantId` filters. */
  listPrices?(input: { meter?: string; targetTenantId?: string }): Promise<PriceView[]>;
  /**
   * (billing) What each line would cost `tenantId` this billing period under its effective price, one line per input
   * line, in order. Quantities are priced as period totals (tiers and included units apply to each line alone).
   */
  quote?(input: {
    tenantId: string;
    lines: readonly { meter: string; quantity: number }[];
  }): Promise<QuoteLine[]>;
  /**
   * (billing) Billed spend of a tenant's subtree. `rows` sum whole billing periods, so `[coveredFrom, coveredTo)` is the
   * exact union of the periods summed (in the deployment's time zone), which may be wider than the query's range.
   * Callers compare it with other figures only over that range.
   */
  spend?(query: SpendQuery): Promise<SpendResult>;
}
