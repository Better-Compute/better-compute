// Per-tenant webhooks (PLAN.md §9.3, v0.3): subscriptions, the fan-out from the outbox into a delivery queue,
// and signed delivery with exponential backoff, dead letters and redelivery. Delivery is at-least-once;
// receivers dedupe on `X-Better-Compute-Delivery` (stable per webhook and event).

import {
  ComputeError,
  createIdGenerator,
  systemClock,
  type Clock,
  type ComputeEvent,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { matchesEventType, outboxTail, readOutbox, type OutboxCursor } from './outbox.js';
import { assertPublicDestination, checkWebhookUrl, type UrlPolicy } from './safe-url.js';
import { newWebhookSecret, openSecret, sealSecret } from './seal.js';
import { signatureHeader, webhookHeaders } from './signature.js';

export interface Webhook {
  id: string;
  tenantId: string;
  url: string;
  description?: string;
  events: string[];
  active: boolean;
  /** Epoch ms. */
  createdAt: number;
  updatedAt: number;
  /** Set while a rotated-out secret still signs deliveries. */
  previousSecretExpiresAt?: number;
  version: number;
}

export type DeliveryState = 'pending' | 'delivered' | 'dead' | 'cancelled';

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  tenantId: string;
  eventId: string;
  eventType: string;
  state: DeliveryState;
  attempts: number;
  nextAttemptAt: number;
  lastStatus?: number;
  lastError?: string;
  createdAt: number;
  deliveredAt?: number;
}

/** Secrets and policies the store needs. */
export interface WebhookSecrets {
  /** The deployment secret that seals signing secrets (at least 32 characters). */
  secret: string;
  /** Earlier deployment secrets, to open rows sealed before a rotation. */
  previousSecrets?: readonly string[];
}

export interface WebhookStoreOptions extends WebhookSecrets, UrlPolicy {
  clock?: Clock;
  /** Webhooks per tenant. Default 20. */
  maxPerTenant?: number;
}

const toMs = (value: unknown): number =>
  value instanceof Date
    ? value.getTime()
    : typeof value === 'string'
      ? Date.parse(value)
      : Number(value);

interface WebhookRow {
  id: string;
  tenant_id: string;
  url: string;
  description: string | null;
  events: string[];
  active: boolean;
  created_at: unknown;
  updated_at: unknown;
  previous_expires_at: unknown;
  version: string | number;
}

const webhookColumns =
  'id, tenant_id, url, description, events, active, created_at, updated_at, previous_expires_at, version';

function toWebhook(row: WebhookRow): Webhook {
  const webhook: Webhook = {
    id: row.id,
    tenantId: row.tenant_id,
    url: row.url,
    events: [...row.events],
    active: row.active,
    createdAt: toMs(row.created_at),
    updatedAt: toMs(row.updated_at),
    version: Number(row.version),
  };
  if (row.description !== null) webhook.description = row.description;
  if (row.previous_expires_at !== null && row.previous_expires_at !== undefined)
    webhook.previousSecretExpiresAt = toMs(row.previous_expires_at);
  return webhook;
}

interface DeliveryRow {
  id: string;
  webhook_id: string;
  tenant_id: string;
  event_id: string;
  event_type: string;
  state: DeliveryState;
  attempts: number;
  next_attempt_at: unknown;
  last_status: number | null;
  last_error: string | null;
  created_at: unknown;
  delivered_at: unknown;
}

const deliveryColumns =
  'id, webhook_id, tenant_id, event_id, event_type, state, attempts, next_attempt_at, last_status, last_error, created_at, delivered_at';

function toDelivery(row: DeliveryRow): WebhookDelivery {
  const delivery: WebhookDelivery = {
    id: row.id,
    webhookId: row.webhook_id,
    tenantId: row.tenant_id,
    eventId: row.event_id,
    eventType: row.event_type,
    state: row.state,
    attempts: Number(row.attempts),
    nextAttemptAt: toMs(row.next_attempt_at),
    createdAt: toMs(row.created_at),
  };
  if (row.last_status !== null) delivery.lastStatus = Number(row.last_status);
  if (row.last_error !== null) delivery.lastError = row.last_error;
  if (row.delivered_at !== null && row.delivered_at !== undefined)
    delivery.deliveredAt = toMs(row.delivered_at);
  return delivery;
}

const notFound = () => new ComputeError('NOT_FOUND', 'Webhook not found');

