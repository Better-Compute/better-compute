import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSupportBundle,
  createCli,
  createDeployment,
  knownSecrets,
  unconfiguredIam,
  type CliIO,
  type Deployment,
} from '@better-compute/cli';
import { findSecrets } from '@better-compute/pki';
import { pglite } from '@better-compute/postgres/pglite';

// `better-compute support bundle` (PLAN.md §16 v0.1 security negative: "support bundles hold no tokens"): the
// control plane's diagnostics, with every secret the deployment knows or the patterns recognize redacted.

const SECRET = 'support-bundle-test-secret-0123456789abcdef';
const IAM_TOKEN = 'biam_ses_01j8supportbundletest.s3cr3t-value';
const JOIN_TOKEN = 'bcjt_jt_01j8supportbundle.QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo';

let deployment: Deployment | undefined;
afterEach(async () => {
  await deployment?.close();
  deployment = undefined;
});

describe('support bundle', () => {
  it('holds diagnostics and no secrets, even when they leak into findings and rows', async () => {
    const env = {
      BETTER_COMPUTE_TOKEN: IAM_TOKEN,
      BCD_JOIN_TOKEN: JOIN_TOKEN,
      BETTER_COMPUTE_DATABASE_URL: 'postgres://compute:db-password-123@db.internal/compute',
      BETTER_COMPUTE_REGION: 'eu-1',
    };
    deployment = createDeployment(
      {
        database: pglite(),
        iam: unconfiguredIam(),
        secret: SECRET,
        baseURL: 'http://127.0.0.1:3000',
        rootTenantId: 'root',
      },
      'postgres://compute:db-password-123@db.internal/compute',
    );
    const { compute, options } = deployment;
    await compute.initialize();
    // A gateway that put a token in its version string, and a finding that quotes a credential.
    await compute.context.sql.query(
      `INSERT INTO gateways (id, region, internal_url, software_version, max_streams)
       VALUES ('gw-1', 'eu-1', 'https://gw-1.internal:9443', $1, 100)`,
      [`0.1.0 (${JOIN_TOKEN})`],
    );
    const bundle = await buildSupportBundle({
      compute,
      options,
      source: 'postgres://compute:db-password-123@db.internal/compute',
      version: '0.0.0-test',
      env,
      findings: [
        {
          check: 'example',
          severity: 'warning',
          message: `dialing postgres://compute:db-password-123@db.internal with ${IAM_TOKEN} and ${SECRET}`,
        },
      ],
    });
    for (const leaked of [SECRET, IAM_TOKEN, JOIN_TOKEN, 'db-password-123', 's3cr3t', 'QUJDREVG'])
      expect(bundle.text).not.toContain(leaked);
    expect(findSecrets(bundle.text, { known: knownSecrets(options, env) })).toEqual([]);
    expect(bundle.redacted).toBeGreaterThanOrEqual(4);
    const parsed = JSON.parse(bundle.text);
    expect(parsed).toMatchObject({
      bundle: 'better-compute.support/v1',
      config: { source: 'BETTER_COMPUTE_DATABASE_URL', database: 'pglite', iam: 'unconfigured' },
      gateways: [{ id: 'gw-1', region: 'eu-1', software_version: '0.1.0 (bcjt_[redacted])' }],
      backlog: { iamInbox: 0 },
    });
    // Variables by name only.
    expect(parsed.environment).toEqual([
      'BCD_JOIN_TOKEN',
      'BETTER_COMPUTE_DATABASE_URL',
      'BETTER_COMPUTE_REGION',
      'BETTER_COMPUTE_TOKEN',
    ]);
    expect(parsed.migrations.length).toBeGreaterThan(5);
    expect(bundle.sections).toEqual(
      expect.arrayContaining(['doctor', 'migrations', 'gateways', 'workers', 'backlog', 'nodes']),
    );
  });

  it('runs as a command: writes an owner-only file, or prints with --out -', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bc-support-'));
    const out: string[] = [];
    const io: CliIO = {
      out: (line) => out.push(line),
      err() {},
      cwd,
      env: {
        BETTER_COMPUTE_DATABASE_URL: 'pglite:memory',
        BETTER_COMPUTE_SECRET: SECRET,
        BETTER_COMPUTE_TOKEN: IAM_TOKEN,
      },
    };
    await createCli().run(['support', 'bundle', '--out', 'bundle.json'], io);
    const summary = JSON.parse(out.join('\n'));
    expect(summary).toMatchObject({ path: join(cwd, 'bundle.json'), redacted: expect.any(Number) });
    const text = await readFile(join(cwd, 'bundle.json'), 'utf8');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(IAM_TOKEN);
    expect(JSON.parse(text).config.source).toBe('BETTER_COMPUTE_DATABASE_URL');
    if (process.platform !== 'win32') expect((await stat(join(cwd, 'bundle.json'))).mode & 0o077).toBe(0);

    out.length = 0;
    await createCli().run(['support', 'bundle', '--out', '-'], io);
    const printed = JSON.parse(out.join('\n'));
    expect(printed.bundle).toBe('better-compute.support/v1');
    expect(out.join('\n')).not.toContain(SECRET);
  });
});
