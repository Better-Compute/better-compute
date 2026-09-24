import {
  ComputeError,
  defineMethod,
  definePlugin,
  field,
  manifest,
  type AdmissionContext,
  type IamPort,
  type SqlExecutor,
} from '@better-compute/core';

// Shared pieces of the server, HTTP and client tests: tenants, options, a spying executor and a
// small plugin with one method per envelope path.

export const ROOT = 'tenant-root';
export const ACME = 'tenant-acme';
export const OTHER = 'tenant-other';
export const BASE_URL = 'https://compute.example.test';
export const SECRET = 'better-compute-server-tests-secret-0123456789';
export const NODE_ID = 'node_01jz0000000000000000000000';

/** The options every test server starts from. */
export function options(database: SqlExecutor, iam: IamPort) {
  return { database, iam, secret: SECRET, baseURL: BASE_URL, rootTenantId: ROOT };
}

export interface SpyExecutor extends SqlExecutor {
  /** `transaction`, `migrate` and `query <sql>` for every call made on the executor itself. */
  readonly log: string[];
}

/** Forwards to `inner` and records what was asked of it (statements inside a `tx` are not seen). */
export function spyExecutor(inner: SqlExecutor): SpyExecutor {
  const log: string[] = [];
  return {
    dialect: inner.dialect,
    kind: inner.kind,
    log,
    query(text, params) {
      log.push(`query ${text}`);
      return inner.query(text, params);
    },
    transaction(fn, transactionOptions) {
      log.push('transaction');
      return inner.transaction(fn, transactionOptions);
    },
    migrate(extra) {
      log.push('migrate');
      return inner.migrate(extra);
    },
    close: () => inner.close(),
  };
}

const widgetInput = manifest({
  tenantId: field.string({ pattern: '^[A-Za-z0-9._:-]{1,128}$' }),
  widgetId: field.string({ pattern: '^[a-z0-9-]{1,64}$' }),
});
type WidgetInput = { tenantId: string; widgetId: string };

/** Keys `widgets.limited` has refused once already. */
const limited = new Set<string>();

/**
 * Plugin `acme` (actions `compute:acme:*`, table `plg_acme_widgets`): `widgets.poke` writes a row,
 * `widgets.fail` writes then throws `CONFLICT`, `widgets.get` reads, `widgets.limited` answers
 * `RATE_LIMITED` once per widget id, `widgets.crash` throws an unexpected error.
 */
export const acme = definePlugin({
  id: 'acme',
  catalog: { actions: ['compute:acme:poke', 'compute:acme:read'] },
  migrations: [
    {
      name: 'acme/0001_widgets',
      sql: 'CREATE TABLE plg_acme_widgets (id text PRIMARY KEY, tenant_id text NOT NULL)',
    },
  ],
  api: () => ({
    widgets: {
      poke: defineMethod<WidgetInput, { poked: string; admission?: AdmissionContext }>({
        action: 'compute:acme:poke',
        kind: 'mutation',
        resource: (input) => ({ type: 'tenant', id: input.tenantId }),
        validate: (input) => widgetInput.parse(input),
        async handler(context, input) {
          await context.sql.query('INSERT INTO plg_acme_widgets (id, tenant_id) VALUES ($1, $2)', [
            input.widgetId,
            input.tenantId,
          ]);
          return {
            poked: input.widgetId,
            ...(context.admission ? { admission: context.admission } : {}),
          };
        },
      }),
      fail: defineMethod<WidgetInput, never>({
        action: 'compute:acme:poke',
        kind: 'mutation',
        resource: (input) => ({ type: 'tenant', id: input.tenantId }),
        validate: (input) => widgetInput.parse(input),
        async handler(context, input) {
          await context.sql.query('INSERT INTO plg_acme_widgets (id, tenant_id) VALUES ($1, $2)', [
            input.widgetId,
            input.tenantId,
          ]);
          throw new ComputeError('CONFLICT', 'Widget changed meanwhile', undefined, {
            widgetId: input.widgetId,
          });
        },
      }),
      get: defineMethod<WidgetInput, { widgetId: string; exists: boolean }>({
        action: 'compute:acme:read',
        kind: 'read',
        resource: (input) => ({ type: 'tenant', id: input.tenantId }),
        validate: (input) => widgetInput.parse(input),
        async handler(context, input) {
          const { rowCount } = await context.sql.query(
            'SELECT 1 FROM plg_acme_widgets WHERE id = $1 AND tenant_id = $2',
            [input.widgetId, input.tenantId],
          );
          return { widgetId: input.widgetId, exists: rowCount > 0 };
        },
      }),
      limited: defineMethod<WidgetInput, { widgetId: string }>({
        action: 'compute:acme:read',
        kind: 'read',
        resource: (input) => ({ type: 'tenant', id: input.tenantId }),
        validate: (input) => widgetInput.parse(input),
        async handler(_context, input) {
          if (!limited.has(input.widgetId)) {
            limited.add(input.widgetId);
            throw new ComputeError('RATE_LIMITED', 'Slow down', undefined, { retryAfterMs: 20 });
          }
          return { widgetId: input.widgetId };
        },
      }),
      crash: defineMethod<WidgetInput, never>({
        action: 'compute:acme:read',
        kind: 'read',
        resource: (input) => ({ type: 'tenant', id: input.tenantId }),
        validate: (input) => widgetInput.parse(input),
        async handler() {
          throw new Error('connection to db-7.internal:5432 failed for user admin');
        },
      }),
    },
  }),
});

/** A logger that keeps what it is told, for tests that provoke unexpected errors. */
export function memoryLogger() {
  const entries: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
  const at =
    (level: string) =>
    (message: string, fields?: Record<string, unknown>): void => {
      entries.push({ level, message, ...(fields ? { fields } : {}) });
    };
  return { entries, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}
