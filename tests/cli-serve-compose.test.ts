import { mkdtemp, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { connect, type ClientHttp2Session } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  createCli,
  createDeployment,
  unconfiguredIam,
  withHostModules,
  gatewayIdentity,
  gatewayOptions,
  hostFindings,
  mountTunnels,
  type CliIO,
} from '@better-compute/cli';
import { AGENT_GATEWAY_SERVICE, frameMessage, MessageDecoder } from '@better-compute/gateway';
import { createEmbeddedTestIam, type EmbeddedTestIam } from '@better-compute/iam/testing';
import {
  createCsr,
  generateP256KeyPair,
  parseCertificate,
  privateKeyPem,
  sealJoinToken,
  toPem,
  verifyJoinResponse,
} from '@better-compute/pki';
import { pglite } from '@better-compute/postgres/pglite';
import {
  AgentFrameSchema,
  AgentRole,
  decodeServerFrame,
  encodeAgentFrame,
  HardwareClaimsSchema,
  JoinRequestSchema,
  JoinResponseSchema,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  unwrapCommand,
} from '@better-compute/protocol';
import { betterCompute, type BetterCompute } from '@better-compute/server';
import { createDevJoinKeys } from '@better-compute/testing';
import { composeState, COMPOSE_SECRET, everyModule, METRICS_TOKEN } from './support/compose.js';

// The serve composition audit (PLAN.md §8.1-8.2, §14 topologies): every module of the repository in one
// control plane, as a production better-compute.config.ts registers them, first in process (registry,
// migrations, one pass of every job), then through `better-compute serve` with a `host` export: the API, the
// host's /watch and /metrics routes, /.well-known, and the gateway role over mTLS, where a machine joins
// with a sealed token and opens a Session with the certificate it got.

let compute: BetterCompute<any, any> | undefined;
let iam: EmbeddedTestIam | undefined;
afterEach(async () => {
  await compute?.stop().catch(() => undefined);
  await iam?.close();
  compute = undefined;
  iam = undefined;
});

/** One unary or streaming gRPC call over an HTTP/2 session; resolves with the decoded messages. */
function grpc(
  session: ClientHttp2Session,
  method: 'Join' | 'Session',
  body: Uint8Array,
  options: { endStream: boolean; untilMessages?: number },
): Promise<Uint8Array[]> {
  return new Promise((resolve, reject) => {
    const stream = session.request({
      ':method': 'POST',
      ':path': `/${AGENT_GATEWAY_SERVICE}/${method}`,
      'content-type': 'application/grpc+proto',
      te: 'trailers',
    });
    const decoder = new MessageDecoder(MAX_FRAME_BYTES);
    const messages: Uint8Array[] = [];
    let status: string | undefined;
    stream.on('response', (headers) => (status ??= headers['grpc-status'] as string | undefined));
    stream.on('trailers', (headers) => (status ??= headers['grpc-status'] as string | undefined));
    stream.on('data', (chunk: Uint8Array) => {
      messages.push(...decoder.push(chunk));
      if (options.untilMessages && messages.length >= options.untilMessages) {
        stream.close();
        resolve(messages);
      }
    });
    stream.on('error', reject);
    stream.on('close', () => {
      if (status !== undefined && status !== '0')
        reject(new Error(`grpc-status ${status}: ${stream.sentHeaders ? '' : 'refused'}`));
      else resolve(messages);
    });
    if (options.endStream) stream.end(frameMessage(body));
    else stream.write(frameMessage(body));
  });
}

/** The HTTP status an upgrade (WebSocket handshake) to `path` is answered with, or 101. */
function upgradeStatus(origin: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${origin}${path}`, {
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });
    req.on('response', (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    req.on('upgrade', (_response, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('error', reject);
    req.end();
  });
}

// Every wait below is on an event (a frame, a gRPC status, a stream end). The bounds only turn a
// hang into a readable failure; they are generous because several suites share this machine's CPU.
const EVENT_BOUND_MS = 45_000;

/** Resolves when `event` fires (checked on every frame and state change), or fails after the bound. */
function eventually(
  subscribe: (wake: () => void) => void,
  check: () => boolean,
  what: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no ${what} within ${EVENT_BOUND_MS} ms`)),
      EVENT_BOUND_MS,
    );
    const wake = () => {
      if (!check()) return;
      clearTimeout(timer);
      resolve();
    };
    subscribe(wake);
    wake();
  });
}

