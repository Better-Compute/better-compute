import { createHash } from 'node:crypto';
import type { Caller, Credential, Decision } from '@better-compute/core';

// The two IAM caches of PLAN.md §3.4 step 2 and §9.2 (P7): authentication by sha256(credential) for
// 30 s, and read decisions by (session, tenant, action, type, id) for 10 s. Mutations are never
// cached: `require` always goes to IAM. Both are bounded, least recently used first out (P12), and
// both are rebuildable (P1): dropping everything only costs IAM calls.

export interface CacheOptions {
  /** How long an authentication is reused (default 30 000 ms; 0 disables the cache). */
  authenticationTtlMs?: number;
  /** How long an allowed read decision is reused (default 10 000 ms; 0 disables the cache). */
  readDecisionTtlMs?: number;
  /** Entries per cache (default 10 000). */
  maxEntries?: number;
  /** Milliseconds since the epoch; the server passes its `Clock`. */
  now?: () => number;
}

/** What the IAM bridge calls when inbox events revoke something (§12.8). */
export interface ComputeCaches {
  /** Forgets every authentication and read decision of an identity (suspension, deletion, key revocation). */
  dropIdentity(identityId: string): void;
  /** Forgets one session's authentication and read decisions (sign-out, session revocation). */
  dropSession(sessionId: string): void;
  /** Forgets every read decision (policy, role, binding and relationship changes). */
  dropDecisions(): void;
  /** Forgets everything. */
  clear(): void;
  /** Current sizes, for metrics and tests. */
  stats(): { authentications: number; decisions: number };
}

