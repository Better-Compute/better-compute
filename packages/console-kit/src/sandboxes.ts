import { createValueResource, type ValueResource } from './list.js';
import type { ComputeRequester } from './resources.js';

// Sandboxes (PLAN.md §3.7, the vps module's `sandboxes` and `sandboxTemplates` groups): the tenant's templates with
// their warm pools, and the sandboxes (the person's own, or everyone's) with a live countdown to their expiry, and
// the actions on them. Exec is `sandbox exec` in the CLI (ssh through a tunnel); here only its command is shown.

export interface SandboxRow {
  id: string;
  templateId: string;
  instanceId: string;
  state: string;
  instanceState: string;
  addresses: string[];
  ttlSeconds: number;
  expiresAt: number;
  warm: boolean;
  ownerIdentityId: string;
  createdAt: number;
  readyAt?: number;
  expiredAt?: number;
  fromSnapshot?: string;
  /**
   * A memory restore: false while it still answers to its source's SSH identity (exec is refused then, reason
   * restore-shares-identity), true once the host gave it its own; absent for other sandboxes.
   */
  identityRebound?: boolean;
  snapshots?: { id: string; state: string; includeMemory: boolean; keep: boolean; createdAt: number }[];
}

export interface SandboxTemplateRow {
  id: string;
  name: string;
  poolId: string;
  flavor: string;
  imageId: string;
  runtime: string;
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
  warm: { min: number; max: number };
}

/** A sandbox's remaining lifetime for display: `12m 03s`, `1h 05m`, or `expired`. */
export function timeLeft(expiresAt: number, now: number): { ms: number; text: string; urgent: boolean } {
  const ms = Math.max(0, expiresAt - now);
  if (ms === 0) return { ms, text: 'expired', urgent: true };
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const text =
    hours > 0
      ? `${hours}h ${String(minutes).padStart(2, '0')}m`
      : `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  // The last five minutes (or the last tenth of a short lifetime) are worth a warning.
  return { ms, text, urgent: ms <= 5 * 60_000 };
}

/** The CLI line that opens a shell in the sandbox. */
export const sandboxExecCommand = (sandboxId: string): string => `better-compute sandbox exec ${sandboxId}`;

export interface SandboxesView extends ValueResource<{ items: SandboxRow[]; cursor?: string }> {
  /** Only the person's own sandboxes (default), or every sandbox of the tenant. */
  scope(scope: 'mine' | 'all'): Promise<void>;
  templates(): Promise<SandboxTemplateRow[]>;
  /** One sandbox with its snapshots (sandboxes.get). */
  detail(sandboxId: string): Promise<SandboxRow>;
  create(input: { templateId: string; ttlSeconds?: number; fromSnapshot?: string }): Promise<SandboxRow>;
  /** Adds `byMs` to the expiry, within the template's maximum. */
  extend(sandboxId: string, byMs: number): Promise<SandboxRow>;
  snapshot(sandboxId: string, options?: { includeMemory?: boolean; keep?: boolean }): Promise<unknown>;
  remove(sandboxId: string): Promise<void>;
  /** Tenant administrators (compute:sandboxes:manage): templates and their warm pools. */
  createTemplate(input: TemplateFields & { name: string; poolId: string; flavor: string; imageId: string }): Promise<SandboxTemplateRow>;
  updateTemplate(templateId: string, fields: TemplateFields): Promise<SandboxTemplateRow>;
  deleteTemplate(templateId: string): Promise<void>;
}

/** Template fields an administrator sets (sandboxTemplates.create / update). */
export interface TemplateFields {
  flavor?: string;
  imageId?: string;
  runtime?: string;
  defaultTtlSeconds?: number;
  maxTtlSeconds?: number;
  warm?: { min: number; max?: number };
  network?: 'egress' | 'private' | 'none';
}

const newKey = () =>
  `console-${Array.from(globalThis.crypto.getRandomValues(new Uint8Array(12)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;

export function createSandboxesView(
  api: ComputeRequester,
  options: { tenantId: string; scope?: 'mine' | 'all' },
): SandboxesView {
  const { tenantId } = options;
  let scope = options.scope ?? 'mine';
  const list = createValueResource({
    load: (signal) =>
      api.$request<{ items: SandboxRow[]; cursor?: string }>('sandboxes/list', { tenantId, scope }, { signal }),
  });
  const change = async <T>(run: () => Promise<T>): Promise<T> => {
    const result = await run();
    await list.refresh().catch(() => undefined);
    return result;
  };
  return {
    get: list.get,
    subscribe: list.subscribe,
    refresh: list.refresh,
    async scope(next) {
      scope = next;
      await list.refresh();
    },
    detail: (sandboxId) => api.$request<SandboxRow>('sandboxes/get', { tenantId, sandboxId }),
    templates: async () =>
      (await api.$request<{ items: SandboxTemplateRow[] }>('sandboxTemplates/list', { tenantId })).items,
    create: (input) =>
      change(() =>
        api.$request<SandboxRow>('sandboxes/create', {
          tenantId,
          templateId: input.templateId,
          ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
          ...(input.fromSnapshot ? { fromSnapshot: input.fromSnapshot } : {}),
          idempotencyKey: newKey(),
          wait: { timeoutMs: 20_000 },
        }),
      ),
    extend: (sandboxId, byMs) =>
      change(() => api.$request<SandboxRow>('sandboxes/extend', { tenantId, sandboxId, by: byMs })),
    snapshot: (sandboxId, snapshotOptions = {}) =>
      change(() =>
        api.$request('sandboxes/snapshot', {
          tenantId,
          sandboxId,
          includeMemory: snapshotOptions.includeMemory !== false,
          keep: snapshotOptions.keep === true,
          idempotencyKey: newKey(),
        }),
      ),
    remove: (sandboxId) =>
      change(async () => {
        await api.$request('sandboxes/delete', { tenantId, sandboxId });
      }),
    createTemplate: (input) => api.$request<SandboxTemplateRow>('sandboxTemplates/create', { tenantId, ...input }),
    updateTemplate: (templateId, fields) =>
      api.$request<SandboxTemplateRow>('sandboxTemplates/update', { tenantId, templateId, ...fields }),
    deleteTemplate: async (templateId) => {
      await api.$request('sandboxTemplates/delete', { tenantId, templateId });
    },
  };
}
