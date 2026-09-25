// The deployment every example runs: the whole of better-compute in one configuration. Each example's
// better-compute.config.ts calls `exampleOptions()` and `exampleHost()` with its own environment.
//
// What comes from where (all optional unless said):
// - BETTER_COMPUTE_DATABASE_URL: postgres://… (PgBouncer in transaction mode is fine), pglite:DIR or
//   pglite:memory. Default: PGlite in `<cwd>/.better-compute/example-db`.
// - BETTER_COMPUTE_SECRET: ≥ 32 characters, the same for every process. Required with Postgres; PGlite
//   examples fall back to a fixed development secret.
// - BETTER_COMPUTE_PKI: the bundle `better-compute pki init` wrote (default `.better-compute/pki.json`).
//   With it: JoinService (machines can join), the audit module (its checkpoint key), the gateway role.
// - BETTER_COMPUTE_RELEASE_PINS: `sha256/…` pins of the bcd release keys (comma-separated). With them: the
//   rollout module. BETTER_COMPUTE_DOWNLOADS_URL: where bcd binaries are served.
// - BETTER_COMPUTE_BCD_URL / _SHA256: the bcd binary provisioned machines install (with the bundle's pins).
// - BETTER_COMPUTE_GATEWAY_CERT / _KEY: `better-compute pki issue-gateway` output. With them (and the
//   bundle): `host.gateway` over mTLS on BETTER_COMPUTE_GATEWAY_PORT (default 8443) in BETTER_COMPUTE_REGION.
// - BETTER_COMPUTE_GATEWAY_URL (https://gw.example.com:8443) and optionally _SERVER_NAME: published in
//   /.well-known/better-compute with the serving CA's pin, for `bcd join --server <control plane>`.
// - BETTER_COMPUTE_METRICS_TOKEN: ≥ 16 characters; mounts GET /metrics for Prometheus.
// - BETTER_COMPUTE_APPROVER_KEYS: approver public keys (`better-compute batch keygen` .pub files, comma-separated)
//   with BETTER_COMPUTE_APPROVER_THRESHOLD (k of them): the v1.0 destructive-batch quorum, in every daemon's trust
//   bundle. BETTER_COMPUTE_UNBATCHED_PER_HOUR (default 0): destructive commands a node runs per hour outside a batch.
//
// IAM: until you wire better-iam (see the README of examples/postgres), no credential authenticates.
// `better-compute dev --sim N` replaces that with an embedded, in-memory better-iam and prints a root token.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { auditModule } from '@better-compute/audit';
import {
  defineHost,
  loadPkiBundle,
  unconfiguredIam,
  watchAuthorizer,
  type HostConfig,
} from '@better-compute/cli';
import type { ComputeModule, IamPort, SqlExecutor } from '@better-compute/core';
import { createWatchRegistry, eventsModule, handleWatch } from '@better-compute/events';
import { fleetModule } from '@better-compute/fleet';
import { metal } from '@better-compute/metal';
import {
  createMetrics,
  eventCounter,
  placementObserver,
  runtimeObserver,
  standardMetrics,
} from '@better-compute/observability';
import { approverKeyOf, bootstrapPins, commandSigningOptions, type PkiBundle } from '@better-compute/pki';
import { postgres, retentionModule } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { provisionModule } from '@better-compute/provision';
import { rolloutModule } from '@better-compute/rollout';
import { pkiJoinCrypto, type BetterCompute, type ComputeOptions } from '@better-compute/server';
import { instanceStatusHandler, sandboxIamReactions, vps } from '@better-compute/vps';

/**
 * The process's Prometheus registry (bounded labels, nothing identifies a tenant). With real IAM, wrap
 * the port too: `iam: meteredIamPort(bridge.embedded(iam, …), standardMetrics(metrics))`.
 */
export const metrics = createMetrics();
const standard = standardMetrics(metrics);

/** Only for PGlite examples on a laptop; Postgres deployments must set BETTER_COMPUTE_SECRET. */
const DEVELOPMENT_SECRET = 'better-compute-examples-development-secret-not-for-production';

export interface ExampleContext {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Extra modules (after the standard ones), e.g. a metal hardware profile set. */
  modules?: readonly ComputeModule[];
  /** Options for `metal()` (hardware profiles, attestation). */
  metal?: Parameters<typeof metal>[0];
  /** Refuse to start without Postgres (the production-shaped examples). */
  requirePostgres?: boolean;
  /**
   * The capacity placer: `inline` (default; placed in the request) or `pool-lease` (v0.4: queued, then
   * placed in batches of up to 64 per pool by the `capacity.placer` reconciler).
   */
  placer?: 'inline' | 'pool-lease';
}

