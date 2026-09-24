import { mkdtemp, writeFile } from 'node:fs/promises';
import { connect, type ClientHttp2Session } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { createCli, gatewayIdentity, gatewayOptions, type CliIO } from '@better-compute/cli';
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

const until = async (check: () => boolean, timeoutMs: number, what: string) => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

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
  h2.on('error', () => undefined);
  const state = {
    frames: [] as ReturnType<typeof decodeServerFrame>[],
    closed: false,
    status: undefined as number | undefined,
    close: () => h2.destroy(),
  };
  const stream = h2.request({
    ':method': 'POST',
    ':path': `/${AGENT_GATEWAY_SERVICE}/Session`,
    'content-type': 'application/grpc+proto',
    te: 'trailers',
  });
  const decoder = new MessageDecoder(MAX_FRAME_BYTES);
  // A refusal is trailers-only (the status in the response headers); a close sends trailers.
  const status = (headers: Record<string, unknown>) => {
    if (headers['grpc-status'] === undefined) return;
    state.status ??= Number(headers['grpc-status']);
    state.closed = true;
  };
  stream.on('response', status);
  stream.on('trailers', status);
  stream.on('data', (chunk: Uint8Array) => {
    for (const bytes of decoder.push(chunk)) state.frames.push(decodeServerFrame(bytes));
  });
  stream.on('error', () => undefined);
  stream.on('close', () => (state.closed = true));
  h2.on('close', () => (state.closed = true));
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
    expect(
      gatewayIdentity({} as any, { ...gateway, identity: { roots, trustDomain: 'other.test' } }),
    ).toEqual({ roots, trustDomain: 'other.test' });
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

  // ([37c0ab]) createModuleContext sets no ctx.workflows yet, so metal verbs fail under betterCompute().
  it.todo('runs a metal verb as a provision workflow under betterCompute()');

  it(
    'serve runs the API, host routes and the gateway role over mTLS from one configuration',
    { timeout: 90_000 },
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
        expect(await (await fetch(`${origin}/.well-known/better-compute`)).json()).toMatchObject({
          name: 'better-compute',
          // The public base URL, not the bind address.
          api: 'http://127.0.0.1:3000/api/compute',
        });
        expect((await fetch(`${origin}/metrics`)).status).toBe(401);
        const metrics = await fetch(`${origin}/metrics`, {
          headers: { authorization: `Bearer ${METRICS_TOKEN}` },
        });
        expect(metrics.status).toBe(200);
        expect(await metrics.text()).toContain('better_compute_');
        expect((await fetch(`${origin}/metrics`, { method: 'POST' })).status).toBe(405);

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

        // A restricted certificate (as discovery/ramdisk joins get): only diag.* may reach it.
        const { compute: served, database } = composeState()!;
        await database!.query(
          `UPDATE node_certs SET allowed_kinds = ARRAY['diag.*'] WHERE node_id = $1`,
          [joined.nodeId],
        );
        const certificate = {
          key: privateKeyPem(nodeKey),
          cert: joined.certChain.map((der) => toPem(der)).join(''),
        };

        // The node opens its Session with the issued certificate (mutual TLS) and is welcomed.
        const live = openSession(gatewayPort, bundle, certificate, joined.nodeId);
        await until(() => live.frames.length > 0, 10_000, 'Welcome');
        expect(live.frames[0]!.msg.case).toBe('welcome');

        // A disallowed kind is never sent: it settles server-side; the allowed one is dispatched.
        const enqueued = await database!.transaction(async (tx) => ({
          reboot: await served!.context.commands.enqueue(tx, {
            nodeId: joined.nodeId,
            kind: 'node.reboot',
            payload: {},
            idempotencyKey: 'compose-reboot',
            notAfter: Date.now() + 600_000,
          }),
          diag: await served!.context.commands.enqueue(tx, {
            nodeId: joined.nodeId,
            kind: 'diag.nvml',
            payload: {},
            idempotencyKey: 'compose-diag',
            notAfter: Date.now() + 600_000,
          }),
        }));
        const commandKinds = () =>
          live.frames
            .filter((frame) => frame.msg.case === 'command')
            .map((frame) => unwrapCommand(frame.msg.value as never).kind);
        await until(() => commandKinds().includes('diag.nvml'), 15_000, 'diag.nvml dispatch');
        const reboot = await database!.query<{ state: string }>(
          'SELECT state FROM commands WHERE id = $1',
          [enqueued.reboot.id],
        );
        expect(reboot.rows[0]!.state).not.toMatch(/^(pending|dispatched|accepted|running)$/);
        expect(commandKinds()).not.toContain('node.reboot');

        // Revocation: the live session is closed (RevocationNotice), and the certificate is refused
        // at the next open.
        await bundle.nodeCa.revoke(parseCertificate(joined.certChain[0]!).serial, 'key-compromise');
        await until(() => live.closed, 10_000, 'the revoked session to close');
        const again = openSession(gatewayPort, bundle, certificate, joined.nodeId);
        await until(() => again.closed, 10_000, 'the revoked certificate to be refused');
        expect(again.status).toBe(16); // UNAUTHENTICATED
        expect(again.frames.some((frame) => frame.msg.case === 'welcome')).toBe(false);
        live.close();
        again.close();

        // node.joined reaches the SSE watch through the outbox.
        const reader = watch.body!.getReader();
        let text = '';
        const deadline = Date.now() + 20_000;
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
