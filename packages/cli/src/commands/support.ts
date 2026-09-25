import { writeFile } from 'node:fs/promises';
import type { Finding } from '@better-compute/core';
import { findSecrets, redactSecrets } from '@better-compute/pki';
import type { AnyCompute, AnyComputeOptions } from '../config.js';
import { CliError } from '../errors.js';
import { defineCommand } from '../framework.js';
import { resolveHost } from '../host/config.js';
import { hostFindings } from '../host/findings.js';
import { isUnconfiguredIam } from '../iam.js';
import { defaultPkiPath, pkiFindings, quorumFindings, pkiFlag } from './pki.js';
import { daemonFindings } from './daemon.js';

// `better-compute support bundle` (PLAN.md §6, §14): what an operator attaches to a support request about the
// control plane: versions, the configuration's shape, doctor's findings, applied migrations, gateway and worker
// liveness, and queue backlogs. Never values: environment variables by name only, no URLs with credentials,
// no rows of tenants' data. The text is then scanned with pki's secret patterns (join and IAM tokens, JWTs,
// private keys, URL passwords, the deployment's own secrets) and redacted; a bundle that still matches after
// redaction is refused instead of written (§16 v0.1: "support bundles hold no tokens").

/** Environment variable names whose values are secrets wherever they appear. */
const secretName = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|_KEY$|^KEY$|DATABASE_URL/i;

/** The values a bundle must never contain: the deployment secret and every secret-looking variable. */
export function knownSecrets(options: AnyComputeOptions | undefined, env: NodeJS.ProcessEnv): string[] {
  const values: string[] = [];
  if (options?.secret) values.push(options.secret);
  for (const [name, value] of Object.entries(env))
    if (value && secretName.test(name)) {
      values.push(value);
      // A database URL's password on its own (it may be logged without the rest of the URL).
      try {
        const password = decodeURIComponent(new URL(value).password);
        if (password) values.push(password);
      } catch {
        // Not a URL.
      }
    }
  return values;
}

type Section = Record<string, unknown> | unknown[] | { error: string };

/** Runs one read; a failure (an unmigrated table, a lost connection) becomes that section's error. */
async function section<T>(read: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await read();
  } catch (error) {
    return { error: (error as Error)?.message ?? String(error) };
  }
}

export interface SupportBundleInput {
  compute: AnyCompute;
  options: AnyComputeOptions;
  /** Where the configuration came from (a path or `BETTER_COMPUTE_DATABASE_URL`, never the URL itself). */
  source: string;
  version: string;
  env: NodeJS.ProcessEnv;
  findings: readonly Finding[];
  now?: Date;
}

export interface SupportBundle {
  /** The redacted JSON text. */
  text: string;
  /** How many secrets were replaced. */
  redacted: number;
  sections: string[];
}

