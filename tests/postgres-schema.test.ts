import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@better-compute/core';
import {
  baseMigrations,
  baseSchemaVersion,
  baseTables,
  computeNowMode,
  restoreSystemClock,
  setSimClock,
  useSimClock,
} from '@better-compute/postgres';
import { storeConformanceCases } from '@better-compute/postgres/conformance';
import { pglite } from '@better-compute/postgres/pglite';
import { checkSqlNow, definesComputeNow } from '../scripts/check-sql-now.mjs';

// The base schema on PGlite (PostgreSQL 18 in WebAssembly), which every dev and unit run uses.

const laterTables = [
  'instances',
  'workflows',
  'workflow_steps',
  'images',
  'image_locations',
  'profiles',
  'provider_accounts',
  'sealed_secrets',
  'webhooks',
];

let db: SqlExecutor;

beforeAll(async () => {
  db = pglite();
});
afterAll(async () => {
  await db.close();
});

async function constraints(table: string) {
  const { rows } = await db.query<{ type: string; definition: string }>(
    `SELECT contype::text AS type, pg_get_constraintdef(oid) AS definition FROM pg_constraint
     WHERE conrelid = $1::regclass ORDER BY conname`,
    [table],
  );
  return rows;
}

async function indexDefinition(name: string): Promise<string | undefined> {
  const { rows } = await db.query<{ definition: string }>(
    'SELECT indexdef AS definition FROM pg_indexes WHERE indexname = $1',
    [name],
  );
  return rows[0]?.definition;
}