/** The envelope's side of the caches. */
export interface Caches extends ComputeCaches {
  /** The caller for `credential`: cached, or from `load` (concurrent misses share one call). */
  authenticate(credential: Credential, load: () => Promise<Caller>): Promise<Caller>;
  /** A read decision for `caller`: a cached allow, or `load`'s answer (only allows are kept). */
  authorize(caller: Caller, decision: Decision, load: () => Promise<boolean>): Promise<boolean>;
  /** The cached allow for a read decision, without asking IAM; `undefined` when unknown. */
  cachedDecision(caller: Caller, decision: Decision): true | undefined;
  /** Changes whenever something is dropped; pass it back to `rememberAllowed`. */
  generation(): number;
  /**
   * Remembers allowed read decisions (the list recipe's per-item answers), unless something was
   * dropped since `generation` was read, when the answers may predate a revocation.
   */
  rememberAllowed(caller: Caller, decisions: readonly Decision[], generation: number): void;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/** A Map in recency order: reads move an entry to the end, inserts evict from the front. */
class BoundedCache<V> {
  private readonly entries = new Map<string, Entry<V>>();

  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  get enabled(): boolean {
    return this.ttlMs > 0 && this.max > 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expiresAt <= this.now()) return undefined;
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    if (!this.enabled) return;
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  deleteWhere(match: (value: V) => boolean): void {
    for (const [key, entry] of this.entries) if (match(entry.value)) this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * The credential material IAM authenticates with: the token, the `authorization` header and the
 * IAM cookie (present only when the server accepts it). Other headers never change who is calling.
 * `undefined` when there is nothing to key on, so nothing is cached.
 */
export function credentialKey(credential: Credential): string | undefined {
  const headers = credential.headers === undefined ? undefined : new Headers(credential.headers);
  const material = [
    credential.token ?? null,
    headers?.get('authorization') ?? null,
    headers?.get('cookie') ?? null,
  ];
  if (material.every((part) => part === null || part === '')) return undefined;
  // The caller's address is part of the key: IAM may decide on it (`request.sourceIp` conditions,
  // session IP binding), so a token used from another address never rides a cached answer.
  return createHash('sha256')
    .update(JSON.stringify([...material, credential.sourceIp ?? null]))
    .digest('hex');
}

/**
 * The source address a caller was authenticated from, set (non-enumerable, so equality and JSON
 * ignore it) by `authenticate`; the server passes that very object on to `authorize` and the list
 * recipe. A caller built elsewhere counts as address-less (`null`).
 */
const sourceOf = Symbol('sourceIp');
type Sourced = Caller & { [sourceOf]?: string | null };

function tagSource(caller: Caller, source: string | null): Caller {
  const copy = { ...caller };
  Object.defineProperty(copy, sourceOf, { value: source, enumerable: false });
  return copy;
}

const decisionKey = (caller: Caller, decision: Decision): string | undefined => {
  return JSON.stringify([
    caller.sessionId,
    (caller as Sourced)[sourceOf] ?? null,
    decision.tenantId,
    decision.action,
    decision.resource.type,
    decision.resource.id,
  ]);
};

interface CachedDecision {
  identityId: string;
  sessionId: string;
}

export function createCaches(options: CacheOptions = {}): Caches {
  const now = options.now ?? (() => Date.now());
  const max = options.maxEntries ?? 10_000;
  const authentications = new BoundedCache<Caller>(max, options.authenticationTtlMs ?? 30_000, now);
  const decisions = new BoundedCache<CachedDecision>(max, options.readDecisionTtlMs ?? 10_000, now);
  const inflight = new Map<string, Promise<Caller>>();
  // Bumped by every drop: an answer that was in flight across a drop is returned but not kept.
  let epoch = 0;

  const dropIdentity = (identityId: string) => {
    epoch += 1;
    authentications.deleteWhere((caller) => caller.identityId === identityId);
    decisions.deleteWhere((entry) => entry.identityId === identityId);
  };
  const dropSession = (sessionId: string) => {
    epoch += 1;
    authentications.deleteWhere((caller) => caller.sessionId === sessionId);
    decisions.deleteWhere((entry) => entry.sessionId === sessionId);
  };

  return {
    async authenticate(credential, load) {
      const source = credential.sourceIp ?? null;
      const tagged = (caller: Caller): Caller => tagSource(caller, source);
      const key = authentications.enabled ? credentialKey(credential) : undefined;
      if (key === undefined) return tagged(await load());
      const cached = authentications.get(key);
      if (cached) return tagged(cached);
      let pending = inflight.get(key);
      if (!pending) {
        const started = epoch;
        pending = load().then((caller) => {
          if (started === epoch) authentications.set(key, Object.freeze({ ...caller }));
          return caller;
        });
        const settled = () => {
          if (inflight.get(key) === pending) inflight.delete(key);
        };
        pending.then(settled, settled);
        inflight.set(key, pending);
      }
      return tagged(await pending);
    },
    async authorize(caller, decision, load) {
      const key = decisions.enabled ? decisionKey(caller, decision) : undefined;
      if (key === undefined) return load();
      if (decisions.get(key)) return true;
      const started = epoch;
      const allowed = await load();
      if (allowed === true && started === epoch)
        decisions.set(key, { identityId: caller.identityId, sessionId: caller.sessionId });
      return allowed;
    },
    cachedDecision(caller, decision) {
      const key = decisions.enabled ? decisionKey(caller, decision) : undefined;
      return key !== undefined && decisions.get(key) ? true : undefined;
    },
    generation: () => epoch,
    rememberAllowed(caller, allowed, generation) {
      if (generation !== epoch) return;
      for (const decision of allowed) {
        const key = decisionKey(caller, decision);
        if (key !== undefined)
          decisions.set(key, { identityId: caller.identityId, sessionId: caller.sessionId });
      }
    },
    dropIdentity,
    dropSession,
    dropDecisions() {
      epoch += 1;
      decisions.clear();
    },
    clear() {
      epoch += 1;
      authentications.clear();
      decisions.clear();
    },
    stats: () => ({ authentications: authentications.size, decisions: decisions.size }),
  };
}

const perServer = new WeakMap<object, Caches>();

/** The caches of one server, keyed by its resolved options (one `betterCompute()` call). */
export function cachesFor(owner: object, options?: CacheOptions): Caches {
  let caches = perServer.get(owner);
  if (!caches) {
    caches = createCaches(options);
    perServer.set(owner, caches);
  }
  return caches;
}

/** The public face of the caches (`compute.caches`): invalidation only. */
export function publicCaches(caches: Caches): ComputeCaches {
  return Object.freeze({
    dropIdentity: (identityId: string) => caches.dropIdentity(identityId),
    dropSession: (sessionId: string) => caches.dropSession(sessionId),
    dropDecisions: () => caches.dropDecisions(),
    clear: () => caches.clear(),
    stats: () => caches.stats(),
  });
}
