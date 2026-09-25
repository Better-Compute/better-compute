// The memory-resident authz projection (PLAN.md §12.4). The resolver runs inside better-iam's locked
// decision transaction, so a hit must do no I/O: each process loads `authz_projection` at start, then
// tails `authz_changes` with the (txid, seq) cursor, reading only transactions older than the snapshot's
// xmin so no commit is ever skipped. A miss does one primary-key read with a short timeout.

import {
  ComputeError,
  type AuthzAttributes,
  type AuthzRow,
  type Clock,
  type SqlExecutor,
} from '@better-compute/core';

/** A projection row: an `AuthzRow` plus in-flight `extend`/`renew` values (§10.5). */
export interface ProjectionRow extends AuthzRow {
  pending?: AuthzAttributes;
}

/** A position in `authz_changes`: xid8 and seq, both as decimal strings. */
export interface ChangeCursor {
  txid: string;
  seq: string;
}

export interface ProjectionChange {
  type: string;
  id: string;
  tenantId: string;
}

/** Where the projection reads from; `sqlProjectionSource(sql)` in production. */
export interface ProjectionSource {
  /** Every row plus the cursor to tail from, read in one snapshot. */
  load(): Promise<{ rows: ProjectionRow[]; cursor: ChangeCursor }>;
  /** Changes after `cursor` from finished transactions, oldest first, with the rows as they are now. */
  changes(
    cursor: ChangeCursor,
    limit: number,
  ): Promise<{ changed: ProjectionChange[]; rows: ProjectionRow[]; cursor: ChangeCursor }>;
  /** One row by primary key (the miss path). */
  get(type: string, id: string, tenantId: string): Promise<ProjectionRow | undefined>;
}

export type ResolveOutcome =
  | { status: 'hit'; row: ProjectionRow }
  | { status: 'miss' }
  | { status: 'timeout' }
  | { status: 'unavailable' };

export interface AuthzProjection {
  /** Loaded and not stopped: until then the resolver denies. */
  readonly ready: boolean;
  readonly size: number;
  readonly cursor: ChangeCursor | undefined;
  /** Memory only. */
  get(type: string, id: string, tenantId: string): ProjectionRow | undefined;
  /** Memory first; on a miss one bounded read from the source, cached on success. */
  resolve(type: string, id: string, tenantId: string): Promise<ResolveOutcome>;
  /** Inserts or replaces a row in memory (e.g. a draft the API just committed). */
  put(row: ProjectionRow): void;
  remove(type: string, id: string, tenantId?: string): void;
  /** Loads every row from the source; the projection is ready afterwards. */
  load(): Promise<void>;
  /** One tail pass; returns how many changes it applied. */
  sync(): Promise<number>;
  /**
   * Re-reads one row from the source into memory (an admission's committed draft or pending change,
   * §12.4), or drops it when the source has none. A failed read drops the row too, so the next
   * `resolve` takes the bounded miss path instead of a stale copy.
   */
  refresh(type: string, id: string, tenantId: string): Promise<void>;
  /** Loads, then tails every `pollMs` until `stop()`. */
  start(): Promise<void>;
  stop(): void;
  /** Swaps the source (binding a bridge to a store); the projection is not ready until `load()`. */
  setSource(source: ProjectionSource): void;
}

export interface AuthzProjectionOptions {
  source?: ProjectionSource;
  /** The miss-path read budget. Default 20 ms. */
  missTimeoutMs?: number;
  /** The tail interval (staleness bound). Default 1000 ms. */
  pollMs?: number;
  /** Changes read per tail query. Default 1000. */
  batch?: number;
  clock?: Clock;
  onError?(error: unknown): void;
}

const key = (type: string, id: string, tenantId: string) => `${type}\u0000${id}\u0000${tenantId}`;
const idKey = (type: string, id: string) => `${type}\u0000${id}`;

