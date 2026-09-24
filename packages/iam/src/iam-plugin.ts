// Compute's `IamPlugin` (PLAN.md §12.1, §12.3): the catalog, and an `afterAudit` that forwards the events
// compute reacts to into its inbox and never throws.

import type { AuditEvent, IamPlugin } from '@better-iam/core';
import { buildComputeCatalog, type ComputeCatalog, type ComputeCatalogOptions } from './catalog.js';
import {
  boundedSpill,
  isInboxEvent,
  toInboxEvent,
  type AuditEventLike,
  type InboxEvent,
  type InboxWriter,
} from './inbox.js';

export interface ComputeIamPluginOptions extends ComputeCatalogOptions {
  /** Where accepted events go: `bridge.localInbox()` in embedded mode, `sqlInbox(sql)`, or a remote inbox. */
  inbox: InboxWriter;
  /** A prebuilt catalog; otherwise built from the catalog options. */
  catalog?: ComputeCatalog;
  /** How long one inbox write may take before the event spills. Default 2000 ms. */
  timeoutMs?: number;
  /** Spill capacity; the oldest events drop beyond it (IamReconcile covers them). Default 10 000. */
  spill?: number;
  /** Which events to forward; default: allowed actions in the §12.8 table. */
  accept?(event: AuditEventLike): boolean;
  /** Called (and guarded) when an inbox write fails or times out. */
  onError?(error: unknown, events: readonly InboxEvent[]): void;
}

/** Counters for `selfCheck` and metrics (`better_compute_iam_inbox_spill_total`). */
export interface ComputeIamPluginStats {
  forwarded: number;
  spilled: number;
  dropped: number;
  pending: number;
  failures: number;
}

/** Compute's IAM plugin, with its counters and a manual spill flush. */
export interface ComputeIamPlugin extends IamPlugin {
  readonly id: 'better-compute';
  stats(): ComputeIamPluginStats;
  /** Retries the spilled events now; resolves true when the spill is empty afterwards. */
  flush(): Promise<boolean>;
}

class InboxTimeout extends Error {
  constructor(ms: number) {
    super(`The compute inbox did not answer within ${ms} ms`);
    this.name = 'InboxTimeout';
  }
}

async function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new InboxTimeout(ms)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Builds compute's `IamPlugin`. Its `afterAudit` **never throws**: better-iam's `dispatch()` awaits every
 * plugin's hook in one loop without a guard, so one throw would stall the IAM host's whole event pipeline
 * (§12.3). A failed or slow inbox write spills the event into a bounded in-process buffer, flushed after
 * the next successful write; a spilled event is lost only if the process dies first, and IamReconcile
 * turns that loss into a delay.
 */
export function computeIamPlugin(options: ComputeIamPluginOptions): ComputeIamPlugin {
  const catalog = options.catalog ?? buildComputeCatalog(options);
  const timeoutMs = options.timeoutMs ?? 2000;
  const spill = boundedSpill<InboxEvent>(options.spill ?? 10_000);
  const accept = options.accept ?? isInboxEvent;
  const stats = { forwarded: 0, spilled: 0, failures: 0 };
  let flushing: Promise<boolean> | undefined;

  const report = (error: unknown, events: readonly InboxEvent[]) => {
    stats.failures++;
    try {
      options.onError?.(error, events);
    } catch {
      // A reporting hook must not break the never-throw guarantee.
    }
  };

  const write = async (events: readonly InboxEvent[]): Promise<boolean> => {
    try {
      await withTimeout(
        Promise.resolve().then(() => options.inbox.put(events)),
        timeoutMs,
      );
      stats.forwarded += events.length;
      return true;
    } catch (error) {
      report(error, events);
      return false;
    }
  };

  const flush = (): Promise<boolean> => {
    flushing ??= (async () => {
      try {
        while (spill.size > 0) {
          const batch = spill.drain();
          if (!(await write(batch))) {
            spill.unshift(batch);
            return false;
          }
        }
        return true;
      } finally {
        flushing = undefined;
      }
    })();
    return flushing;
  };

  const plugin: ComputeIamPlugin = {
    id: 'better-compute',
    resourceTypes: Object.fromEntries(
      Object.entries(catalog.resourceTypes).map(([type, definition]) => [
        type,
        {
          ...definition,
          ...(definition.actions ? { actions: [...definition.actions] } : {}),
          ...(definition.relations ? { relations: [...definition.relations] } : {}),
          ...(definition.attributes ? { attributes: { ...definition.attributes } } : {}),
        },
      ]),
    ),
    ...(catalog.actions.length ? { actions: [...catalog.actions] } : {}),
    async afterAudit(event: AuditEvent): Promise<void> {
      try {
        if (!accept(event as AuditEventLike)) return;
        const item = toInboxEvent(event as AuditEventLike);
        if (!(await write([item]))) {
          spill.push(item);
          stats.spilled++;
          return;
        }
        if (spill.size > 0) await flush();
      } catch (error) {
        // Unreachable in practice (write and flush guard themselves); kept so nothing escapes.
        report(error, []);
      }
    },
    stats: () => ({ ...stats, dropped: spill.dropped, pending: spill.size }),
    flush,
  };
  // better-iam copies plugin fields it knows; keep ours out of enumeration so nothing mistakes them for hooks.
  Object.defineProperty(plugin, 'stats', { enumerable: false });
  Object.defineProperty(plugin, 'flush', { enumerable: false });
  return plugin;
}
