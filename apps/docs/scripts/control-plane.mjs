// The control plane both reference generators read (apps/docs/scripts/generate.mjs and
// scripts/api-reference.mjs): EVERY module registered (provision + metal, vps, events, fleet, rollout,
// audit, beside the built-in node controllers, inventory and capacity) on a PGlite executor that is never
// opened and an IamPort that refuses everything, so the method registry, command kinds, migrations and
// jobs are the ones a full deployment serves. A method's status ("registered" or "planned") is read from
// this registry, never from a smaller server.
//
// Reads the built packages (`tsc -b` first).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The packages (and entry files) the control plane is built from. */
export const controlPlanePackages = Object.freeze({
  core: 'index.js',
  server: 'index.js',
  postgres: 'pglite.js',
  pki: 'index.js',
  provision: 'index.js',
  metal: 'index.js',
  vps: 'index.js',
  events: 'index.js',
  fleet: 'index.js',
  rollout: 'index.js',
  audit: 'index.js',
});

const dist = (root, pkg, entry) => join(root, 'packages', pkg, 'dist', entry);

/** The control-plane packages whose build is missing. */
export const missingBuilds = (root) =>
  Object.entries(controlPlanePackages)
    .filter(([pkg, entry]) => !existsSync(dist(root, pkg, entry)))
    .map(([pkg]) => pkg);

/** A package's version, from its package.json (what a release publishes). */
export const packageVersion = (root, pkg) =>
  JSON.parse(readFileSync(join(root, 'packages', pkg, 'package.json'), 'utf8')).version;

/**
 * Builds the full control plane. `who` names the caller in the refusal of any IAM call; `secret` and
 * `baseURL` are placeholders that never reach the output.
 */
export async function fullControlPlane(root, { who, secret, baseURL }) {
  const load = (pkg) => import(pathToFileURL(dist(root, pkg, controlPlanePackages[pkg])).href);
  const server = await load('server');
  const { pglite } = await load('postgres');
  const pki = await load('pki');
  const { provisionModule } = await load('provision');
  const { metal } = await load('metal');
  const { vps } = await load('vps');
  const { eventsModule } = await load('events');
  const { fleetModule } = await load('fleet');
  const { rolloutModule } = await load('rollout');
  const { auditModule } = await load('audit');

  const refuse = () => Promise.reject(new Error(`${who} never calls IAM`));
  const database = pglite();
  const metalModule = metal();
  const compute = server.betterCompute({
    database,
    iam: {
      authenticate: refuse,
      require: refuse,
      authorize: refuse,
      authorizeMany: refuse,
      requestConfirmation: refuse,
      billingCheck: refuse,
      recordUsage: refuse,
      featureEnabled: refuse,
      capabilities: () => ({
        pluginResolver: false,
        eventDetail: false,
        evaluate: false,
        readOnlyDecisions: false,
      }),
    },
    secret,
    baseURL,
    rootTenantId: 'root',
    // Tunnels (tunnels.open, nodes.issueSshCert/revokeSshCert) register only with an exec-ticket issuer.
    tunnels: { issuer: pki.createExecTicketIssuer({ issuer: 'https://docs.invalid' }) },
    modules: [
      provisionModule({ modules: [metalModule] }),
      metalModule,
      vps(),
      eventsModule({ secret }),
      fleetModule(),
      rolloutModule({
        release: { pins: [pki.spkiPin(pki.generateP256KeyPair().publicKey)] },
        downloadsUrl: 'https://downloads.example.com',
      }),
      auditModule({ signer: pki.createSigningKey() }),
    ],
  });
  return { compute, database, server };
}