export function createAuthzProjection(options: AuthzProjectionOptions = {}): AuthzProjection {
  let source = options.source;
  const missTimeoutMs = options.missTimeoutMs ?? 20;
  const pollMs = options.pollMs ?? 1000;
  const batch = options.batch ?? 1000;
  const rows = new Map<string, ProjectionRow>();
  // (type, id) → tenants holding a row, so remove() without a tenant is not a scan.
  const views = new Map<string, Set<string>>();
  let cursor: ChangeCursor | undefined;
  let ready = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let syncing: Promise<number> | undefined;
  // Fresh single-row reads (refresh, the miss path) against tail pages read concurrently: a page whose read began
  // before a row's fresh read finished may carry an older state of that row, so it re-reads the row instead of
  // applying its copy. `epoch` orders page starts and fresh reads; `freshAt` holds each fresh row's epoch.
  let epoch = 0;
  const freshAt = new Map<string, number>();

  const put = (row: ProjectionRow) => {
    rows.set(key(row.type, row.id, row.tenantId), freezeRow(row));
    const tenants = views.get(idKey(row.type, row.id)) ?? new Set<string>();
    tenants.add(row.tenantId);
    views.set(idKey(row.type, row.id), tenants);
  };
  const remove = (type: string, id: string, tenantId?: string) => {
    const tenants = views.get(idKey(type, id));
    if (!tenants) return;
    for (const tenant of tenantId === undefined ? [...tenants] : [tenantId]) {
      rows.delete(key(type, id, tenant));
      tenants.delete(tenant);
    }
    if (tenants.size === 0) views.delete(idKey(type, id));
  };
  const requireSource = () => {
    if (!source) throw new ComputeError('INVALID_STATE', 'The authz projection has no source yet');
    return source;
  };

  /** Puts (or drops) a row read fresh by primary key, and marks it so older tail pages don't overwrite it. */
  const putFresh = (type: string, id: string, tenantId: string, row: ProjectionRow | undefined) => {
    if (row) put(row);
    else remove(type, id, tenantId);
    freshAt.set(key(type, id, tenantId), ++epoch);
  };

  const readFresh = async (type: string, id: string, tenantId: string) => {
    const from = requireSource();
    try {
      putFresh(type, id, tenantId, await from.get(type, id, tenantId));
    } catch (error) {
      // Fail closed: without the row the next `resolve` takes the bounded miss path, never a stale copy.
      remove(type, id, tenantId);
      options.onError?.(error);
    }
  };

  const sync = (): Promise<number> => {
    syncing ??= (async () => {
      try {
        const from = requireSource();
        if (!cursor) return 0;
        let applied = 0;
        for (;;) {
          const started = ++epoch;
          // Marks older than this page's start concern no page from now on.
          for (const [marked, at] of freshAt) if (at < started) freshAt.delete(marked);
          const page = await from.changes(cursor, batch);
          const current = new Map(
            page.rows.map((row) => [key(row.type, row.id, row.tenantId), row]),
          );
          const reread: ProjectionChange[] = [];
          for (const change of page.changed) {
            const changeKey = key(change.type, change.id, change.tenantId);
            if ((freshAt.get(changeKey) ?? 0) > started) {
              // Read fresh while this page was being read: the page's copy may be older.
              reread.push(change);
              continue;
            }
            const row = current.get(changeKey);
            if (row) put(row);
            else remove(change.type, change.id, change.tenantId);
          }
          for (const change of reread) await readFresh(change.type, change.id, change.tenantId);
          applied += page.changed.length;
          cursor = page.cursor;
          if (page.changed.length < batch) return applied;
        }
      } finally {
        syncing = undefined;
      }
    })();
    return syncing;
  };

  return {
    get ready() {
      return ready;
    },
    get size() {
      return rows.size;
    },
    get cursor() {
      return cursor;
    },
    get: (type, id, tenantId) => rows.get(key(type, id, tenantId)),
    async resolve(type, id, tenantId) {
      if (!ready || !source) return { status: 'unavailable' };
      const hit = rows.get(key(type, id, tenantId));
      if (hit) return { status: 'hit', row: hit };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const row = await Promise.race([
          source.get(type, id, tenantId),
          new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), missTimeoutMs);
          }),
        ]);
        if (row === 'timeout') return { status: 'timeout' };
        if (!row) return { status: 'miss' };
        putFresh(type, id, tenantId, row);
        return { status: 'hit', row: rows.get(key(type, id, tenantId))! };
      } catch (error) {
        options.onError?.(error);
        return { status: 'timeout' };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    put,
    remove,
    async load() {
      const loaded = await requireSource().load();
      rows.clear();
      views.clear();
      for (const row of loaded.rows) put(row);
      cursor = loaded.cursor;
      ready = true;
    },
    sync,
    async refresh(type, id, tenantId) {
      if (!ready || !source) return;
      await readFresh(type, id, tenantId);
    },
    async start() {
      await this.load();
      if (timer) return;
      timer = setInterval(() => {
        sync().catch((error: unknown) => options.onError?.(error));
      }, pollMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      ready = false;
    },
    setSource(next) {
      source = next;
      ready = false;
      cursor = undefined;
    },
  };
}

function freezeRow(row: ProjectionRow): ProjectionRow {
  const copy: ProjectionRow = {
    type: row.type,
    id: row.id,
    tenantId: row.tenantId,
    attributes: Object.freeze({ ...row.attributes }),
  };
  if (row.parentType !== undefined) copy.parentType = row.parentType;
  if (row.parentId !== undefined) copy.parentId = row.parentId;
  if (row.ownerId !== undefined) copy.ownerId = row.ownerId;
  if (row.pending) copy.pending = Object.freeze({ ...row.pending });
  return Object.freeze(copy);
}