function checkSecrets(options: WebhookSecrets): void {
  if (typeof options.secret !== 'string' || options.secret.length < 32)
    throw new ComputeError('INVALID_CONFIG', 'The events secret must be at least 32 characters');
}

/** CRUD for webhooks; every call is scoped to one tenant and runs in the caller's transaction. */
export function webhookStore(options: WebhookStoreOptions) {
  checkSecrets(options);
  const clock = options.clock ?? systemClock;
  const maxPerTenant = options.maxPerTenant ?? 20;
  const context = (id: string) => `webhook:${id}`;
  const ids = createIdGenerator({ now: () => clock.now() });

  const get = async (tx: SqlTx, tenantId: string, id: string): Promise<Webhook> => {
    const { rows } = await tx.query<WebhookRow>(
      `SELECT ${webhookColumns} FROM webhooks WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (!rows[0]) throw notFound();
    return toWebhook(rows[0]);
  };

  return {
    get,
    async list(tx: SqlTx, tenantId: string): Promise<Webhook[]> {
      const { rows } = await tx.query<WebhookRow>(
        `SELECT ${webhookColumns} FROM webhooks WHERE tenant_id = $1 ORDER BY created_at, id`,
        [tenantId],
      );
      return rows.map(toWebhook);
    },
    /** Returns the webhook and its signing secret, shown this once. */
    async create(
      tx: SqlTx,
      input: { tenantId: string; url: string; events: string[]; description?: string },
    ): Promise<{ webhook: Webhook; secret: string }> {
      const url = checkWebhookUrl(input.url, options);
      const { rows: count } = await tx.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM webhooks WHERE tenant_id = $1',
        [input.tenantId],
      );
      if (Number(count[0]?.n ?? 0) >= maxPerTenant)
        throw new ComputeError(
          'QUOTA_EXCEEDED',
          `A tenant can have at most ${maxPerTenant} webhooks`,
        );
      const id = ids('whk');
      const secret = newWebhookSecret();
      const { rows } = await tx.query<WebhookRow>(
        `INSERT INTO webhooks (id, tenant_id, url, description, events, secret_sealed)
         VALUES ($1, $2, $3, $4, $5::text[], $6) RETURNING ${webhookColumns}`,
        [
          id,
          input.tenantId,
          url,
          input.description ?? null,
          [...new Set(input.events)],
          sealSecret(secret, options.secret, context(id)),
        ],
      );
      return { webhook: toWebhook(rows[0]!), secret };
    },
    async update(
      tx: SqlTx,
      tenantId: string,
      id: string,
      changes: { url?: string; events?: string[]; description?: string | null; active?: boolean },
    ): Promise<Webhook> {
      const url = changes.url === undefined ? null : checkWebhookUrl(changes.url, options);
      const { rows } = await tx.query<WebhookRow>(
        `UPDATE webhooks SET
           url = coalesce($3, url),
           events = coalesce($4::text[], events),
           description = CASE WHEN $5::bool THEN $6 ELSE description END,
           active = coalesce($7, active),
           updated_at = compute_now(),
           version = version + 1
         WHERE id = $1 AND tenant_id = $2 RETURNING ${webhookColumns}`,
        [
          id,
          tenantId,
          url,
          changes.events ? [...new Set(changes.events)] : null,
          changes.description !== undefined,
          changes.description ?? null,
          changes.active ?? null,
        ],
      );
      if (!rows[0]) throw notFound();
      // A paused webhook's pending deliveries are dropped, as better-iam does.
      if (changes.active === false)
        await tx.query(
          `UPDATE webhook_deliveries SET state = 'cancelled', last_error = 'webhook paused'
            WHERE webhook_id = $1 AND state = 'pending'`,
          [id],
        );
      return toWebhook(rows[0]);
    },
    /**
     * A new signing secret, returned once. With `keepPreviousSeconds` (≤ 1 day) the old one still signs
     * deliveries alongside the new one until then, so receivers can switch without dropping any.
     */
    async rotateSecret(
      tx: SqlTx,
      tenantId: string,
      id: string,
      keepPreviousSeconds = 0,
    ): Promise<{ webhook: Webhook; secret: string }> {
      if (
        !Number.isInteger(keepPreviousSeconds) ||
        keepPreviousSeconds < 0 ||
        keepPreviousSeconds > 86_400
      )
        throw new ComputeError('INVALID_INPUT', 'keepPreviousSeconds must be 0 to 86400');
      const { rows: current } = await tx.query<{ secret_sealed: string }>(
        'SELECT secret_sealed FROM webhooks WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
        [id, tenantId],
      );
      if (!current[0]) throw notFound();
      const secret = newWebhookSecret();
      const { rows } = await tx.query<WebhookRow>(
        `UPDATE webhooks SET
           secret_sealed = $3,
           previous_secret_sealed = CASE WHEN $4::int > 0 THEN $5 ELSE NULL END,
           previous_expires_at = CASE WHEN $4::int > 0 THEN compute_now() + make_interval(secs => $4::int) ELSE NULL END,
           updated_at = compute_now(),
           version = version + 1
         WHERE id = $1 AND tenant_id = $2 RETURNING ${webhookColumns}`,
        [
          id,
          tenantId,
          sealSecret(secret, options.secret, context(id)),
          keepPreviousSeconds,
          current[0].secret_sealed,
        ],
      );
      return { webhook: toWebhook(rows[0]!), secret };
    },
    async delete(tx: SqlTx, tenantId: string, id: string): Promise<void> {
      const { rowCount } = await tx.query('DELETE FROM webhooks WHERE id = $1 AND tenant_id = $2', [
        id,
        tenantId,
      ]);
      if (rowCount === 0) throw notFound();
    },
    /** Queues a `webhook.ping` delivery, due now. */
    async ping(tx: SqlTx, tenantId: string, id: string): Promise<WebhookDelivery> {
      const webhook = await get(tx, tenantId, id);
      const eventId = ids('evt');
      const event: ComputeEvent = {
        id: eventId,
        type: 'webhook.ping',
        tenantId,
        subject: `webhook/${webhook.id}`,
        time: new Date(clock.now()).toISOString(),
        sequence: '',
        data: { webhookId: webhook.id },
      };
      const [delivery] = await enqueueDeliveries(tx, [{ webhook, event }], clock);
      return delivery!;
    },
    async deliveries(
      tx: SqlTx,
      tenantId: string,
      id: string,
      filter: { state?: DeliveryState; limit?: number } = {},
    ): Promise<WebhookDelivery[]> {
      await get(tx, tenantId, id);
      const { rows } = await tx.query<DeliveryRow>(
        `SELECT ${deliveryColumns} FROM webhook_deliveries
          WHERE webhook_id = $1 AND ($2::text IS NULL OR state = $2)
          ORDER BY created_at DESC, id DESC LIMIT $3`,
        [id, filter.state ?? null, Math.min(filter.limit ?? 50, 200)],
      );
      return rows.map(toDelivery);
    },
    /** Puts a dead, cancelled or delivered delivery back in the queue, due now. */
    async redeliver(tx: SqlTx, tenantId: string, deliveryId: string): Promise<WebhookDelivery> {
      const { rows } = await tx.query<DeliveryRow>(
        `UPDATE webhook_deliveries SET state = 'pending', attempts = 0, next_attempt_at = compute_now(),
                last_error = NULL
          WHERE id = $1 AND tenant_id = $2
            AND EXISTS (SELECT 1 FROM webhooks w WHERE w.id = webhook_id AND w.active)
          RETURNING ${deliveryColumns}`,
        [deliveryId, tenantId],
      );
      if (!rows[0])
        throw new ComputeError('NOT_FOUND', 'Delivery not found, or its webhook is paused');
      return toDelivery(rows[0]);
    },
  };
}
export type WebhookStore = ReturnType<typeof webhookStore>;

/** The body a delivery signs and sends: the CloudEvents-style event. */
export function deliveryBody(event: ComputeEvent): string {
  return JSON.stringify({
    id: event.id,
    type: event.type,
    tenantId: event.tenantId,
    subject: event.subject,
    time: event.time,
    sequence: event.sequence,
    data: event.data,
  });
}

async function enqueueDeliveries(
  tx: SqlTx,
  items: readonly { webhook: Pick<Webhook, 'id' | 'tenantId'>; event: ComputeEvent }[],
  clock: Clock,
): Promise<WebhookDelivery[]> {
  if (items.length === 0) return [];
  const ids = createIdGenerator({ now: () => clock.now() });
  const { rows } = await tx.query<DeliveryRow>(
    `INSERT INTO webhook_deliveries (id, webhook_id, tenant_id, event_id, event_type, body, state)
     SELECT d.id, d.webhook_id, d.tenant_id, d.event_id, d.event_type, d.body, 'pending'
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
         AS d(id, webhook_id, tenant_id, event_id, event_type, body)
     ON CONFLICT (webhook_id, event_id) DO NOTHING
     RETURNING ${deliveryColumns}`,
    [
      items.map(() => ids('dlv')),
      items.map((item) => item.webhook.id),
      items.map((item) => item.webhook.tenantId),
      items.map((item) => item.event.id),
      items.map((item) => item.event.type),
      items.map((item) => deliveryBody(item.event)),
    ],
  );
  return rows.map(toDelivery);
}

export interface FanOutOptions {
  /** The cursor row name. Default `webhooks`. */
  name?: string;
  limit?: number;
  clock?: Clock;
}

/**
 * One fan-out pass: reads outbox events after the stored cursor and queues one delivery per matching,
 * active webhook of the event's tenant created before the event, then advances the cursor, in one
 * transaction (the cursor row is locked, so passes never overlap). A new cursor starts at the outbox tail:
 * history is not replayed to webhooks.
 */
export async function fanOutWebhooks(
  sql: SqlExecutor,
  options: FanOutOptions = {},
): Promise<{ events: number; queued: number; more: boolean }> {
  const name = options.name ?? 'webhooks';
  const clock = options.clock ?? systemClock;
  return sql.transaction(async (tx) => {
    let { rows } = await tx.query<{ txid_text: string; seq_text: string }>(
      'SELECT txid::text AS txid_text, seq::text AS seq_text FROM event_cursors WHERE name = $1 FOR UPDATE',
      [name],
    );
    if (!rows[0]) {
      const tail = await outboxTail(tx);
      await tx.query(
        `INSERT INTO event_cursors (name, txid, seq) VALUES ($1, $2::xid8, $3::bigint)
         ON CONFLICT (name) DO NOTHING`,
        [name, tail.txid, tail.seq],
      );
      ({ rows } = await tx.query(
        'SELECT txid::text AS txid_text, seq::text AS seq_text FROM event_cursors WHERE name = $1 FOR UPDATE',
        [name],
      ));
    }
    const after: OutboxCursor = { txid: rows[0]!.txid_text, seq: rows[0]!.seq_text };
    const page = await readOutbox(tx, { after, limit: options.limit ?? 500 });
    let queued = 0;
    if (page.events.length) {
      const tenants = [...new Set(page.events.map((event) => event.tenantId))];
      const { rows: hooks } = await tx.query<WebhookRow>(
        `SELECT ${webhookColumns} FROM webhooks WHERE active AND tenant_id = ANY($1::text[])`,
        [tenants],
      );
      const byTenant = new Map<string, Webhook[]>();
      for (const hook of hooks.map(toWebhook))
        byTenant.set(hook.tenantId, [...(byTenant.get(hook.tenantId) ?? []), hook]);
      const items = page.events.flatMap((event) =>
        (byTenant.get(event.tenantId) ?? [])
          .filter(
            (hook) =>
              hook.createdAt <= Date.parse(event.time) &&
              hook.events.some((pattern) => matchesEventType(pattern, event.type)),
          )
          .map((webhook) => ({ webhook, event })),
      );
      queued = (await enqueueDeliveries(tx, items, clock)).length;
    }
    await tx.query(
      `UPDATE event_cursors SET txid = $2::xid8, seq = $3::bigint, updated_at = compute_now()
        WHERE name = $1`,
      [name, page.cursor.txid, page.cursor.seq],
    );
    return { events: page.events.length, queued, more: page.more };
  });
}

export interface DeliverOptions extends WebhookSecrets, UrlPolicy {
  fetch?: typeof globalThis.fetch;
  clock?: Clock;
  /** Deliveries claimed per pass. Default 50. */
  limit?: number;
  /** Per-request timeout. Default 10 s. */
  timeoutMs?: number;
  /** Attempts before a delivery is dead. Default 8. */
  maxAttempts?: number;
  /** Retry delays after attempt n (seconds); the last repeats. Default 1m, 5m, 30m, 2h, 6h, 12h, 24h. */
  backoffSeconds?: readonly number[];
  /** Host resolution for the SSRF check (tests). */
  resolve?: (host: string) => Promise<string[]>;
}

const defaultBackoff = [60, 300, 1_800, 7_200, 21_600, 43_200, 86_400];

/**
 * One delivery pass: claims due deliveries (leased for the timeout plus a margin, so a crashed worker's
 * claims come back), sends them signed, and records the outcome: `delivered` on 2xx, otherwise retried with
 * backoff until `maxAttempts`, then `dead`. Deliveries of a missing or paused webhook are `cancelled`.
 */
export async function deliverWebhooks(
  sql: SqlExecutor,
  options: DeliverOptions,
): Promise<{ attempted: number; delivered: number; failed: number; dead: number }> {
  checkSecrets(options);
  const clock = options.clock ?? systemClock;
  const send = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxAttempts = options.maxAttempts ?? 8;
  const backoff = options.backoffSeconds?.length ? options.backoffSeconds : defaultBackoff;
  const secrets = [options.secret, ...(options.previousSecrets ?? [])];
  const leaseSeconds = Math.ceil(timeoutMs / 1000) + 30;

  const { rows: claimed } = await sql.query<{
    id: string;
    webhook_id: string;
    event_id: string;
    event_type: string;
    body: string;
    attempts: number;
    url: string | null;
    active: boolean | null;
    secret_sealed: string | null;
    previous_secret_sealed: string | null;
    previous_live: boolean | null;
  }>(
    `WITH due AS (
       SELECT id FROM webhook_deliveries
        WHERE state = 'pending' AND next_attempt_at <= compute_now()
        ORDER BY next_attempt_at, id LIMIT $1 FOR UPDATE SKIP LOCKED
     ), claimed AS (
       UPDATE webhook_deliveries d SET attempts = d.attempts + 1,
              next_attempt_at = compute_now() + make_interval(secs => $2::int)
         FROM due WHERE d.id = due.id
       RETURNING d.id, d.webhook_id, d.event_id, d.event_type, d.body, d.attempts
     )
     SELECT c.*, w.url, w.active, w.secret_sealed, w.previous_secret_sealed,
            (w.previous_expires_at > compute_now()) AS previous_live
       FROM claimed c LEFT JOIN webhooks w ON w.id = c.webhook_id`,
    [options.limit ?? 50, leaseSeconds],
  );

  let delivered = 0;
  let failed = 0;
  let dead = 0;
  await Promise.all(
    claimed.map(async (row) => {
      if (!row.url || !row.active || !row.secret_sealed) {
        await sql.query(
          `UPDATE webhook_deliveries SET state = 'cancelled', last_error = 'webhook paused or deleted'
            WHERE id = $1`,
          [row.id],
        );
        return;
      }
      let status: number | undefined;
      let error: string | undefined;
      try {
        await assertPublicDestination(row.url, options, options.resolve);
        const context = `webhook:${row.webhook_id}`;
        const signing = [openSecret(row.secret_sealed, secrets, context)];
        if (row.previous_secret_sealed && row.previous_live)
          signing.push(openSecret(row.previous_secret_sealed, secrets, context));
        const timestamp = Math.floor(clock.now() / 1000);
        const response = await send(row.url, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            'content-type': 'application/json',
            'user-agent': 'better-compute-webhooks/1',
            [webhookHeaders.event]: row.event_type,
            [webhookHeaders.delivery]: row.id,
            [webhookHeaders.webhook]: row.webhook_id,
            [webhookHeaders.timestamp]: String(timestamp),
            [webhookHeaders.signature]: signatureHeader(signing, timestamp, row.body),
          },
          body: row.body,
        });
        status = response.status;
        await response.body?.cancel().catch(() => {});
        if (!response.ok) error = `The endpoint responded with status ${response.status}`;
      } catch (caught) {
        error = (caught as Error).message.slice(0, 500);
      }
      if (error === undefined) {
        delivered++;
        await sql.query(
          `UPDATE webhook_deliveries SET state = 'delivered', delivered_at = compute_now(),
                  last_status = $2, last_error = NULL
            WHERE id = $1`,
          [row.id, status ?? null],
        );
        return;
      }
      const attempts = Number(row.attempts);
      const isDead = attempts >= maxAttempts;
      if (isDead) dead++;
      else failed++;
      const delay = backoff[Math.min(attempts - 1, backoff.length - 1)]!;
      await sql.query(
        `UPDATE webhook_deliveries SET state = $2, last_status = $3, last_error = $4,
                next_attempt_at = compute_now() + make_interval(secs => $5::int)
          WHERE id = $1`,
        [row.id, isDead ? 'dead' : 'pending', status ?? null, error, delay],
      );
    }),
  );
  return { attempted: claimed.length, delivered, failed, dead };
}
