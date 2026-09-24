import { timingSafeEqual } from 'node:crypto';
import type { ComputeModule } from '@better-compute/core';
import { auditModule } from '@better-compute/audit';
import { defineHost } from '@better-compute/cli';
import { eventsModule, handleWatch } from '@better-compute/events';
import { fleetModule } from '@better-compute/fleet';
import { createEmbeddedTestIam, type EmbeddedTestIam } from '@better-compute/iam/testing';
import { metal } from '@better-compute/metal';
import { createMetrics, metricsHandler, standardMetrics } from '@better-compute/observability';
import {
  createPkiBundle,
  createSigningKey,
  generateP256KeyPair,
  privateKeyPem,
  spkiPin,
  toPem,
  type PkiBundle,
} from '@better-compute/pki';
import { pglite } from '@better-compute/postgres/pglite';
import { provisionModule } from '@better-compute/provision';
import { rolloutModule } from '@better-compute/rollout';
import { pkiJoinCrypto } from '@better-compute/server';
import { instanceStatusHandler, vps } from '@better-compute/vps';

// The serve composition audit's deployment (tests/cli-serve-compose.test.ts): every module of the repository
// in one control plane, and a `host` export with the gateway role over mTLS, the events module's SSE watch and
// the metrics endpoint, as a production better-compute.config.ts would write them.

export const COMPOSE_SECRET = 'better-compute-compose-audit-secret-0123456789';
export const METRICS_TOKEN = 'compose-metrics-token-0123456789';
export const TRUST_DOMAIN = 'compute.compose.test';

export function everyModule(): ComputeModule[] {
  const metalModule = metal();
  return [
    provisionModule({ modules: [metalModule] }),
    metalModule,
    vps(),
    eventsModule({ secret: COMPOSE_SECRET }),
    fleetModule(),
    rolloutModule({
      release: { pins: [spkiPin(generateP256KeyPair().publicKey)] },
      downloadsUrl: 'https://downloads.compute.test',
    }),
    auditModule({ signer: createSigningKey() }),
  ] as ComputeModule[];
}

/** What the test needs from the deployment the configuration built (same process, same module graph). */
export interface ComposeState {
  iam: EmbeddedTestIam;
  bundle: PkiBundle;
}

const stateKey = Symbol.for('better-compute.tests.compose');
export const composeState = (): ComposeState | undefined =>
  (globalThis as Record<symbol, ComposeState | undefined>)[stateKey];

/** The configuration module's exports: `default` (the options factory) and `host`. */
export async function composedConfig() {
  const iam = await createEmbeddedTestIam({ now: () => Date.now() });
  const bundle = createPkiBundle({ trustDomain: TRUST_DOMAIN });
  const gatewayKey = generateP256KeyPair();
  const issued = await bundle.servingCa.issue(gatewayKey.publicKey, {
    usage: 'server',
    dnsSans: ['localhost'],
    role: 'gateway',
    ttlSeconds: 86_400,
  });
  (globalThis as Record<symbol, ComposeState>)[stateKey] = { iam, bundle };
  const metrics = createMetrics();
  standardMetrics(metrics);

  const options = () => ({
    database: pglite(),
    iam: iam.port,
    secret: COMPOSE_SECRET,
    baseURL: 'http://127.0.0.1:3000',
    modules: [...iam.bridge.modules, ...everyModule()],
    pki: {
      nodeCa: bundle.nodeCa,
      join: pkiJoinCrypto({
        trustDomain: TRUST_DOMAIN,
        nodeCa: bundle.nodeCa,
        signingKey: bundle.joinSigning,
        encryptionKey: bundle.joinEncryption.privateKey,
      }),
    },
  });

  const host = defineHost(({ compute }) => ({
    http: {
      routes: [
        {
          path: '/watch',
          method: 'GET',
          handler: (request: Request) =>
            handleWatch(request, {
              sql: compute.context.sql,
              // The host's IAM decision: the caller's own tenant.
              authorize: async (watch) => {
                const token = watch.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
                const caller = await compute.context.iam.authenticate({ token });
                return { tenantId: caller.tenantId };
              },
              pollMs: 50,
            }),
        },
        {
          path: '/metrics',
          method: 'GET',
          handler: metricsHandler({
            registry: metrics,
            bearerToken: METRICS_TOKEN,
            timingSafeEqual,
          }),
        },
      ],
    },
    gateway: {
      region: 'eu-1',
      listen: { host: '127.0.0.1', port: 0 },
      tls: {
        key: privateKeyPem(gatewayKey.privateKey),
        cert: [issued.certificate, ...issued.chain.slice(0, -1)].map((der) => toPem(der)).join(''),
        ca: bundle.nodeCa.export().certificatesPem,
      },
      // vps() is registered: its orphan detection joins the default XID status handler.
      options: { reports: { status: instanceStatusHandler({ events: compute.context.events }) } },
    },
  }));

  return { options, host };
}
