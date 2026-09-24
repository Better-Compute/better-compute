import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditMigrations } from '@better-compute/audit';
import { createCli, type CliIO } from '@better-compute/cli';
import { pglite } from '@better-compute/postgres/pglite';
import { createPkiBundle, exportPkiBundle, pkiPins } from '@better-compute/pki';

// `better-compute audit checkpoint|verify|prove|check-proof` against a PGlite deployment whose
// database a test opens between commands (PLAN.md §13).

const SECRET = 'better-compute-cli-audit-secret-0123456789';
let dir: string;
let pin: string;

async function withDb<T>(fn: (db: ReturnType<typeof pglite>) => Promise<T>): Promise<T> {
  const db = pglite({ dataDir: join(dir, 'pgdata') });
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

async function run(argv: string[]) {
  const out: string[] = [];
  const io: CliIO = {
    out: (line) => out.push(line),
    env: { BETTER_COMPUTE_SECRET: SECRET },
    cwd: dir,
  };
  try {
    await createCli().run(argv, io);
    return { ok: true as const, stdout: out.join('\n') };
  } catch (error) {
    return { ok: false as const, code: (error as { code?: string }).code, stdout: out.join('\n') };
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bc-cli-audit-'));
  const bundle = createPkiBundle({ trustDomain: 'compute.test' });
  pin = pkiPins(bundle).auditSigningKeyPin!;
  await writeFile(join(dir, 'pki.json'), exportPkiBundle(bundle, { secret: SECRET }));
  await writeFile(
    join(dir, 'better-compute.config.mjs'),
    `import { unconfiguredIam } from 'better-compute/cli';
import { pglite } from 'better-compute/pglite';
import { defineConfig } from 'better-compute/server';
export default defineConfig(({ env, cwd }) => ({
  database: pglite({ dataDir: cwd + '/pgdata' }),
  secret: env.BETTER_COMPUTE_SECRET,
  baseURL: 'http://localhost:3000',
  rootTenantId: 'root',
  iam: unconfiguredIam(),
}));
`,
  );
  await withDb(async (db) => {
    await db.migrate(auditMigrations);
    for (const [index, tenant] of ['org_a', 'org_a', 'org_b', 'org_a'].entries())
      await db.query(
        `INSERT INTO audit_events (id, tenant_id, action, resource_type, resource_id, details)
         VALUES ($1, $2, 'reservation.create', 'reservation', $3, '{"gpus": 4}'::jsonb)`,
        [`aud_${String(index).padStart(26, '0')}`, tenant, `rsv_${index}`],
      );
  });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('audit commands', () => {
  it('seal, verify, prove and check a proof offline; tampering fails verify', async () => {
    const sealed = await run(['audit', 'checkpoint', '--pki', 'pki.json']);
    expect(sealed.ok).toBe(true);
    expect(JSON.parse(sealed.stdout)).toMatchObject({ events: 4 });
    expect(JSON.parse(sealed.stdout).checkpoints).toBeGreaterThanOrEqual(2);

    const verified = await run(['audit', 'verify', '--tenant', 'org_a', '--pki', 'pki.json']);
    expect(verified.ok).toBe(true);
    expect(JSON.parse(verified.stdout)).toMatchObject({ ok: true, events: 3 });

    const eventId = `aud_${'1'.padStart(26, '0')}`;
    expect(
      (await run(['audit', 'prove', eventId, '--tenant', 'org_a', '--out', 'proof.json'])).ok,
    ).toBe(true);
    const checked = await run(['audit', 'check-proof', 'proof.json', '--pin', pin]);
    expect(JSON.parse(checked.stdout)).toMatchObject({ valid: true, eventId, tenantId: 'org_a' });
    const other = pkiPins(createPkiBundle({ trustDomain: 'compute.test' })).auditSigningKeyPin!;
    expect(await run(['audit', 'check-proof', 'proof.json', '--pin', other])).toMatchObject({
      ok: false,
      code: 'INVALID_PROOF',
    });
    const proof = JSON.parse(await readFile(join(dir, 'proof.json'), 'utf8'));
    proof.event.details = { gpus: 400 };
    await writeFile(join(dir, 'forged.json'), JSON.stringify(proof));
    expect(await run(['audit', 'check-proof', 'forged.json', '--pin', pin])).toMatchObject({
      code: 'INVALID_PROOF',
    });

    await withDb((db) =>
      db.query(`UPDATE audit_events SET details = '{"gpus": 400}'::jsonb WHERE id = $1`, [eventId]),
    );
    const tampered = await run(['audit', 'verify', '--tenant', 'org_a', '--pki', 'pki.json']);
    expect(tampered).toMatchObject({ ok: false, code: 'AUDIT_TAMPERED' });
    expect(JSON.parse(tampered.stdout).problems.length).toBeGreaterThan(0);
    // Other tenants are unaffected.
    expect((await run(['audit', 'verify', '--tenant', 'org_b', '--pki', 'pki.json'])).ok).toBe(
      true,
    );
  });

  it('asks for a pin or a bundle with an audit key', async () => {
    expect(
      await run(['audit', 'check-proof', 'proof.json', '--pki', 'missing.json']),
    ).toMatchObject({
      code: 'PKI_NOT_FOUND',
    });
    expect(await run(['audit', 'check-proof', 'proof.json', '--pin', 'nope'])).toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});