interface ProjectionDbRow {
  type: string;
  id: string;
  tenant_id: string;
  attributes: unknown;
  parent_type: string | null;
  parent_id: string | null;
  owner_id: string | null;
  pending: unknown;
}

const columnNames = [
  'type',
  'id',
  'tenant_id',
  'attributes',
  'parent_type',
  'parent_id',
  'owner_id',
  'pending',
];
const columns = columnNames.join(', ');
const qualified = columnNames.map((name) => `p.${name}`).join(', ');

function json(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function attributesOf(value: unknown): AuthzAttributes {
  const parsed = json(value);
  const out: AuthzAttributes = {};
  if (parsed && typeof parsed === 'object')
    for (const [name, item] of Object.entries(parsed))
      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')
        out[name] = item;
  return out;
}

function fromDb(row: ProjectionDbRow): ProjectionRow {
  const out: ProjectionRow = {
    type: row.type,
    id: row.id,
    tenantId: row.tenant_id,
    attributes: attributesOf(row.attributes),
  };
  if (row.parent_type !== null) out.parentType = row.parent_type;
  if (row.parent_id !== null) out.parentId = row.parent_id;
  if (row.owner_id !== null) out.ownerId = row.owner_id;
  if (row.pending !== null && row.pending !== undefined) out.pending = attributesOf(row.pending);
  return out;
}

const origin: ChangeCursor = { txid: '0', seq: '0' };

/**
 * Reads `authz_projection` and `authz_changes`. `load()` runs in one repeatable-read snapshot and starts
 * the cursor after the last change of a transaction older than that snapshot's xmin: every such change is
 * already in the loaded rows, and anything newer is tailed (re-reading a row twice is harmless).
 */
export function sqlProjectionSource(sql: SqlExecutor): ProjectionSource {
  return {
    load: () =>
      sql.transaction(
        async (tx) => {
          const { rows } = await tx.query<ProjectionDbRow>(
            `SELECT ${columns} FROM authz_projection`,
          );
          // Output aliases differ from the columns: ORDER BY must sort xid8/bigint, not their text.
          const last = await tx.query<{ txid_text: string; seq_text: string }>(
            `SELECT txid::text AS txid_text, seq::text AS seq_text FROM authz_changes
              WHERE txid < pg_snapshot_xmin(pg_current_snapshot())
              ORDER BY txid DESC, seq DESC LIMIT 1`,
          );
          const tail = last.rows[0];
          return {
            rows: rows.map(fromDb),
            cursor: tail ? { txid: tail.txid_text, seq: tail.seq_text } : origin,
          };
        },
        { isolation: 'repeatable read', readOnly: true },
      ),
    changes: (cursor, limit) =>
      sql.transaction(
        async (tx) => {
          const { rows: changes } = await tx.query<{
            txid_text: string;
            seq_text: string;
            type: string;
            id: string;
            tenant_id: string;
          }>(
            `SELECT txid::text AS txid_text, seq::text AS seq_text, type, id, tenant_id FROM authz_changes
              WHERE (txid, seq) > ($1::xid8, $2::bigint)
                AND txid < pg_snapshot_xmin(pg_current_snapshot())
              ORDER BY txid, seq LIMIT $3`,
            [cursor.txid, cursor.seq, limit],
          );
          const changed = changes.map((change) => ({
            type: change.type,
            id: change.id,
            tenantId: change.tenant_id,
          }));
          let rows: ProjectionRow[] = [];
          if (changed.length) {
            const found = await tx.query<ProjectionDbRow>(
              `SELECT ${qualified} FROM authz_projection p
                 JOIN unnest($1::text[], $2::text[], $3::text[]) AS c(type, id, tenant_id)
                   ON p.type = c.type AND p.id = c.id AND p.tenant_id = c.tenant_id`,
              [
                changed.map((change) => change.type),
                changed.map((change) => change.id),
                changed.map((change) => change.tenantId),
              ],
            );
            rows = found.rows.map(fromDb);
          }
          const tail = changes.at(-1);
          return {
            changed,
            rows,
            cursor: tail ? { txid: tail.txid_text, seq: tail.seq_text } : cursor,
          };
        },
        { isolation: 'repeatable read', readOnly: true },
      ),
    async get(type, id, tenantId) {
      const { rows } = await sql.query<ProjectionDbRow>(
        `SELECT ${columns} FROM authz_projection WHERE type = $1 AND id = $2 AND tenant_id = $3`,
        [type, id, tenantId],
      );
      return rows[0] ? fromDb(rows[0]) : undefined;
    },
  };
}