/** The PKI bundle, when `pki init` wrote one. */
async function bundleOf(env: NodeJS.ProcessEnv, cwd: string): Promise<PkiBundle | undefined> {
  const path = resolve(cwd, env.BETTER_COMPUTE_PKI ?? '.better-compute/pki.json');
  return existsSync(path) ? loadPkiBundle(path, env) : undefined;
}

/** `pki.approvers` from BETTER_COMPUTE_APPROVER_KEYS / _THRESHOLD / BETTER_COMPUTE_UNBATCHED_PER_HOUR, if set. */
async function approversOf(env: NodeJS.ProcessEnv, cwd: string) {
  const paths = (env.BETTER_COMPUTE_APPROVER_KEYS ?? '')
    .split(',')
    .map((path) => path.trim())
    .filter(Boolean);
  if (paths.length === 0) return undefined;
  const threshold = Number(env.BETTER_COMPUTE_APPROVER_THRESHOLD);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > paths.length)
    throw new Error(`Set BETTER_COMPUTE_APPROVER_THRESHOLD to how many of the ${paths.length} approver keys a batch needs`);
  const keys = await Promise.all(
    paths.map(async (path) => approverKeyOf(await readFile(resolve(cwd, path), 'utf8')).spkiDer),
  );
  const perHour = Number(env.BETTER_COMPUTE_UNBATCHED_PER_HOUR ?? 0);
  if (!Number.isInteger(perHour) || perHour < 0)
    throw new Error('BETTER_COMPUTE_UNBATCHED_PER_HOUR must be a whole number ≥ 0');
  return { keys, threshold, unbatchedDestructivePerHour: perHour };
}