/** A daemon's Session over mutual TLS: Hello sent, server frames collected until the stream ends. */
function openSession(
  port: number,
  bundle: { rootCertificate: Uint8Array },
  certificate: { key: string; cert: string },
  nodeId: string,
) {
  const h2 = connect(`https://localhost:${port}`, {
    ca: toPem(bundle.rootCertificate),
    ...certificate,
  });
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const state = {
    frames: [] as ReturnType<typeof decodeServerFrame>[],
    closed: false,
    status: undefined as number | undefined,
    error: undefined as string | undefined,
    close: () => h2.destroy(),
    /** Resolves once `check` holds, re-checked on every frame and on the end of the stream. */
    when: (check: () => boolean, what: string) =>
      eventually((wake) => listeners.add(wake), check, what),
    /** Resolves when the stream ended: a gRPC status (a refusal is trailers-only) or a close. */
    ended: (what: string) => state.when(() => state.closed, what),
  };
  const end = () => {
    state.closed = true;
    changed();
  };
  h2.on('error', (error) => {
    state.error ??= error.message;
    end();
  });
  const stream = h2.request({
    ':method': 'POST',
    ':path': `/${AGENT_GATEWAY_SERVICE}/Session`,
    'content-type': 'application/grpc+proto',
    te: 'trailers',
  });
  const decoder = new MessageDecoder(MAX_FRAME_BYTES);
  const status = (headers: Record<string, unknown>) => {
    if (headers['grpc-status'] === undefined) return;
    state.status ??= Number(headers['grpc-status']);
    end();
  };
  stream.on('response', status);
  stream.on('trailers', status);
  stream.on('data', (chunk: Uint8Array) => {
    for (const bytes of decoder.push(chunk)) state.frames.push(decodeServerFrame(bytes));
    changed();
  });
  stream.on('error', (error) => {
    state.error ??= error.message;
    end();
  });
  stream.on('close', end);
  h2.on('close', end);
  stream.write(
    frameMessage(
      encodeAgentFrame(
        create(AgentFrameSchema, {
          msg: {
            case: 'hello',
            value: {
              nodeId,
              bootId: 'boot-compose',
              journalId: 'journal-compose',
              role: AgentRole.NODE,
              daemonVersion: '0.1.0',
              protoMin: PROTOCOL_VERSION.min,
              protoMax: PROTOCOL_VERSION.max,
            },
          },
        }),
      ),
    ),
  );
  return state;
}