/** Builds the bundle's JSON, redacted; throws `SUPPORT_BUNDLE_LEAK` if a secret survives redaction. */
export async function buildSupportBundle(input: SupportBundleInput): Promise<SupportBundle> {
  const { compute, options, env } = input;
  const sql = compute.context.sql;
  const rows = async <T>(text: string) => (await sql.query<T>(text)).rows;
  const modules = (options.modules ?? []).map((module) => module.name);
  const plugins = ((options as { plugins?: readonly { id?: string; name?: string }[] }).plugins ?? []).map(
    (plugin) => plugin.id ?? plugin.name ?? 'plugin',
  );
  const optional = options as { tunnels?: unknown; notifier?: unknown; capacity?: { placer?: unknown } };
  const bundle: Record<string, Section | string | number> = {
    bundle: 'better-compute.support/v1',
    createdAt: (input.now ?? new Date()).toISOString(),
    versions: {
      cli: input.version,
      node: process.versions.node,
      platform: `${process.platform}-${process.arch}`,
    },
    config: {
      source: /:\/\//.test(input.source) ? 'BETTER_COMPUTE_DATABASE_URL' : input.source,
      database: options.database.kind,
      origin: compute.endpoint.origin,
      basePath: compute.endpoint.basePath,
      rootTenantId: options.rootTenantId ?? null,
      iam: isUnconfiguredIam(options.iam) ? 'unconfigured' : 'configured',
      modules,
      plugins,
      pki: { nodeCa: Boolean(options.pki?.nodeCa), join: Boolean(options.pki?.join) },
      tunnels: Boolean(optional.tunnels),
      notifier: Boolean(optional.notifier),
      placer: typeof optional.capacity?.placer === 'string' ? optional.capacity.placer : 'default',
    },
    // Names only: values stay on the machine.
    environment: Object.keys(env)
      .filter((name) => name.startsWith('BETTER_COMPUTE_') || name.startsWith('BCD_'))
      .sort(),
    doctor: [...input.findings],
    migrations: await section(() =>
      rows<{ name: string; applied_at: Date }>(
        'SELECT name, applied_at FROM compute_migrations ORDER BY applied_at, name',
      ),
    ),
    gateways: await section(() =>
      rows(
        `SELECT id, region, software_version, sessions, max_streams, draining,
                extract(epoch FROM compute_now() - heartbeat_at)::int AS heartbeat_age_s
           FROM gateways ORDER BY id`,
      ),
    ),
    workers: await section(() =>
      rows(
        `SELECT id, extract(epoch FROM compute_now() - heartbeat_at)::int AS heartbeat_age_s
           FROM workers ORDER BY id`,
      ),
    ),
    backlog: await section(async () => ({
      workQueue: await rows(
        `SELECT kind, count(*)::int AS due FROM work_queue WHERE not_before <= compute_now()
          GROUP BY kind ORDER BY kind`,
      ),
      commands: await rows(
        'SELECT state, count(*)::int AS count FROM commands GROUP BY state ORDER BY state',
      ),
      iamInbox: (
        await rows<{ pending: number }>(
          'SELECT count(*)::int AS pending FROM iam_inbox WHERE processed_at IS NULL',
        )
      )[0]?.pending,
    })),
    nodes: await section(() =>
      rows(
        `SELECT provision_state, connectivity, count(*)::int AS count FROM nodes
          GROUP BY provision_state, connectivity ORDER BY provision_state, connectivity`,
      ),
    ),
  };
  const known = knownSecrets(options, env);
  const { text, redacted } = redactSecrets(JSON.stringify(bundle, null, 2), { known });
  const left = findSecrets(text, { known });
  if (left.length)
    throw new CliError(
      'SUPPORT_BUNDLE_LEAK',
      `The support bundle still holds ${left.length} secret(s) after redaction (${[...new Set(left.map((finding) => finding.kind))].join(', ')}); it was not written`,
    );
  return { text: `${text}\n`, redacted, sections: Object.keys(bundle) };
}

export const supportCommands = [
  defineCommand({
    name: 'support bundle',
    group: 'Setup',
    summary: 'Write a redacted diagnostics bundle for a support request',
    description:
      "support bundle collects what a support request about the control plane needs: the CLI, Node and platform versions; the configuration's shape (database kind, modules, whether IAM, PKI, tunnels and a notifier are configured; never URLs or values); doctor's findings; applied migrations; gateway and worker heartbeats; work-queue, command and IAM-inbox backlogs; and node counts by state. Environment variables appear by name only. Before anything is written, the bundle is scanned for join tokens (bcjt_), IAM tokens (biam_), JWTs, private keys, URL passwords and the deployment's own secrets, and each is replaced; a bundle in which a secret survives is refused (SUPPORT_BUNDLE_LEAK). The file is written owner-only. It only reads.",
    target: 'config',
    flags: {
      out: {
        type: 'string',
        value: 'PATH',
        description: 'Where to write it (default better-compute-support-<time>.json; - prints it)',
      },
      pki: pkiFlag,
    },
    examples: ['better-compute support bundle', 'better-compute support bundle --out - > bundle.json'],
    async run({ deployment, configModule, flags, program, env, cwd, path, io }) {
      const { compute, options, source } = await deployment();
      const check = await compute.selfCheck();
      const findings: Finding[] = [...check.findings];
      findings.push(...(await pkiFindings(path(flags.pki ?? defaultPkiPath), env, undefined, compute.context.sql)));
      findings.push(...(await quorumFindings(compute.context.sql, options)));
      findings.push(...(await daemonFindings(compute.context.sql)));
      const host = await resolveHost((await configModule()).host, { compute, options, env, cwd });
      findings.push(...hostFindings(compute, options, host));
      const now = new Date();
      const bundle = await buildSupportBundle({
        compute,
        options,
        source,
        version: program.version,
        env,
        findings,
        now,
      });
      if (flags.out === '-') {
        io.out(bundle.text.trimEnd());
        return undefined;
      }
      const target = path(
        flags.out ?? `better-compute-support-${now.toISOString().replace(/[:.]/g, '-')}.json`,
      );
      await writeFile(target, bundle.text, { mode: 0o600 });
      return {
        path: target,
        bytes: Buffer.byteLength(bundle.text),
        redacted: bundle.redacted,
        sections: bundle.sections,
      };
    },
  }),
];