function database(env: NodeJS.ProcessEnv, cwd: string, requirePostgres: boolean): SqlExecutor {
  const url = env.BETTER_COMPUTE_DATABASE_URL;
  if (url && /^postgres(ql)?:\/\//i.test(url)) return postgres({ url });
  if (requirePostgres)
    throw new Error(
      'This example runs on PostgreSQL: set BETTER_COMPUTE_DATABASE_URL=postgres://…',
    );
  const location = url?.replace(/^pglite:(\/\/)?/i, '') ?? '.better-compute/example-db';
  if (location === 'memory') return pglite();
  return pglite({ dataDir: isAbsolute(location) ? location : join(cwd, location) });
}

/** Every module, as a production deployment registers them (PLAN.md §5, §8.2). */
export function everyModule(
  secret: string,
  bundle: PkiBundle | undefined,
  env: NodeJS.ProcessEnv,
  metalOptions?: Parameters<typeof metal>[0],
): ComputeModule[] {
  const metalModule = metal(metalOptions);
  const pins = (env.BETTER_COMPUTE_RELEASE_PINS ?? '')
    .split(',')
    .map((pin) => pin.trim())
    .filter(Boolean);
  return [
    // provision runs metal's workflows; metal contributes the verbs, steps and profiles. Machines it installs join
    // with the pins from the sealed bundle (`bcd join --serving-ca-pin … --join-signing-pin … --join-encryption-pin …`),
    // never with pins read from the unsigned /.well-known document.
    provisionModule({
      modules: [metalModule],
      userData: {
        controlPlaneUrl: env.BETTER_COMPUTE_BASE_URL ?? 'http://localhost:3000',
        ...(env.BETTER_COMPUTE_BCD_URL ? { bcdUrl: env.BETTER_COMPUTE_BCD_URL } : {}),
        ...(env.BETTER_COMPUTE_BCD_SHA256 ? { bcdSha256: env.BETTER_COMPUTE_BCD_SHA256 } : {}),
        ...(bundle ? { pins: bootstrapPins(bundle) } : {}),
      },
    }),
    metalModule,
    vps(),
    // The store's housekeeping: prunes the outbox and authz changes behind their cursors (every 5 min).
    retentionModule(),
    // events_total{family,module} and security_events_total{type}.
    eventsModule({ secret, countEvent: eventCounter(metrics, standard) }),
    fleetModule(),
    // bcd self-update needs the offline release keys' pins.
    ...(pins.length
      ? [
          rolloutModule({
            release: { pins },
            downloadsUrl: env.BETTER_COMPUTE_DOWNLOADS_URL ?? 'https://downloads.example.com',
          }),
        ]
      : []),
    // Signed hourly audit checkpoints need the bundle's audit key.
    ...(bundle?.auditSigning ? [auditModule({ signer: bundle.auditSigning })] : []),
  ] as ComputeModule[];
}

/** The `betterCompute()` options of the examples (the default export of their configuration). */
export async function exampleOptions(
  context: ExampleContext = {},
): Promise<ComputeOptions<readonly ComputeModule[], []>> {
  const env = context.env ?? process.env;
  const cwd = context.cwd ?? process.cwd();
  const store = database(env, cwd, context.requirePostgres === true);
  const postgresStore = store.kind !== 'pglite';
  const secret = env.BETTER_COMPUTE_SECRET ?? (postgresStore ? undefined : DEVELOPMENT_SECRET);
  if (!secret) throw new Error('Set BETTER_COMPUTE_SECRET (at least 32 characters)');
  const bundle = await bundleOf(env, cwd);
  const approvers = await approversOf(env, cwd);
  if (approvers && !bundle?.commandSigning)
    throw new Error('BETTER_COMPUTE_APPROVER_KEYS needs a PKI bundle with a command-signing root (pki init)');
  const iam: IamPort = unconfiguredIam();
  return {
    database: store,
    secret,
    baseURL: env.BETTER_COMPUTE_BASE_URL ?? 'http://localhost:3000',
    rootTenantId: env.BETTER_COMPUTE_ROOT_TENANT ?? 'root',
    iam,
    modules: [...everyModule(secret, bundle, env, context.metal), ...(context.modules ?? [])],
    // reconcile_duration_seconds and commands_swept_total from the runtime's workers.
    worker: { observe: runtimeObserver(standard) },
    capacity: {
      ...(context.placer ? { placer: context.placer } : {}),
      // §14 placements_total{outcome}, booking_conflicts_total and placement_seconds{placer}, from every placement.
      onPlacement: placementObserver(standard, metrics),
    },
    // Where daemons dial, published in /.well-known/better-compute (with the serving CA's pin), so
    // `bcd join --server <this control plane>` configures itself.
    ...(env.BETTER_COMPUTE_GATEWAY_URL
      ? {
          gateway: {
            url: env.BETTER_COMPUTE_GATEWAY_URL,
            ...(env.BETTER_COMPUTE_GATEWAY_SERVER_NAME ? { serverName: env.BETTER_COMPUTE_GATEWAY_SERVER_NAME } : {}),
          },
        }
      : {}),
    ...(bundle
      ? {
          pki: {
            nodeCa: bundle.nodeCa,
            servingCa: bundle.servingCa,
            join: pkiJoinCrypto({
              trustDomain: bundle.trustDomain,
              nodeCa: bundle.nodeCa,
              signingKey: bundle.joinSigning,
              encryptionKey: bundle.joinEncryption.privateKey,
            }),
            // Signed intent (v0.2): commands and specs signed under the bundle's command-signing root, with the
            // roots and trust version of a rotation in progress (pki rotate-command-root).
            ...commandSigningOptions(bundle),
            // The destructive-batch quorum (v1.0): k-of-n approver keys, checked by every daemon.
            ...(approvers ? { approvers } : {}),
          },
        }
      : {}),
  };
}

/** The `host` export: SSE events, Prometheus metrics, and the gateway role when its certificate exists. */
export const exampleHost = defineHost(async ({ compute, env, cwd }) => {
  const watch = watchAuthorizer(compute);
  // The process's open /watch streams: a revoked session, identity or delegation closes them at once (with the
  // IAM bridge of host.iam, or the embedded IAM of `dev --sim`), not only at the next re-check.
  const watches = createWatchRegistry();
  const host: HostConfig = {
    streams: [watches],
    // vps's reactions to IAM (§12.8): a revoked agent's sandboxes are withdrawn, a departed owner's go to the successor.
    iamReactions: [sandboxIamReactions],
    http: {
      routes: [
        {
          // Server-sent events of the caller's tenant: GET /watch?types=node.*,reservation.*
          path: '/watch',
          method: 'GET',
          handler: (request: Request) =>
            handleWatch(request, {
              sql: (compute as BetterCompute<any, any>).context.sql,
              // Decided like events.list: compute:events:read on the tenant, not just "signed in".
              authorize: watch,
              registry: watches,
            }),
        },
      ],
    },
  };
  // One registry for the process: the events module counts into it, serve adds the gateway role's series
  // and, with a token, serves GET /metrics.
  const metricsToken = env.BETTER_COMPUTE_METRICS_TOKEN;
  host.metrics = { registry: metrics, ...(metricsToken ? { bearerToken: metricsToken } : {}) };
  const certPath = env.BETTER_COMPUTE_GATEWAY_CERT;
  const keyPath = env.BETTER_COMPUTE_GATEWAY_KEY;
  const bundle = await bundleOf(env, cwd);
  if (certPath && keyPath && bundle)
    host.gateway = {
      region: env.BETTER_COMPUTE_REGION ?? 'dev-1',
      listen: { port: Number(env.BETTER_COMPUTE_GATEWAY_PORT ?? 8443) },
      tls: {
        key: await readFile(resolve(cwd, keyPath), 'utf8'),
        cert: await readFile(resolve(cwd, certPath), 'utf8'),
        ca: bundle.nodeCa.export().certificatesPem,
      },
      // vps's orphan detection beside the default XID health handler.
      options: { reports: { status: instanceStatusHandler({ events: compute.context.events }) } },
    };
  return host;
});
