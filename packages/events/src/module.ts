// `eventsModule()`: the §9.2 `webhooks` group (v0.3; every method decides `compute:webhooks:manage` on
// `compute-tenant/{t}`) and the workers that fan outbox events out to webhooks and deliver them.

import {
  defineMethod,
  defineModule,
  field,
  idPrefixes,
  manifest,
  type ComputeModule,
  type Finding,
  type MethodDefinition,
  type Reconciler,
  type SqlTx,
} from '@better-compute/core';
import { eventCatalog, type EventFamily } from './catalog.js';
import { eventsMigrations } from './migrations.js';
import {
  deliveryRetention,
  pruneWebhookDeliveries,
  purgeTenantWebhooks,
  type DeliveryRetention,
} from './retention.js';
import type { UrlPolicy } from './safe-url.js';
import {
  deliverWebhooks,
  ensureFanOutCursor,
  fanOutWebhooks,
  webhookStore,
  type DeliverOptions,
  type DeliveryState,
  type Webhook,
  type WebhookDelivery,
  type WebhookSecrets,
} from './webhooks.js';

const tenantId = field.string({ pattern: '^[A-Za-z0-9._:-]{1,128}$' });
const webhookId = field.string({ pattern: `^${idPrefixes.webhook}_[0-9a-hjkmnp-tv-z]{26,52}$` });
const eventPattern = field.string({
  pattern: '^(\\*|[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)*(\\.\\*)?)$',
  maxLength: 128,
});
const events = field.list(eventPattern, { min: 1, max: 20 });
const description = field.string({ maxLength: 256 });

const createInput = manifest({
  tenantId,
  url: field.url(),
  events,
  description: description.optional(),
});
const listInput = manifest({ tenantId });
const refInput = manifest({ tenantId, webhookId });
const updateInput = manifest({
  tenantId,
  webhookId,
  url: field.url().optional(),
  events: events.optional(),
  description: description.optional(),
  active: field.boolean().optional(),
});
const rotateInput = manifest({
  tenantId,
  webhookId,
  keepPreviousSeconds: field.int({ min: 0, max: 86_400 }).optional(),
});
const deliveriesInput = manifest({
  tenantId,
  webhookId,
  state: field.option(['pending', 'delivered', 'dead', 'cancelled']).optional(),
  limit: field.int({ min: 1, max: 200 }).optional(),
});
const redeliverInput = manifest({
  tenantId,
  deliveryId: field.string({ pattern: '^dlv_[0-9a-hjkmnp-tv-z]{26,52}$' }),
});

type Input<M extends { parse(value: unknown): unknown }> = ReturnType<M['parse']>;

export type EventsApi = {
  webhooks: {
    create: MethodDefinition<Input<typeof createInput>, { webhook: Webhook; secret: string }>;
    list: MethodDefinition<Input<typeof listInput>, { items: Webhook[] }>;
    get: MethodDefinition<Input<typeof refInput>, Webhook>;
    update: MethodDefinition<Input<typeof updateInput>, Webhook>;
    rotateSecret: MethodDefinition<Input<typeof rotateInput>, { webhook: Webhook; secret: string }>;
    delete: MethodDefinition<Input<typeof refInput>, { deleted: true }>;
    ping: MethodDefinition<Input<typeof refInput>, { delivery: WebhookDelivery }>;
    deliveries: MethodDefinition<Input<typeof deliveriesInput>, { items: WebhookDelivery[] }>;
    redeliver: MethodDefinition<Input<typeof redeliverInput>, { delivery: WebhookDelivery }>;
    /** The event catalog subscriptions are checked against. */
    eventTypes: MethodDefinition<Input<typeof listInput>, { items: EventFamily[] }>;
  };
};

export interface EventsModuleOptions extends WebhookSecrets, UrlPolicy {
  fetch?: typeof globalThis.fetch;
  maxPerTenant?: number;
  /** Counts every event the fan-out reads by catalog family (`eventCounter(registry)` from observability). */
  countEvent?: (family: string, module: string, type: string) => void;
  /** Plugin event families subscriptions may name, or `false` to accept any pattern (see `eventCatalog`). */
  extraEvents?: readonly EventFamily[] | false;
  delivery?: Pick<
    DeliverOptions,
    'limit' | 'timeoutMs' | 'maxAttempts' | 'backoffSeconds' | 'resolve'
  >;
  /**
   * How long delivery history is kept (the hourly `events.prune` reconciler): delivered and cancelled 30 days,
   * dead letters 90 by default. `false` keeps everything.
   */
  retention?: DeliveryRetention | false;
}

