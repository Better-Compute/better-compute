import { createValueResource, type ValueResource } from './list.js';
import type { ComputeRequester } from './resources.js';
import { createStore, type Store } from './store.js';

// Webhooks (PLAN.md §9.3, the events module's `webhooks` group): a tenant's endpoints, their recent deliveries and
// the actions on them. The signing secret is returned only by create and rotateSecret; the view holds it until the
// person dismisses it (it is never stored or re-read), so it can be shown once and copied.

export interface WebhookRow {
  id: string;
  url: string;
  description?: string;
  events: string[];
  active: boolean;
  createdAt: number;
  updatedAt: number;
  previousSecretExpiresAt?: number;
  version: number;
}

export interface WebhookDeliveryRow {
  id: string;
  webhookId: string;
  eventId: string;
  eventType: string;
  state: 'pending' | 'delivered' | 'dead' | 'cancelled';
  attempts: number;
  nextAttemptAt: number;
  lastStatus?: number;
  lastError?: string;
  createdAt: number;
  deliveredAt?: number;
}

/** Deliveries at a glance: counts by state, and the most recent failure worth showing. */
export interface DeliverySummary {
  pending: number;
  delivered: number;
  dead: number;
  cancelled: number;
  lastFailure?: { eventType: string; status?: number; error?: string; at: number };
}

export function deliverySummary(rows: readonly WebhookDeliveryRow[]): DeliverySummary {
  const summary: DeliverySummary = { pending: 0, delivered: 0, dead: 0, cancelled: 0 };
  for (const row of rows) summary[row.state]++;
  const failed = rows
    .filter((row) => row.state === 'dead' || row.lastError !== undefined || (row.lastStatus ?? 0) >= 400)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (failed)
    summary.lastFailure = {
      eventType: failed.eventType,
      ...(failed.lastStatus !== undefined ? { status: failed.lastStatus } : {}),
      ...(failed.lastError !== undefined ? { error: failed.lastError } : {}),
      at: failed.createdAt,
    };
  return summary;
}

/** The signing secret of a webhook, shown once after create or rotate. */
export interface RevealedSecret {
  webhookId: string;
  secret: string;
}

export interface WebhooksView extends ValueResource<{ items: WebhookRow[] }> {
  /** The secret the last create or rotate returned, until `dismissSecret()`. */
  readonly secret: Store<RevealedSecret | undefined>;
  dismissSecret(): void;
  create(input: { url: string; events: string[]; description?: string }): Promise<WebhookRow>;
  setActive(webhookId: string, active: boolean): Promise<WebhookRow>;
  rotateSecret(webhookId: string, keepPreviousSeconds?: number): Promise<WebhookRow>;
  remove(webhookId: string): Promise<void>;
  /** Sends a `webhook.ping` delivery now. */
  ping(webhookId: string): Promise<WebhookDeliveryRow>;
  deliveries(webhookId: string, state?: WebhookDeliveryRow['state']): Promise<WebhookDeliveryRow[]>;
  redeliver(deliveryId: string): Promise<WebhookDeliveryRow>;
  /** Event families subscriptions may name (`reservation.*`, `node.connected`, …). */
  eventTypes(): Promise<unknown[]>;
}

export function createWebhooksView(api: ComputeRequester, options: { tenantId: string }): WebhooksView {
  const { tenantId } = options;
  const list = createValueResource({
    load: (signal) => api.$request<{ items: WebhookRow[] }>('webhooks/list', { tenantId }, { signal }),
  });
  const secret = createStore<RevealedSecret | undefined>(undefined);
  /** Runs a change, then reloads the list (a failed reload leaves the change's own result standing). */
  const change = async <T>(run: () => Promise<T>): Promise<T> => {
    const result = await run();
    await list.refresh().catch(() => undefined);
    return result;
  };
  return {
    get: list.get,
    subscribe: list.subscribe,
    refresh: list.refresh,
    secret,
    dismissSecret: () => secret.set(undefined),
    create: (input) =>
      change(async () => {
        const created = await api.$request<{ webhook: WebhookRow; secret: string }>('webhooks/create', {
          tenantId,
          url: input.url,
          events: input.events,
          ...(input.description ? { description: input.description } : {}),
        });
        secret.set({ webhookId: created.webhook.id, secret: created.secret });
        return created.webhook;
      }),
    setActive: (webhookId, active) =>
      change(() => api.$request<WebhookRow>('webhooks/update', { tenantId, webhookId, active })),
    rotateSecret: (webhookId, keepPreviousSeconds) =>
      change(async () => {
        const rotated = await api.$request<{ webhook: WebhookRow; secret: string }>('webhooks/rotateSecret', {
          tenantId,
          webhookId,
          ...(keepPreviousSeconds !== undefined ? { keepPreviousSeconds } : {}),
        });
        secret.set({ webhookId, secret: rotated.secret });
        return rotated.webhook;
      }),
    remove: (webhookId) =>
      change(async () => {
        await api.$request('webhooks/delete', { tenantId, webhookId });
        if (secret.get()?.webhookId === webhookId) secret.set(undefined);
      }),
    ping: async (webhookId) =>
      (await api.$request<{ delivery: WebhookDeliveryRow }>('webhooks/ping', { tenantId, webhookId })).delivery,
    deliveries: async (webhookId, state) =>
      (
        await api.$request<{ items: WebhookDeliveryRow[] }>('webhooks/deliveries', {
          tenantId,
          webhookId,
          ...(state ? { state } : {}),
        })
      ).items,
    redeliver: async (deliveryId) =>
      (await api.$request<{ delivery: WebhookDeliveryRow }>('webhooks/redeliver', { tenantId, deliveryId }))
        .delivery,
    eventTypes: async () =>
      (await api.$request<{ items: unknown[] }>('webhooks/eventTypes', { tenantId })).items,
  };
}