describe('migrate', () => {
  it('applies the base schema on a fresh database, then skips it', async () => {
    const names = baseMigrations.map((migration) => migration.name);
    expect(names).toEqual([
      'core/0001_clock',
      'core/0002_base',
      'core/0003_v01',
      'core/0004_command_cancel',
      'core/0005_audit_commit_order',
      'core/0006_pool_archive',
      'core/0007_device_health',
      'core/0008_session_versions',
      'core/0009_runtime',
      'core/0010_v02_server',
      'core/0011_v02_security',
      'core/0012_v02_evidence',
      'core/0013_image_cache',
      'core/0014_ssh_certificates',
      'core/0015_inventory_images',
      'core/0016_duplicate_identity',
      'core/0017_allocation_evidence',
      'core/0018_partitioned_history',
      'core/0019_outbox_dead_letters',
      'core/0020_command_created_at',
      'core/0021_signed_specs',
      'core/0022_ssh_certificate_sessions',
      'core/0023_session_trust_version',
      'core/0024_session_capabilities',
      'core/0025_secret_scope',
      'core/0026_session_approver_set',
      'core/0027_join_token_hosted',
      'core/0028_volume_allocations',
      'core/0031_usage_sources',
      'core/0033_usage_window_claims',
    ]);
    expect(await db.migrate()).toEqual({ applied: names, skipped: [] });
    expect(await db.migrate()).toEqual({ applied: [], skipped: names });
    const { rows } = await db.query('SELECT version FROM compute_schema_version');
    expect(rows).toEqual([{ version: baseSchemaVersion }]);
  });

  it('records applied_at on compute_now()', async () => {
    const { rows } = await db.query<{ applied_at: Date }>(
      'SELECT applied_at FROM compute_migrations ORDER BY name',
    );
    expect(rows).toHaveLength(baseMigrations.length);
    for (const row of rows)
      expect(Math.abs(row.applied_at.getTime() - Date.now())).toBeLessThan(600_000);
  });

  it('rejects malformed, out-of-order and core-owned module migrations before running any', async () => {
    await expect(
      db.migrate([{ name: 'bad name' as never, sql: 'SELECT 1' }]),
    ).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
    await expect(
      db.migrate([
        { name: 'mod/0002_b', sql: 'SELECT 1' },
        { name: 'mod/0001_a', sql: 'SELECT 1' },
      ]),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(db.migrate([{ name: 'core/0003_x', sql: 'SELECT 1' }])).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
    const { rows } = await db.query("SELECT name FROM compute_migrations WHERE name LIKE 'mod/%'");
    expect(rows).toEqual([]);
  });

  it('cannot run inside a transaction', async () => {
    await expect(db.transaction(() => db.migrate())).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });
});

describe('base schema', () => {
  it('creates every v0.1 table and none of the later ones', async () => {
    // Partitions of the history tables (core/0018) are not tables of their own.
    const { rows } = await db.query<{ name: string }>(
      `SELECT t.table_name::text AS name FROM information_schema.tables t
         JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = 'public'::regnamespace
       WHERE t.table_schema = 'public' AND NOT c.relispartition ORDER BY t.table_name`,
    );
    const names = rows.map((row) => row.name);
    expect(names.sort()).toEqual(
      [...baseTables, 'compute_migrations', 'compute_schema_version'].sort(),
    );
    for (const table of laterTables) expect(names).not.toContain(table);
  });

  it('installs btree_gist and defines compute_now()', async () => {
    const extension = await db.query("SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'");
    expect(extension.rowCount).toBe(1);
    const fn = await db.query<{ volatility: string; type: string }>(
      `SELECT provolatile::text AS volatility, prorettype::regtype::text AS type FROM pg_proc
       WHERE proname = 'compute_now'`,
    );
    expect(fn.rows).toEqual([{ volatility: 's', type: 'timestamp with time zone' }]);
  });

  it('guards device_bookings with EXCLUDE USING gist and a non-empty range', async () => {
    expect(await constraints('device_bookings')).toEqual(
      expect.arrayContaining([
        { type: 'x', definition: 'EXCLUDE USING gist (device_id WITH =, during WITH &&)' },
        { type: 'c', definition: 'CHECK ((NOT isempty(during)))' },
      ]),
    );
  });

  it('backs the guarded counters with CHECKs', async () => {
    expect(await constraints('node_resources')).toEqual(
      expect.arrayContaining([
        {
          type: 'c',
          definition:
            'CHECK (((allocated >= 0) AND ((allocated)::numeric <= floor(((allocatable)::numeric * ratio)))))',
        },
      ]),
    );
    expect(await constraints('quota_usage')).toEqual(
      expect.arrayContaining([
        { type: 'c', definition: 'CHECK (((used >= 0) AND (used <= max)))' },
      ]),
    );
  });

  it('scopes reservation idempotency keys to (tenant, owner identity)', async () => {
    expect(await constraints('reservations')).toEqual(
      expect.arrayContaining([
        { type: 'u', definition: 'UNIQUE (tenant_id, owner_identity_id, idempotency_key)' },
      ]),
    );
  });

  it('keeps per-node command sequences and keys unique', async () => {
    expect(await constraints('commands')).toEqual(
      expect.arrayContaining([
        { type: 'u', definition: 'UNIQUE (node_id, seq)' },
        { type: 'u', definition: 'UNIQUE (node_id, idempotency_key)' },
      ]),
    );
  });

  it('creates the partial indexes of §8.3', async () => {
    expect(await indexDefinition('iam_inbox_pending')).toBe(
      'CREATE INDEX iam_inbox_pending ON public.iam_inbox USING btree (tenant_id, sequence) WHERE (processed_at IS NULL)',
    );
    expect(await indexDefinition('nodes_hardware_key')).toBe(
      'CREATE UNIQUE INDEX nodes_hardware_key ON public.nodes USING btree (hardware_key) WHERE hardware_key_trusted',
    );
  });

  it('stamps outbox rows with the writing transaction id', async () => {
    const { rows } = await db.query<{ type: string; default: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS type, pg_get_expr(d.adbin, d.adrelid) AS default
       FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = 'outbox'::regclass AND a.attname = 'txid'`,
    );
    expect(rows).toEqual([{ type: 'xid8', default: 'pg_current_xact_id()' }]);
  });

  it('defaults timestamps to compute_now(), never the bare server clock', async () => {
    const { rows } = await db.query<{ definition: string }>(
      `SELECT pg_get_expr(d.adbin, d.adrelid) AS definition FROM pg_attrdef d
       JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
       JOIN pg_class c ON c.oid = d.adrelid
       WHERE c.relnamespace = 'public'::regnamespace
         AND format_type(a.atttypid, a.atttypmod) = 'timestamp with time zone'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.definition).toBe('compute_now()');
  });
});

describe('compute_now()', () => {
  it('reads the server clock until the sim clock is used', async () => {
    expect(await computeNowMode(db)).toBe('system');
    const { rows } = await db.query<{ now: Date }>('SELECT compute_now() AS now');
    expect(Math.abs(rows[0]!.now.getTime() - Date.now())).toBeLessThan(600_000);
  });

  it('follows the sim clock and returns to the system clock', async () => {
    const start = Date.UTC(2010, 5, 1, 12);
    await useSimClock(db, start);
    try {
      expect(await computeNowMode(db)).toBe('sim');
      const read = async () =>
        (await db.query<{ now: Date }>('SELECT compute_now() AS now')).rows[0]!.now.getTime();
      expect(await read()).toBe(start);
      await setSimClock(db, start + 1_500);
      expect(await read()).toBe(start + 1_500);
      await setSimClock(db, start + 1_500);
      await expect(setSimClock(db, start)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(setSimClock(db, -1)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      // Inside one transaction the clock moves with each statement.
      await db.transaction(async (tx) => {
        await setSimClock(tx, start + 60_000);
        expect(await read()).toBe(start + 60_000);
      });
    } finally {
      await restoreSystemClock(db);
    }
    expect(await computeNowMode(db)).toBe('system');
  });

  it('refuses setSimClock before useSimClock', async () => {
    const fresh = pglite();
    try {
      await fresh.migrate();
      await expect(setSimClock(fresh, 1_000)).rejects.toMatchObject({ code: 'INVALID_STATE' });
      expect(await computeNowMode(fresh)).toBe('system');
    } finally {
      await fresh.close();
    }
  });

  it('reports a missing compute_now() before migration', async () => {
    const fresh = pglite();
    try {
      expect(await computeNowMode(fresh)).toBe('missing');
    } finally {
      await fresh.close();
    }
  });
});

describe('check-sql-now', () => {
  it('exempts only the migration that defines compute_now(), and the package passes it', async () => {
    const root = fileURLToPath(new URL('../packages/postgres/src/', import.meta.url));
    const files = [];
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const file = join(entry.parentPath, entry.name);
      files.push({
        path: `packages/postgres/src/${relative(root, file).replaceAll('\\', '/')}`,
        source: await readFile(file, 'utf8'),
      });
    }
    const definers = files.filter((file) => definesComputeNow(file.path, file.source));
    expect(definers.map((file) => file.path)).toEqual([
      'packages/postgres/src/migrations/0001_clock.ts',
    ]);
    expect(checkSqlNow(files)).toEqual([]);
  });
});

describe('store conformance on PGlite (one shared database)', () => {
  const cases = storeConformanceCases();
  it('marks the concurrency cases postgresOnly', () => {
    const concurrent = cases.filter((test) => test.postgresOnly);
    expect(concurrent.length).toBeGreaterThanOrEqual(6);
    expect(concurrent.every((test) => test.name.startsWith('concurrency:'))).toBe(true);
  });
  for (const test of cases.filter((entry) => !entry.postgresOnly))
    it(test.name, async () => {
      await test.run(db);
    });
});

describe('audit commit order (core/0005)', () => {
  it('stamps audit rows with their transaction id and a sequence, like the outbox', async () => {
    const fresh = pglite();
    try {
      await fresh.migrate();
      await fresh.transaction(async (tx) => {
        await tx.query(`INSERT INTO audit_events (id, tenant_id, action, resource_type, resource_id) VALUES ('aud_1', 't', 'a', 'node', 'n')`);
        await tx.query(`INSERT INTO audit_events (id, tenant_id, action, resource_type, resource_id) VALUES ('aud_2', 't', 'a', 'node', 'n')`);
      });
      await fresh.query(`INSERT INTO audit_events (id, tenant_id, action, resource_type, resource_id) VALUES ('aud_3', 't', 'a', 'node', 'n')`);
      const { rows } = await fresh.query<{ id: string; txid_text: string; seq: number }>(
        `SELECT id, txid::text AS txid_text, seq FROM audit_events ORDER BY audit_events.txid, audit_events.seq`,
      );
      expect(rows.map((row) => row.id)).toEqual(['aud_1', 'aud_2', 'aud_3']);
      expect(rows[0]!.txid_text).toBe(rows[1]!.txid_text);
      expect(BigInt(rows[2]!.txid_text)).toBeGreaterThan(BigInt(rows[1]!.txid_text));
      expect(await indexDefinition('audit_events_tenant_commit')).toMatch(/\(tenant_id, txid, seq\)/);
    } finally {
      await fresh.close();
    }
  });
});

describe('duplicate-identity counters (core/0016)', () => {
  it('adds the Hello alternation window to node_sessions', async () => {
    const { rows } = await db.query<{ column_name: string; column_default: string | null }>(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_name = 'node_sessions' AND column_name IN ('duplicate_hellos', 'duplicate_since') ORDER BY 1`,
    );
    expect(rows).toEqual([
      { column_name: 'duplicate_hellos', column_default: '0' },
      { column_name: 'duplicate_since', column_default: null },
    ]);
  });
});

describe('allocation evidence (core/0017)', () => {
  it('stores the attested AllocationBound report next to the allocation', async () => {
    const { rows } = await db.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'allocations' AND column_name LIKE 'bound\\_%' ORDER BY 1`,
    );
    expect(rows).toEqual([
      { column_name: 'bound_at', data_type: 'timestamp with time zone' },
      { column_name: 'bound_report', data_type: 'bytea' },
      { column_name: 'bound_sig', data_type: 'bytea' },
      { column_name: 'bound_sig_kid', data_type: 'text' },
    ]);
  });
});

describe('outbox dead letters and command latency (core/0019, core/0020)', () => {
  it('keys dead events by sink and commit position', async () => {
    expect(await constraints('outbox_dead_letters')).toEqual(
      expect.arrayContaining([{ type: 'p', definition: 'PRIMARY KEY (sink, txid, seq)' }]),
    );
  });

  it('stamps commands with their enqueue time and indexes settled ones by update time', async () => {
    const { rows } = await db.query<{ is_nullable: string; column_default: string }>(
      `SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = 'commands' AND column_name = 'created_at'`,
    );
    expect(rows).toEqual([{ is_nullable: 'NO', column_default: 'compute_now()' }]);
    expect(await indexDefinition('commands_settled')).toMatch(/\(updated_at\) WHERE \(state = ANY/);
  });

  it('scopes stored secrets to a tenant or the fleet, tenant by default (core/0025)', async () => {
    const { rows } = await db.query<{ column_default: string; is_nullable: string }>(
      `SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = 'secret_refs' AND column_name = 'scope'`,
    );
    expect(rows).toEqual([{ column_default: "'tenant'::text", is_nullable: 'NO' }]);
    const { rows: checks } = await db.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
        WHERE c.conrelid = 'secret_refs'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%scope%'`,
    );
    expect(checks[0]?.definition).toMatch(/tenant.*fleet/);
  });

  it("keeps the current session's daemon capabilities (core/0024)", async () => {
    const { rows } = await db.query<{ data_type: string; column_default: string; is_nullable: string }>(
      `SELECT data_type, column_default, is_nullable FROM information_schema.columns WHERE table_name = 'node_sessions' AND column_name = 'capabilities'`,
    );
    expect(rows).toEqual([{ data_type: 'ARRAY', column_default: "'{}'::text[]", is_nullable: 'NO' }]);
  });

  it('keeps the trust bundle version each session applied (core/0023)', async () => {
    const { rows } = await db.query<{ column_default: string; is_nullable: string }>(
      `SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = 'node_sessions' AND column_name = 'trust_version'`,
    );
    expect(rows).toEqual([{ column_default: '0', is_nullable: 'NO' }]);
  });

  it('records the issuing session of SSH certificates and indexes the outstanding ones (core/0022)', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'ssh_certificates' AND column_name IN ('session_id', 'reauthorized_at') ORDER BY 1`,
    );
    expect(rows.map((row) => row.column_name)).toEqual(['reauthorized_at', 'session_id']);
    expect(await indexDefinition('ssh_certificates_outstanding')).toMatch(/\(expires_at\) WHERE \(revoked_at IS NULL\)/);
  });

  it('keeps a node spec signed bytes next to it (core/0021)', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'nodes' AND column_name IN ('spec_body', 'spec_signature') AND data_type = 'bytea' ORDER BY 1`,
    );
    expect(rows.map((row) => row.column_name)).toEqual(['spec_body', 'spec_signature']);
  });
});

describe('store conformance on PGlite (a fresh database per case)', () => {
  for (const test of storeConformanceCases().filter((entry) => !entry.postgresOnly))
    it(test.name, async () => {
      const fresh = pglite();
      try {
        await test.run(fresh);
      } finally {
        await fresh.close();
      }
    });
});
