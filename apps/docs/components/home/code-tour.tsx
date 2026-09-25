import { highlight } from 'fumadocs-core/highlight';
import { codeThemes } from '@/lib/code-themes';
import { CodeTourView, type TourStep } from './code-tour-view';

/**
 * Checked against the real APIs: `betterCompute` options (packages/server/src/options.ts), the IAM bridge
 * (packages/iam/src/bridge.ts and its README), the typed client (packages/client), the CLI manifest
 * (apps/docs/generated/cli.json), and FleetConfig validation (packages/fleet/src/config.ts). The typed client's
 * inputs are the validated shapes, so `duration` is milliseconds there (HTTP and the CLI also take '8h') and
 * `binding` is spelled out. Keep lines under ~84 characters so the panel never scrolls sideways.
 */
const steps: (Omit<TourStep, 'code' | 'raw'> & { lang: string; source: string })[] = [
  {
    id: 'compose',
    title: 'Compose the control plane',
    summary: 'The store, the deployment secret, Better IAM, and the modules you run.',
    file: 'lib/compute.ts',
    lang: 'ts',
    source: `import { betterCompute } from 'better-compute';
import { metal } from 'better-compute/metal';
import { postgres } from 'better-compute/postgres';
import { provisionModule } from 'better-compute/provision';
import { vps } from 'better-compute/vps';
import { bridge, iam, rootTenantId } from './iam';

// provision runs metal's workflows; the server never imports either.
const bareMetal = metal();
const provision = provisionModule({ modules: [bareMetal] });

export const compute = betterCompute({
  database: postgres({ url: process.env.BETTER_COMPUTE_DATABASE_URL! }),
  secret: process.env.BETTER_COMPUTE_SECRET!, // at least 32 characters
  baseURL: 'https://compute.example.com',
  iam: bridge.embedded(iam, { rootTenantId }),
  modules: [provision, bareMetal, vps(), ...bridge.modules],
});

await compute.initialize(); // checks the registry, migrates, starts modules`,
  },
  {
    id: 'iam',
    title: 'Install the Better IAM bridge',
    summary: 'Compute’s catalog, resolver, and event inbox, installed in Better IAM.',
    file: 'lib/iam.ts',
    lang: 'ts',
    source: `import { postgresAdapter } from '@better-iam/adapter-postgres';
import { betterIam } from '@better-iam/server';
import { createComputeIamBridge } from 'better-compute/iam';
import { metal } from 'better-compute/metal';
import { vps } from 'better-compute/vps';

// Merges compute's catalog with the catalogs of the modules in use.
export const bridge = createComputeIamBridge({ modules: [metal(), vps()] });
export const rootTenantId = process.env.IAM_ROOT_TENANT_ID!;

export const iam = betterIam({
  database: postgresAdapter({ connectionString: process.env.IAM_DATABASE_URL! }),
  secret: process.env.BETTER_IAM_SECRET!,
  baseURL: 'https://iam.example.com',
  plugins: [bridge.plugin()], // catalog + afterAudit → compute's inbox
  resolveResource: bridge.resolveResource(), // the in-memory projection
});`,
  },
  {
    id: 'client',
    title: 'Reserve from the typed client',
    summary: 'Inferred from the server: groups exist only when their module is registered.',
    file: 'app/gpus/reserve.ts',
    lang: 'ts',
    source: `import { createComputeClient } from 'better-compute/client';
import type { compute } from '@/lib/compute';

const client = createComputeClient<typeof compute>({ token: () => session.token });

const reservation = await client.reservations.create({
  tenantId,
  poolId,
  devices: [{ class: 'gpu', count: 4, topology: 'nvlink-all' }],
  duration: 8 * 3_600_000, // 8 h in milliseconds; HTTP and the CLI take '8h'
  binding: 'hold',
  idempotencyKey: crypto.randomUUID(), // a retry with the same key replays
});

// Once the node reports it bound: { nodeId, cdiDevices, envFile }.
const { binding } = await client.reservations.get({
  tenantId,
  reservationId: reservation.id,
});`,
  },
  {
    id: 'local',
    title: 'Run it on your laptop',
    summary: 'PGlite, an embedded Better IAM, and simulated GPU machines that join like bcd.',
    file: 'terminal',
    lang: 'sh',
    source: `# Eight simulated HGX H100 machines join, pass diag.nvml, and are adopted.
better-compute dev --memory --sim 8

# In a second terminal, as the root token dev printed:
export BETTER_COMPUTE_URL=http://127.0.0.1:3000
export BETTER_COMPUTE_TOKEN=biam_ses_…

better-compute api pools.list tenantId=$TENANT
better-compute reserve --tenant $TENANT --pool $POOL --gpus 4 --for 1h
better-compute capacity --tenant $TENANT --pool $POOL

# The deterministic fleet simulator, with chaos and invariant checks.
better-compute sim --nodes 500 --duration 1h --chaos heavy`,
  },
  {
    id: 'fleet',
    title: 'Keep the fleet in a document',
    summary: 'fleet plan shows every change; fleet apply runs exactly that plan, or nothing.',
    file: 'fleet.json',
    lang: 'json',
    source: `{
  "version": 1,
  "sites": [{ "name": "fra", "kind": "shared", "region": "eu-central" }],
  "pools": [
    {
      "name": "h100-fra",
      "site": "fra",
      "class": "metal-host",
      "gpuModel": "H100",
      "ownerQuota": { "gpu": 512 },
      "offers": [{ "tenant": "acme", "quota": { "gpu": 64 }, "priority": 5 }]
    }
  ]
}`,
  },
];

export async function CodeTour() {
  const rendered: TourStep[] = await Promise.all(
    steps.map(async ({ lang, source, ...step }) => ({
      ...step,
      raw: source,
      code: await highlight(source, {
        lang,
        themes: codeThemes,
        defaultColor: false,
      }),
    })),
  );
  return <CodeTourView steps={rendered} />;
}
