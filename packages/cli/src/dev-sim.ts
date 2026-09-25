import type {
  ComputeModule,
  Credential,
  IamPort,
  Notifier,
  SqlExecutor,
} from '@better-compute/core';
import { iamTenantReader, type TenantReaderHost } from '@better-compute/iam';
import {
  createExecTicketIssuer,
  createSshCertificateAuthority,
  type ExecTicketIssuer,
  type SshCertificateAuthority,
} from '@better-compute/pki';
import type { AnyCompute, AnyComputeOptions } from './config.js';
import type { HostIamConfig } from './host/iam.js';
import type { HostTunnelsConfig } from './host/tunnels.js';
import { importOptional } from './config.js';
import { CliError } from './errors.js';
import { isUnconfiguredIam } from './iam.js';

// `better-compute dev --sim N` (PLAN.md §14 "Dev"): simulated machines join the dev server's own control
// plane the way `bcd join` does, through a gateway on cleartext HTTP/2 bound to loopback. The pieces come
// from the optional peer @better-compute/testing (`createDevJoinKeys`, `devFleetNotifier`, `attachDevFleet`),
// typed structurally here. Without configured IAM, an embedded in-memory better-iam
// (@better-compute/iam/testing) authenticates a root administrator whose token dev prints.

export const simVariants = ['hgx-h100', 'hgx-h100-gpu-missing', 'l40s', 'cpu'] as const;
export type SimVariant = (typeof simVariants)[number];

interface DevJoinKeys {
  pki: { nodeCa: unknown; join: unknown };
}
interface DevFleetNotifier extends Notifier {
  attach(gateway: unknown): void;
}
interface DevFleet {
  gatewayUrl: string;
  createPool(options?: {
    gpuModel?: string | null;
    key?: string;
    expectGpuCount?: number;
  }): Promise<{ poolId: string }>;
  join(options: {
    poolId: string;
    count?: number;
    variant?: SimVariant;
    seed?: string;
  }): Promise<string[]>;
  waitFor(nodeIds: readonly string[], options?: { timeoutMs?: number }): Promise<void>;
  close(): Promise<void>;
}
interface TestingDev {
  createDevJoinKeys(options?: { trustDomain?: string }): DevJoinKeys;
  devFleetNotifier(): DevFleetNotifier;
  attachDevFleet(options: {
    compute: AnyCompute;
    database: SqlExecutor;
    keys: DevJoinKeys;
    notifier?: DevFleetNotifier;
    root: Credential;
    rootTenantId: string;
    insecureHeaderAuth: true;
    gateway?: { host?: string; port?: number };
    tunnels?: { issuer: ExecTicketIssuer; issuerName?: string };
  }): Promise<DevFleet>;
}
interface EmbeddedTestIam {
  port: IamPort & { rootTenantId?: string };
  /** The better-iam instance (reads tenants for the tenancy reaction). */
  iam: TenantReaderHost;
  bridge: { modules: readonly ComputeModule[] } & HostIamConfig['bridge'];
  root: { tenantId: string; credential: Credential };
  bind(sql: SqlExecutor): Promise<void>;
  close(): Promise<void>;
}
interface IamTesting {
  createEmbeddedTestIam(options?: {
    now?: () => number;
    runIamJobs?: boolean;
  }): Promise<EmbeddedTestIam>;
}

export interface DevSim {
  /** The deployment options with the dev join keys, the poke notifier and (if needed) embedded IAM. */
  options: AnyComputeOptions;
  /** How the dev server mounts tunnels to the simulated machines (`host.tunnels`). */
  hostTunnels: HostTunnelsConfig;
  /** The embedded IAM's bridge (`host.iam`), when dev started one: its events reach compute. */
  hostIam?: HostIamConfig;
  /** After migrations: binds the embedded IAM's projection to the store. */
  afterMigrate(): Promise<void>;
  /** Once the server runs: attaches the gateway, creates the pool, joins the machines. */
  started(compute: AnyCompute): Promise<void>;
  /** Stops the machines and the gateway. */
  stopping(): Promise<void>;
  /** After the control plane stopped: closes the embedded IAM. */
  close(): Promise<void>;
}

/**
 * Prepares `dev --sim N` around deployment `options`. The root credential is the embedded IAM's when the
 * deployment has no IAM, else `BETTER_COMPUTE_TOKEN` (a root administrator of the configured IAM).
 */