describe('serve composition audit', () => {
  it(
    'registers, migrates and runs every module in one control plane',
    { timeout: 60_000 },
    async () => {
      iam = await createEmbeddedTestIam({ now: () => Date.now() });
      const keys = createDevJoinKeys();
      compute = betterCompute({
        database: pglite(),
        iam: iam.port,
        secret: COMPOSE_SECRET,
        baseURL: 'http://127.0.0.1:3000',
        modules: [...iam.bridge.modules, ...everyModule()],
        pki: keys.pki,
      } as any);
      expect(
        compute.registry.problems().filter((problem) => problem.kind !== 'undeclared'),
      ).toEqual([]);
      await compute.initialize();
      const failures: string[] = [];
      for (const [name, job] of Object.entries(compute.jobs))
        await job.tick().catch((error: unknown) => failures.push(`${name}: ${String(error)}`));
      expect(failures).toEqual([]);
      const check = await compute.selfCheck();
      expect(check.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
      const groups = new Set(compute.registry.methods.map((method) => method.group));
      for (const group of [
        'nodes',
        'pools',
        'reservations',
        'workflows',
        'metal',
        'instances',
        'webhooks',
        'fleet',
        'rollouts',
      ])
        expect(groups, group).toContain(group);
    },
  );

  it('composes gateway report hooks: capacity transitions, XID health first, then the configuration’s', () => {
    const xid = async () => undefined;
    const instances = async () => undefined;
    const fake = { endpoint: { origin: 'http://x' }, gatewayServices: {}, context: {} } as any;
    const composed = gatewayOptions({ xidStatusHandler: xid }, fake, { database: {} } as any, {
      region: 'eu-1',
      tls: {},
      options: { reports: { status: instances }, maxStreams: 10 },
    }) as { reports: Record<string, unknown>; maxStreams: number; region: string };
    expect(composed.reports.status).toEqual([xid, instances]);
    expect(Object.keys(composed.reports)).toEqual(
      expect.arrayContaining(['allocationBound', 'allocationReleased', 'allocationFailed']),
    );
    expect(composed).toMatchObject({ maxStreams: 10, region: 'eu-1' });
    expect(composed).not.toHaveProperty('tunnels');
  });

  it('authenticates daemons by node certificate or refuses to start the gateway role', () => {
    const gateway = { region: 'eu-1', tls: {} };
    // Never by name alone: no node CA and trust domain, no gateway.
    expect(() => gatewayIdentity({} as any, gateway)).toThrow(/node certificate/);
    const revocations = { has: () => false, subscribe: () => () => undefined };
    const certificate = new Uint8Array([1, 2, 3]);
    expect(
      gatewayIdentity(
        { pki: { nodeCa: { certificate, revocations }, join: { trustDomain: 'td.test' } } } as any,
        gateway,
      ),
    ).toEqual({ roots: [certificate], trustDomain: 'td.test', revocations });
    const roots = [new Uint8Array([9])];
    const explicit = gatewayIdentity({} as any, {
      ...gateway,
      identity: { roots, trustDomain: 'other.test' },
    });
    expect(explicit).toMatchObject({ roots, trustDomain: 'other.test' });
    // No set given: a fresh one, which the role's revocation feed fills from node_certs.
    expect(explicit.revocations.size).toBe(0);
    // Revocations reach createGateway for the live push.
    expect(
      gatewayOptions(
        { xidStatusHandler: undefined },
        { endpoint: {}, context: {} } as any,
        {} as any,
        gateway,
        {
          roots,
          trustDomain: 'x',
          revocations,
        },
      ),
    ).toMatchObject({ revocations });
  });

  it('mounts tunnels only with an issuer, and never without a re-authorizer', () => {
    const compute = {
      endpoint: { basePath: '/api/compute', origin: 'http://127.0.0.1:3000' },
      context: { sql: { query: async () => ({ rows: [] }) } },
    } as any;
    const issuer = { jwksJson: () => ({ keys: [] }) };
    expect(mountTunnels(compute, { iam: {} } as any)).toBeUndefined();
    // An IamPort without authorizeSession and no host.tunnels.authorize: refuse to mount.
    expect(() =>
      mountTunnels(compute, { iam: { authorize: async () => true }, tunnels: { issuer } } as any),
    ).toThrow(/re-authorizer/);
    const mount = mountTunnels(compute, { iam: {}, tunnels: { issuer }, database: {} } as any, {
      authorize: async () => false,
    });
    expect(typeof mount?.upgrade).toBe('function');
    mount?.close();
  });

  it('adds the store retention pass to every CLI deployment, once', () => {
    const names = (options: any) =>
      (withHostModules(options).modules ?? []).map((module: { name: string }) => module.name);
    expect(names({})).toEqual(['retention']);
    const own = { name: 'retention' };
    expect(withHostModules({ modules: [own] } as any).modules).toEqual([own]);
    const deployment = createDeployment(
      {
        database: pglite(),
        iam: unconfiguredIam(),
        secret: COMPOSE_SECRET,
        baseURL: 'http://127.0.0.1:3000',
        rootTenantId: 'root',
      },
      'test',
    );
    expect(Object.keys(deployment.compute.jobs)).toContain('core.retention');
    void deployment.close();
  });

  it('doctor reports host wiring problems', () => {
    const compute = { endpoint: { basePath: '/api/compute' } } as any;
    const checks = (options: any, host: any) =>
      hostFindings(compute, options, host).map((finding) => `${finding.severity} ${finding.check}`);
    expect(checks({}, {})).toEqual([]);
    const handler = () => new Response();
    expect(checks({}, { http: { routes: [{ path: '/api/compute/x', handler }] } })).toEqual([
      'error host.routes',
    ]);
    const gateway = { region: 'eu-1', tls: {} };
    // No node CA: the role would refuse to start; no internal API: other processes cannot reach it.
    expect(checks({}, { gateway })).toEqual([
      'error host.gateway.identity',
      'warning host.gateway.internal',
    ]);
    const pki = {
      nodeCa: { certificate: new Uint8Array([1]) },
      join: { trustDomain: 'td.test' },
    };
    // No revocation set is fine: the role makes one and its feed fills it from node_certs.
    // Tunnels without a re-authorizer (no authorizeSession, no host.tunnels.authorize) are refused.
    expect(checks({ pki, tunnels: { issuer: {} } }, { gateway: { ...gateway } })).toEqual([
      'error host.tunnels',
      'warning host.gateway.internal',
      'error host.gateway.tunnels',
    ]);
    const revocations = { has: () => false, subscribe: () => () => undefined };
    expect(
      checks(
        { pki: { ...pki, nodeCa: { ...pki.nodeCa, revocations } } },
        { gateway: { ...gateway, internal: { url: 'https://gw', tls: {} } } },
      ),
    ).toEqual(['warning host.gateway.notifier']);
  });

  it(
    'runs a metal verb as a provision workflow under betterCompute()',
    { timeout: 60_000 },
    async () => {
      iam = await createEmbeddedTestIam({ now: () => Date.now() });
      const database = pglite();
      compute = betterCompute({
        database,
        iam: iam.port,
        secret: COMPOSE_SECRET,
        baseURL: 'http://127.0.0.1:3000',
        modules: [...iam.bridge.modules, ...everyModule()],
        pki: createDevJoinKeys().pki,
      } as any);
      await compute.initialize();
      const api = compute.api as any;
      const root = iam.root.credential;
      const tenantId = iam.root.tenantId;
      const site = await api.sites.create(root, {
        tenantId,
        kind: 'shared',
        region: 'eu-1',
        idempotencyKey: 'compose-metal-site',
      });
      const pool = await api.pools.create(root, {
        tenantId,
        siteId: site.id,
        class: 'metal-host',
        agent: 'none',
        policy: { allowUnverifiedRelease: true, provisioningCidrs: ['10.30.0.0/16'] },
        idempotencyKey: 'compose-metal-pool',
      });
      // The verb runs through ctx.workflows (provision's engine): enrolling starts commissioning.
      const enrolled = await api.metal.enroll(root, {
        tenantId,
        siteId: site.id,
        poolId: pool.id,
        bmc: {
          address: 'https://10.20.0.9',
          driver: 'redfish',
          credentials: `secret://${tenantId}/bmc-compose`,
        },
      });
      // The metal reconciler picks the enrollment up and hands it to the workflow engine.
      const workflows = async () =>
        (
          await database.query<{ profile_id: string; state: string }>(
            'SELECT profile_id, state FROM workflows WHERE node_id = $1',
            [enrolled.nodeId],
          )
        ).rows;
      for (let pass = 0; pass < 5 && (await workflows()).length === 0; pass++)
        for (const job of Object.values(compute.jobs)) await job.tick().catch(() => undefined);
      const rows = await workflows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.state).not.toBe('failed');
    },
  );

  it(
    'serve runs the API, host routes and the gateway role over mTLS from one configuration',
    { timeout: 240_000 },
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'bc-serve-compose-'));
      const support = pathToFileURL(
        fileURLToPath(new URL('./support/compose.ts', import.meta.url)),
      ).href;
      await writeFile(
        join(cwd, 'better-compute.config.mjs'),
        `import { composedConfig } from '${support}';
const composed = await composedConfig();
export default composed.options;
export const host = composed.host;
`,
      );
      const controller = new AbortController();
      const notes: string[] = [];
      const io: CliIO = {
        out() {},
        err: (line) => notes.push(line),
        env: {},
        cwd,
        signal: controller.signal,
      };
      let failure: unknown;
      const done = createCli()
        .run(['serve', '--host', '127.0.0.1', '--port', '0'], io)
        .catch((error) => (failure = error));
      const noted = async (pattern: RegExp) => {
        for (let i = 0; i < 1200 && failure === undefined; i++) {
          const line = notes.find((note) => pattern.test(note));
          if (line) return line;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw failure ?? new Error(`no note matching ${pattern}: ${notes.join('\n')}`);
      };
      const gatewayPort = Number(/on port (\d+) \(mTLS\)/.exec(await noted(/\(mTLS\)/))![1]);
      const api = /listening on (\S+)/.exec(await noted(/listening on/))![1]!;
      const origin = new URL(api).origin;
      const { iam: embedded, bundle } = composeState()!;
      const root = embedded.root;
      const call = async (path: string, input: unknown) => {
        const response = await fetch(`${api}/${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${root.credential.token}`,
            'content-type': 'application/json',
            'x-better-compute': '1',
          },
          body: JSON.stringify(input),
        });
        const body = (await response.json()) as { data?: any; error?: unknown };
        if (!response.ok) throw new Error(`${path}: ${JSON.stringify(body.error)}`);
        return body.data;
      };

      try {
        // The host's built-ins and routes.
        expect((await fetch(`${origin}/healthz`)).status).toBe(200);
        expect((await fetch(`${origin}/readyz`)).status).toBe(200);
        // The server's own document, at the origin root too: JoinService's public keys included.
        const rootDocument = await (await fetch(`${origin}/.well-known/better-compute`)).json();
        const apiDocument = await (await fetch(`${api}/.well-known/better-compute`)).json();
        expect(rootDocument).toEqual(apiDocument);
        expect(rootDocument).toMatchObject({
          name: 'better-compute',
          basePath: '/api/compute',
          join: { encryptionJwk: { kty: 'EC', crv: 'P-256' } },
        });
        expect(rootDocument.join.encryptionJwk).not.toHaveProperty('d');
        expect((await fetch(`${origin}/metrics`)).status).toBe(401);
        const metrics = await fetch(`${origin}/metrics`, {
          headers: { authorization: `Bearer ${METRICS_TOKEN}` },
        });
        expect(metrics.status).toBe(200);
        const scraped = await metrics.text();
        expect(scraped).toContain('better_compute_');
        // The gateway role's own series, sampled at scrape.
        expect(scraped).toContain('better_compute_gateway_stream_headroom');
        expect((await fetch(`${origin}/metrics`, { method: 'POST' })).status).toBe(405);

        // Tunnels are mounted on the api's upgrade event: a forged ticket is refused by handleTunnel
        // (not a 404), and other upgrade paths are left alone.
        expect(notes.join('\n')).toContain('Tunnels: /api/compute/tunnels/{ticket}');
        expect(
          await upgradeStatus(origin, '/api/compute/tunnels/not.a.ticket'),
        ).toBeGreaterThanOrEqual(400);
        expect(await upgradeStatus(origin, '/api/compute/tunnels/not.a.ticket')).not.toBe(404);
        expect(await upgradeStatus(origin, '/elsewhere')).toBe(404);

        // The events module's SSE watch, as the root administrator.
        const watch = await fetch(`${origin}/watch?types=node.*`, {
          headers: { authorization: `Bearer ${root.credential.token}` },
        });
        expect(watch.status).toBe(200);
        expect(watch.headers.get('content-type')).toContain('text/event-stream');

        // A site, a pool and a join token through the API; a machine joins over the gateway's TLS
        // listener (server-authenticated) with a sealed token bound to its CSR.
        const tenantId = root.tenantId;
        const site = await call('sites/create', {
          tenantId,
          kind: 'shared',
          region: 'eu-1',
          idempotencyKey: 'compose-site',
        });
        const pool = await call('pools/create', {
          tenantId,
          siteId: site.id,
          class: 'metal-host',
          gpuModel: 'H100',
          idempotencyKey: 'compose-pool',
        });
        const minted = await call('joinTokens/create', {
          tenantId,
          poolId: pool.id,
          ttlSeconds: 600,
          idempotencyKey: 'compose-token',
        });
        const nodeKey = generateP256KeyPair().privateKey;
        const csr = createCsr(nodeKey);
        const serverAuth = connect(`https://localhost:${gatewayPort}`, {
          ca: toPem(bundle.rootCertificate),
        });
        serverAuth.on('error', () => undefined);
        const [answer] = await grpc(
          serverAuth,
          'Join',
          toBinary(
            JoinRequestSchema,
            create(JoinRequestSchema, {
              sealedToken: new TextEncoder().encode(
                sealJoinToken(minted.token, bundle.joinEncryption.publicKey, {
                  csr,
                  issuedAt: Date.now(),
                }),
              ),
              csr,
              claims: create(HardwareClaimsSchema, {
                productUuid: '4c4c4544-0042-3510-8052-b7c04f4e4e99',
                productSerial: 'SN-COMPOSE-01',
                permanentMacs: ['3c:ec:ef:10:20:99'],
              }),
              daemonVersion: '0.1.0',
              role: AgentRole.NODE,
            }),
          ),
          { endStream: true },
        );
        serverAuth.close();
        const joined = verifyJoinResponse(fromBinary(JoinResponseSchema, answer!), {
          signer: { publicKey: bundle.joinSigning.publicKey },
          csr,
          nodeCaRoots: [bundle.nodeCa.certificate],
          now: Date.now(),
        });

        // A reboot queued while the certificate is unrestricted (the restricted re-join case).
        const { compute: served, database } = composeState()!;
        const enqueue = (kind: string, key: string) =>
          database!.transaction((tx) =>
            served!.context.commands.enqueue(tx, {
              nodeId: joined.nodeId,
              kind,
              payload: {},
              idempotencyKey: key,
              notAfter: Date.now() + 600_000,
            }),
          );
        const reboot = await enqueue('node.reboot', 'compose-reboot');

        // Then the certificate is restricted (as discovery/ramdisk joins get): only diag.* may reach it.
        await database!.query(
          `UPDATE node_certs SET allowed_kinds = ARRAY['diag.*'] WHERE node_id = $1`,
          [joined.nodeId],
        );
        // Defense at the source: the queue refuses new disallowed kinds for a restricted identity.
        await expect(enqueue('node.reboot', 'compose-reboot-2')).rejects.toThrow(/restricted/);
        const certificate = {
          key: privateKeyPem(nodeKey),
          cert: joined.certChain.map((der) => toPem(der)).join(''),
        };

        // The node opens its Session with the issued certificate (mutual TLS) and is welcomed.
        const live = openSession(gatewayPort, bundle, certificate, joined.nodeId);
        await live.when(() => live.frames.length > 0 || live.closed, 'Welcome');
        expect(live.error ?? live.status).toBeUndefined();
        expect(live.frames[0]!.msg.case).toBe('welcome');

        // Defense at the gateway: the queued reboot is never sent (it settles server-side); the
        // allowed kind is dispatched.
        const enqueued = { reboot, diag: await enqueue('diag.nvml', 'compose-diag') };
        const commandKinds = () =>
          live.frames
            .filter((frame) => frame.msg.case === 'command')
            .map((frame) => unwrapCommand(frame.msg.value as never).kind);
        await live.when(() => commandKinds().includes('diag.nvml'), 'diag.nvml dispatch');
        const rebootRow = await database!.query<{ state: string }>(
          'SELECT state FROM commands WHERE id = $1',
          [enqueued.reboot.id],
        );
        expect(rebootRow.rows[0]!.state).not.toMatch(/^(pending|dispatched|accepted|running)$/);
        expect(commandKinds()).not.toContain('node.reboot');

        // Revocation: the live session is closed (RevocationNotice), and the certificate is refused
        // at the next open.
        await bundle.nodeCa.revoke(parseCertificate(joined.certChain[0]!).serial, 'key-compromise');
        await live.ended('close of the revoked session');
        const again = openSession(gatewayPort, bundle, certificate, joined.nodeId);
        await again.ended('refusal of the revoked certificate');
        expect(again.status).toBe(16); // UNAUTHENTICATED
        expect(again.frames.some((frame) => frame.msg.case === 'welcome')).toBe(false);
        live.close();
        again.close();

        // node.joined reaches the SSE watch through the outbox.
        const reader = watch.body!.getReader();
        let text = '';
        const deadline = Date.now() + EVENT_BOUND_MS;
        while (!text.includes('node.joined') && Date.now() < deadline) {
          const { value, done: ended } = await reader.read();
          if (ended) break;
          text += new TextDecoder().decode(value);
        }
        expect(text).toContain('node.joined');
        await reader.cancel();
      } finally {
        controller.abort();
        await done;
        await composeState()?.iam.close();
      }
      if (failure) throw failure;
      expect(notes.join('\n')).toContain('Stopping');
    },
  );
});