/** The events module: webhook management, outbox fan-out and signed delivery. */
export function eventsModule(options: EventsModuleOptions): ComputeModule<'events', EventsApi> {
  const store = webhookStore(options);
  const method = <I, O>(
    kind: 'read' | 'mutation',
    schema: { parse(value: unknown): I; jsonSchema(): object },
    run: (tx: SqlTx, input: I) => Promise<O>,
  ) =>
    defineMethod<I, O>({
      action: 'compute:webhooks:manage',
      kind,
      resource: (input) => ({ type: 'tenant', id: (input as { tenantId: string }).tenantId }),
      // `jsonSchema` describes the input for the API reference and tool schemas.
      validate: Object.assign((input: unknown) => schema.parse(input), {
        jsonSchema: schema.jsonSchema(),
      }),
      handler: (context, input) => context.sql.transaction((tx) => run(tx, input)),
    });

  const api = (): EventsApi => ({
    webhooks: {
      create: method('mutation', createInput, (tx, input) =>
        store.create(tx, {
          tenantId: input.tenantId,
          url: input.url,
          events: input.events,
          ...(input.description === undefined ? {} : { description: input.description }),
        }),
      ),
      list: method('read', listInput, async (tx, input) => ({
        items: await store.list(tx, input.tenantId),
      })),
      get: method('read', refInput, (tx, input) => store.get(tx, input.tenantId, input.webhookId)),
      update: method('mutation', updateInput, (tx, input) => {
        const { tenantId: tenant, webhookId: id, ...changes } = input;
        return store.update(tx, tenant, id, changes);
      }),
      rotateSecret: method('mutation', rotateInput, (tx, input) =>
        store.rotateSecret(tx, input.tenantId, input.webhookId, input.keepPreviousSeconds ?? 0),
      ),
      delete: method('mutation', refInput, async (tx, input) => {
        await store.delete(tx, input.tenantId, input.webhookId);
        return { deleted: true as const };
      }),
      ping: method('mutation', refInput, async (tx, input) => ({
        delivery: await store.ping(tx, input.tenantId, input.webhookId),
      })),
      deliveries: method('read', deliveriesInput, async (tx, input) => ({
        items: await store.deliveries(tx, input.tenantId, input.webhookId, {
          ...(input.state ? { state: input.state as DeliveryState } : {}),
          ...(input.limit ? { limit: input.limit } : {}),
        }),
      })),
      redeliver: method('mutation', redeliverInput, async (tx, input) => ({
        delivery: await store.redeliver(tx, input.tenantId, input.deliveryId),
      })),
      eventTypes: method('read', listInput, async () => ({
        items: [...eventCatalog, ...(options.extraEvents || [])],
      })),
    },
  });

  const reconcilers: Reconciler[] = [
    {
      name: 'events.fanout',
      shardBy: 'none',
      periodic: [{ key: 'webhooks', every: '1s' }],
      run: async (context) =>
        (
          await fanOutWebhooks(context.sql, {
            clock: context.clock,
            ...(options.countEvent
              ? {
                  countEvent: options.countEvent,
                  catalog: [...eventCatalog, ...(options.extraEvents || [])],
                }
              : {}),
          })
        ).more
          ? 'SYNC_AGAIN'
          : 'DONE',
    },
    {
      name: 'events.deliver',
      shardBy: 'none',
      periodic: [{ key: 'deliveries', every: '2s' }],
      run: async (context) => {
        const limit = options.delivery?.limit ?? 50;
        const result = await deliverWebhooks(context.sql, {
          ...options,
          ...options.delivery,
          clock: context.clock,
        });
        return result.attempted >= limit ? 'SYNC_AGAIN' : 'DONE';
      },
    },
  ];
  if (options.retention !== false) {
    // Checked here, so a bad setting fails when the module is defined rather than in the first pass.
    const retention = deliveryRetention(options.retention);
    const batch = 5_000;
    reconcilers.push({
      name: 'events.prune',
      shardBy: 'none',
      periodic: [{ key: 'deliveries', every: '1h' }],
      run: async (context) =>
        (await pruneWebhookDeliveries(context.sql, retention, batch)) >= batch
          ? 'SYNC_AGAIN'
          : 'DONE',
    });
  }

  const selfCheck = async (
    context: Parameters<NonNullable<ComputeModule['selfCheck']>>[0],
  ): Promise<Finding[]> => {
    const { rows } = await context.sql.query<{ dead: string; backlog: string }>(
      `SELECT count(*) FILTER (WHERE state = 'dead')::text AS dead,
              count(*) FILTER (WHERE state = 'pending' AND next_attempt_at < compute_now() - interval '5 minutes')::text AS backlog
         FROM webhook_deliveries`,
    );
    const findings: Finding[] = [];
    const dead = Number(rows[0]?.dead ?? 0);
    const backlog = Number(rows[0]?.backlog ?? 0);
    if (dead > 0)
      findings.push({
        check: 'events.webhook-dead-letters',
        severity: 'warning',
        message: `${dead} webhook deliveries failed every attempt`,
        fix: 'Inspect webhooks.deliveries({ state: "dead" }) and redeliver once the endpoint is fixed',
        count: dead,
      });
    if (backlog > 1000)
      findings.push({
        check: 'events.webhook-backlog',
        severity: 'warning',
        message: `${backlog} webhook deliveries are overdue`,
        fix: 'Run a worker with the events.deliver reconciler',
        count: backlog,
      });
    return findings;
  };

  return defineModule({
    name: 'events',
    migrations: [...eventsMigrations],
    api,
    reconcilers,
    selfCheck,
    // Anchor the fan-out cursor now, so events committed before the first fan-out pass are not skipped.
    start: (context) => ensureFanOutCursor(context.sql),
    // §12.8 purge: a deleted tenant's subscriptions (and, by cascade, their deliveries and sealed secrets) go, so
    // nothing more is sent to its endpoints; bounded per call.
    tenantDeleted: (context, tenantId) => purgeTenantWebhooks(context.sql, tenantId),
  });
}