export async function prepareDevSim(
  options: AnyComputeOptions,
  sim: { count: number; variant: SimVariant; env: NodeJS.ProcessEnv; note(message: string): void },
): Promise<DevSim> {
  const testing = await importOptional<TestingDev>(
    '@better-compute/testing',
    'better-compute dev --sim',
  );
  const keys = testing.createDevJoinKeys();
  const notifier = testing.devFleetNotifier();
  let embedded: EmbeddedTestIam | undefined;
  let root: Credential;
  let rootTenantId: string;
  let iam = options.iam;
  let modules: readonly ComputeModule[] = options.modules ?? [];
  if (isUnconfiguredIam(options.iam)) {
    const iamTesting = await importOptional<IamTesting>(
      '@better-compute/iam/testing',
      'better-compute dev --sim without configured IAM',
    );
    // With IAM's jobs on the iam worker role, its audit events reach compute's inbox (as in embedded mode).
    embedded = await iamTesting.createEmbeddedTestIam({ now: () => Date.now(), runIamJobs: true });
    iam = embedded.port;
    root = embedded.root.credential;
    rootTenantId = embedded.root.tenantId;
    modules = [...embedded.bridge.modules, ...modules];
  } else {
    const token = sim.env.BETTER_COMPUTE_TOKEN;
    if (!token)
      throw new CliError(
        'MISSING_ENV',
        'dev --sim with a configured IAM needs BETTER_COMPUTE_TOKEN',
        "Set it to a root administrator's token: it creates the site, the pool and the join token.",
      );
    root = { token };
    rootTenantId = options.rootTenantId ?? (options.iam as { rootTenantId?: string }).rootTenantId!;
  }
  if (options.pki?.join)
    sim.note('--sim: JoinService uses throwaway dev keys instead of the configured pki.join');
  // Tunnels to the simulated machines: the deployment's issuer, else a throwaway one.
  const issuerName = new URL(options.baseURL).origin;
  const configured = (options as {
    tunnels?: { issuer?: ExecTicketIssuer; ssh?: SshCertificateAuthority; sandboxSsh?: SshCertificateAuthority };
  }).tunnels;
  const issuer = configured?.issuer ?? createExecTicketIssuer({ issuer: issuerName });
  // Break-glass (ssh-cert) and sandbox exec work in dev too: throwaway CAs unless the deployment has its own. Only
  // on a PGlite store: against a real database every node's spec would start trusting a CA that dies with this
  // process.
  const throwaway = (options.database as { kind?: string }).kind === 'pglite';
  const ssh =
    configured?.ssh ?? (throwaway ? createSshCertificateAuthority({ comment: 'better-compute dev ssh ca' }) : undefined);
  const sandboxSsh =
    configured?.sandboxSsh ??
    (throwaway ? createSshCertificateAuthority({ comment: 'better-compute dev sandbox ssh ca' }) : undefined);
  const simOptions: AnyComputeOptions = {
    ...options,
    iam,
    rootTenantId,
    modules,
    pki: { ...options.pki, nodeCa: keys.pki.nodeCa as never, join: keys.pki.join as never },
    notifier: options.notifier ?? notifier,
    ...({ tunnels: { ...configured, issuer, ...(ssh ? { ssh } : {}), ...(sandboxSsh ? { sandboxSsh } : {}) } } as object),
  };
  // The embedded test IAM has no session reviewer, so it cannot re-authorize an open tunnel: dev skips
  // the 60 s re-check (tickets are still decided by tunnels.open). A configured IAM keeps the default.
  const hostTunnels: HostTunnelsConfig = embedded ? { authorize: async () => true } : {};
  if (embedded)
    sim.note('--sim: tunnels are not re-authorized while open (embedded dev IAM, loopback only)');
  let fleet: DevFleet | undefined;
  let ended = false;
  return {
    options: simOptions,
    hostTunnels,
    // Suspending or deleting a tenant in the embedded IAM reaches its whole subtree in compute.
    ...(embedded
      ? {
          hostIam: {
            bridge: embedded.bridge,
            readTenants: iamTenantReader(embedded.iam, { credential: embedded.root.credential }),
          },
        }
      : {}),
    // The IAM bridge's module binds its projection to the runtime's store in `initialize()`.
    async afterMigrate() {},
    async started(compute) {
      fleet = await testing.attachDevFleet({
        compute,
        database: options.database,
        keys,
        notifier,
        root,
        rootTenantId,
        insecureHeaderAuth: true,
        gateway: { host: '127.0.0.1', port: 0 },
        tunnels: { issuer, issuerName },
      });
      sim.note(`Dev gateway (h2c, header auth, loopback only): ${fleet.gatewayUrl}`);
      if (embedded)
        sim.note(
          `Embedded IAM root tenant ${rootTenantId}; root token (dev only): ${root.token ?? ''}`,
        );
      const gpuModel =
        sim.variant === 'l40s' ? 'L40S' : sim.variant === 'cpu' ? null : ('H100' as const);
      // Acceptance checks the board's GPU count, so hgx-h100-gpu-missing machines are not adopted.
      const expectGpuCount = sim.variant === 'l40s' ? 4 : sim.variant === 'cpu' ? undefined : 8;
      const { poolId } = await fleet.createPool({
        gpuModel,
        key: `sim-${sim.variant}`,
        ...(expectGpuCount === undefined ? {} : { expectGpuCount }),
      });
      const nodes = await fleet.join({ poolId, count: sim.count, variant: sim.variant });
      sim.note(`Joined ${nodes.length} simulated ${sim.variant} node(s) into ${poolId}`);
      const joinedFleet = fleet;
      // Adoption runs on the real loops; report it without holding the server up.
      void joinedFleet
        .waitFor(nodes, { timeoutMs: 120_000 })
        .then(() => {
          if (!ended) sim.note(`${nodes.length} simulated node(s) adopted`);
        })
        .catch((error: unknown) => {
          if (!ended) sim.note(`Simulated nodes not adopted yet: ${(error as Error).message}`);
        });
    },
    async stopping() {
      ended = true;
      await fleet?.close();
      fleet = undefined;
    },
    async close() {
      await embedded?.close().catch(() => undefined);
    },
  };
}
