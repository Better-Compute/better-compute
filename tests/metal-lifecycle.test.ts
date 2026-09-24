import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  apiSurface,
  type CommandQueue,
  type EventPublisher,
  type MethodContext,
  type ModuleContext,
  type SecretBroker,
  type SqlExecutor,
  type WorkQueue,
} from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import { fromJson, type DescMessage } from '@bufbuild/protobuf';
import { commandKinds, protocolRegistry } from '@better-compute/protocol';
import {
  defineProfile,
  provisionMigrations,
  provisionModule,
  registerImage,
} from '@better-compute/provision';
import {
  metal,
  metalCommandKinds,
  metalMigrations,
  metalWorkKind,
  reconcileMetalNode,
  resolveDriverBindings,
  type MetalApi,
} from '@better-compute/metal';

// The metal lifecycle (PLAN.md §3.5, §11.1) end to end on PGlite: the metal reconciler runs each
// provision state's workflow on the real workflow engine; a simulated site agent and ramdisk answer
// the commands (and the ramdisk "reboots" into the installed OS on kexec).

const SITE_AGENT = 'node_siteagent00000000000000001';
let db: SqlExecutor;
const attestedKinds = new Set(metalCommandKinds.filter((k) => k.attested).map((k) => k.kind));

// --- Ports ---------------------------------------------------------------------------------------

const queue = new Map<string, { kind: string; key: string }>();
const work: WorkQueue = {
  async enqueue(_tx, kind, key) {
    queue.set(`${kind}:${key}`, { kind, key });
  },
};
const events: { type: string; data: Record<string, unknown> }[] = [];
const eventLog: EventPublisher = {
  async publish(_tx, event) {
    events.push({ type: event.type, data: event.data as Record<string, unknown> });
  },
};
let commandSeq = 0;
const commands: CommandQueue = {
  async enqueue(tx, command) {
    const existing = await tx.query<{ id: string }>('SELECT id FROM commands WHERE node_id = $1 AND idempotency_key = $2', [
      command.nodeId,
      command.idempotencyKey,
    ]);
    if (existing.rows[0]) return { id: existing.rows[0].id, seq: 0 };
    const id = `cmd_${String(++commandSeq).padStart(26, '0')}`;
    await tx.query(
      `INSERT INTO commands (id, node_id, seq, kind, body, state, not_after, retry_safe, self_terminating, attested, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, 'pending', to_timestamp($6 / 1000.0), false, $7, $8, $9)`,
      [
        id,
        command.nodeId,
        commandSeq,
        command.kind,
        new TextEncoder().encode(JSON.stringify(command.payload)),
        command.notAfter,
        command.kind === 'boot.kexec',
        attestedKinds.has(command.kind),
        command.idempotencyKey,
      ],
    );
    return { id, seq: commandSeq };
  },
  async cancel(tx, id) {
    await tx.query(`UPDATE commands SET state = 'cancelled' WHERE id = $1 AND state IN ('pending', 'dispatched', 'acked', 'running')`, [id]);
  },
};
const stored = new Map<string, string>();
const secrets: SecretBroker = {
  async put(tenantId, value) {
    const ref = `secret://${tenantId}/${stored.size + 1}` as const;
    stored.set(ref, value);
    return ref;
  },
  async resolve(ref) {
    return stored.get(ref) ?? '';
  },
};

// --- Modules ---------------------------------------------------------------------------------------

const hardwareProfiles = { 'gpu-redfish': { drivers: { boot: 'ipxe', deploy: 'image-stream', inspect: 'agent' } } };
const bareMetal = metal({ hardwareProfiles });
const gpuHost = defineProfile({
  id: 'ubuntu-24.04-gpu-host',
  version: 1,
  target: 'metal',
  role: 'host',
  image: { ref: 'ubuntu-24.04-server@2026.09', format: 'raw', compression: 'zstd' },
  userData: { kind: 'cloud-init', template: 'bcd-host.yaml.hbs' },
  steps: [
    { use: 'userdata.render' },
    { use: 'boot.prepareRamdisk', on: 'site' },
    { use: 'management.setBootDevice', on: 'site', with: { device: 'pxe' } },
    { use: 'power.setPower', on: 'site', with: { action: 'cycle' } },
    { use: 'wait.agentJoined', with: { role: 'ramdisk' } },
    { use: 'deploy.deploy', on: 'ramdisk', timeout: '30m' },
    { use: 'management.setBootDevice', on: 'site', with: { device: 'disk' } },
    { use: 'boot.kexec', on: 'ramdisk', await: 'rejoin', timeout: '15m' },
  ],
});
const provision = provisionModule({
  modules: [bareMetal],
  profiles: [gpuHost],
  userData: { controlPlaneUrl: 'https://gw.example.com', bcdUrl: 'https://dl.example.com/bcd', bcdSha256: 'cd'.repeat(32) },
});
const issuedTokens: { role: string; maxUses?: number }[] = [];
const pki = {
  async issueJoinToken(_tx: unknown, input: { role: string; maxUses?: number }) {
    issuedTokens.push(input);
    return { id: `jt_${issuedTokens.length}`, token: `bcj_secret_${issuedTokens.length}` };
  },
};

let context: ModuleContext & MethodContext;
let api: MetalApi;

// --- The simulated agents --------------------------------------------------------------------------

/** Behaviour switches for failure cases. */
const agents = { attestWipe: true, dcgmPasses: true, kexecRejoins: true };
const seen: { kind: string; node: string; payload: Record<string, unknown> }[] = [];

async function connect(nodeId: string, role: string, bootId: string) {
  await db.query(
    `INSERT INTO node_sessions (node_id, session_epoch, boot_id, role, connected_at) VALUES ($1, 1, $2, $3, compute_now())
     ON CONFLICT (node_id) DO UPDATE SET boot_id = EXCLUDED.boot_id, role = EXCLUDED.role, connected_at = compute_now(),
       disconnected_at = NULL, session_epoch = node_sessions.session_epoch + 1`,
    [nodeId, bootId, role],
  );
}

/** Answers every pending command the way a healthy site agent and ramdisk would. */
async function runAgents(): Promise<number> {
  const { rows } = await db.query<{ id: string; node_id: string; kind: string; body: Uint8Array }>(
    `SELECT id, node_id, kind, body FROM commands WHERE state = 'pending' ORDER BY seq`,
  );
  for (const command of rows) {
    const payload = JSON.parse(new TextDecoder().decode(command.body)) as Record<string, any>;
    seen.push({ kind: command.kind, node: command.node_id, payload });
    // Site commands name the machine by its BMC address; ramdisk commands run on the machine.
    const args = typeof payload.argsJson === 'string' ? (JSON.parse(payload.argsJson) as Record<string, any>) : {};
    const byBmc = payload.address
      ? (await db.query<{ node_id: string }>('SELECT node_id FROM metal_nodes WHERE bmc_address = $1', [payload.address])).rows[0]?.node_id
      : undefined;
    const target = byBmc ?? command.node_id;
    let result: unknown = {};
    let state = 'succeeded';
    switch (command.kind) {
      case 'bmc.query':
        result = payload.operation === 'inspect.inspect' ? { macs: ['B8:CE:F6:00:00:01'], productUuid: '4C4C4544-0000-0000-0000-000000000001' } : { power: 'off' };
        break;
      case 'bmc.power':
        if (['cycle', 'on', 'reset'].includes(args.action)) await connect(target, 'ramdisk', `ramdisk-${command.id}`);
        break;
      case 'diag.dcgm':
        result = { passed: agents.dcgmPasses };
        break;
      case 'boot.kexec':
        // The ramdisk ends: the command never reports; the installed OS rejoins as `node`.
        state = 'expired';
        if (agents.kexecRejoins) await connect(target, 'node', `os-${command.id}`);
        break;
    }
    await db.query('UPDATE commands SET state = $2, result = $3, attested = attested AND $4 WHERE id = $1', [
      command.id,
      state,
      new TextEncoder().encode(JSON.stringify(result)),
      command.kind !== 'disk.wipe' || agents.attestWipe,
    ]);
  }
  return rows.length;
}

/** Runs agents and reconcilers until nothing moves. */
async function settle(rounds = 200): Promise<void> {
  const signal = new AbortController().signal;
  for (let i = 0; i < rounds; i++) {
    const answered = await runAgents();
    const due = [...queue.values()];
    queue.clear();
    for (const item of due) {
      if (item.kind === metalWorkKind) await reconcileMetalNode(context, item.key);
      else if (item.kind === 'workflow') await provision.reconcilers![0]!.run({ ...context, signal }, item.key);
    }
    if (answered === 0 && due.length === 0) return;
  }
}

const node = async (id: string) =>
  (
    await db.query<{ provision_state: string; failed_from: string | null; maintenance: boolean; role: string; power: string }>(
      'SELECT provision_state, failed_from, maintenance, role, power FROM nodes WHERE id = $1',
      [id],
    )
  ).rows[0]!;
async function call<M extends keyof MetalApi['metal']>(method: M, input: unknown) {
  const definition = api.metal[method] as unknown as { validate(i: unknown): unknown; handler(c: MethodContext, i: unknown): Promise<any> };
  return definition.handler(context, definition.validate(input));
}
let bmcHost = 20;
async function enrollReady(): Promise<string> {
  const enrolled = await call('enroll', {
    tenantId: 'root',
    siteId: 'site_a',
    poolId: 'pool_metal',
    bmc: { address: `https://10.0.0.${++bmcHost}`, driver: 'redfish', credentials: { username: 'admin', password: 'hunter2' } },
  });
  await settle();
  return enrolled.nodeId;
}

beforeAll(async () => {
  db = pglite();
  await db.migrate([...provisionMigrations, ...metalMigrations]);
  await db.query(`INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_a', 'root', 'shared', 'eu', 1)`);
  await db.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
     VALUES ('pool_metal', 'root', 'site_a', 'metal-host', 'H100', 'exclusive', 'bcd', '{"hardwareProfile":"gpu-redfish"}', 1)`,
  );
  await db.query(
    `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity, trust,
       generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
     VALUES ($1, 'site_a', 'root', 'site', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 0, 0, 1)`,
    [SITE_AGENT],
  );
  await connect(SITE_AGENT, 'site', 'site-boot');
  const base = { sql: db, work, events: eventLog, commands, secrets, pki, requestId: 'req_metal', iam: { rootTenantId: 'root' } };
  context = { ...base, workflows: provision.workflowEngine(base as never) } as unknown as ModuleContext & MethodContext;
  api = bareMetal.api!(context);
  await db.transaction((tx) =>
    registerImage(tx, undefined, 'root', 'root', {
      ref: 'ubuntu-24.04-server@2026.09',
      format: 'raw',
      compression: 'zstd',
      sha256: 'ab'.repeat(32),
      source: 'https://images.example.com/ubuntu.raw.zst',
    }),
  );
});
afterAll(() => db.close());
beforeEach(() => {
  Object.assign(agents, { attestWipe: true, dcgmPasses: true, kexecRejoins: true });
  seen.length = 0;
  events.length = 0;
});

describe('the metal group', () => {
  it('declares exactly the §9.2 metal rows', () => {
    const rows = apiSurface.filter((row) => row.group === 'metal');
    expect(Object.keys(api.metal).sort()).toEqual(rows.map((row) => row.method).sort());
    for (const row of rows) {
      const method = api.metal[row.method as keyof MetalApi['metal']];
      expect([method.action, method.kind, method.resource({ tenantId: 't', nodeId: 'node_x', poolId: 'pool_x' } as never)?.type]).toEqual([
        row.action,
        row.kind,
        row.resource,
      ]);
    }
  });

  it('module wiring: steps, profiles and command kinds reach the engine', () => {
    expect(bareMetal.requires).toEqual(['provision']);
    expect(provision.engineOptions.steps.get('disk.wipe')).toBeDefined();
    expect(bareMetal.commandKinds!.find((k) => k.kind === 'disk.wipe')).toMatchObject({ attested: true, destructive: true, retrySafe: false });
    expect(bareMetal.commandKinds!.find((k) => k.kind === 'boot.kexec')).toMatchObject({ selfTerminating: true });
  });

  it('inherits driver bindings from the pool hardware profile, overridable per node', () => {
    const bindings = resolveDriverBindings(hardwareProfiles, 'gpu-redfish', { driver: 'redfish', address: 'a', credentials: 'secret://x' }, { boot: 'uefi-http' });
    expect(bindings).toMatchObject({
      power: { driver: 'redfish', config: { address: 'a', credentials: 'secret://x' } },
      deploy: 'image-stream',
      boot: 'uefi-http',
    });
    expect(() => resolveDriverBindings(hardwareProfiles, 'nope', { driver: 'redfish', address: 'a' })).toThrow(/Unknown hardware profile/);
  });
});

describe('enroll → ready (§3.5)', () => {
  it('stores inline credentials as a secret, then inspects, commissions and reaches ready', async () => {
    const enrolled = await call('enroll', {
      tenantId: 'root',
      siteId: 'site_a',
      poolId: 'pool_metal',
      bmc: { address: 'https://10.0.0.10', driver: 'redfish', credentials: { username: 'admin', password: 'hunter2' } },
    });
    expect(enrolled).toMatchObject({ provisionState: 'enrolling', bmc: { driver: 'redfish', credentialsSet: true } });
    expect(JSON.stringify(enrolled)).not.toContain('hunter2');
    const row = await db.query<{ bmc_credentials: string; drivers_text: string }>(
      'SELECT m.bmc_credentials, n.drivers::text AS drivers_text FROM metal_nodes m JOIN nodes n ON n.id = m.node_id WHERE m.node_id = $1',
      [enrolled.nodeId],
    );
    expect(row.rows[0]!.bmc_credentials).toMatch(/^secret:\/\//);
    expect(row.rows[0]!.drivers_text).not.toContain('hunter2');
    expect(row.rows[0]!.drivers_text).toContain('image-stream');

    await settle();
    expect(await node(enrolled.nodeId)).toMatchObject({ provision_state: 'ready', power: 'off', maintenance: false });
    expect(seen.map((c) => c.kind)).toEqual([
      'bmc.query', // power.getPower
      'bmc.query', // inspect.oob
      'bmc.boot', // one-time PXE
      'boot.prepareRamdisk',
      'bmc.power', // cycle into the ramdisk
      'inventory.refresh',
      'diag.dcgm',
      'disk.wipe',
      'bmc.power', // off
      'boot.cleanUp',
    ]);
    // BMC work goes to the site agent; ramdisk work to the machine.
    expect(seen.filter((c) => c.kind.startsWith('bmc.')).every((c) => c.node === SITE_AGENT && c.payload.address === 'https://10.0.0.10')).toBe(true);
    expect(seen.find((c) => c.kind === 'disk.wipe')).toMatchObject({ node: enrolled.nodeId, payload: { mode: 'WIPE_MODE_QUICK' } });
    expect(seen.find((c) => c.kind === 'boot.prepareRamdisk')!.payload).toMatchObject({ mac: 'b8:ce:f6:00:00:01', arch: 'BOOT_ARCH_X86_64_EFI' });
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['node.enrolled', 'node.provision.inspecting', 'node.provision.commissioning', 'node.provision.ready']));
  });

  it('fails commissioning when diagnostics fail, and recovers through enrolling', async () => {
    agents.dcgmPasses = false;
    const id = await enrollReady();
    expect(await node(id)).toMatchObject({ provision_state: 'failed', failed_from: 'commissioning', maintenance: true });
    agents.dcgmPasses = true;
    const recovered = await call('recover', { tenantId: 'root', nodeId: id });
    expect(recovered.provisionState).toBe('enrolling');
    await settle();
    expect((await node(id)).provision_state).toBe('ready');
  });

  it('refuses a pool in another site, another tenant, or credentials that are neither a ref nor a pair', async () => {
    const bmc = { address: 'x', driver: 'redfish', credentials: 'secret://root/1' };
    await expect(call('enroll', { tenantId: 'root', siteId: 'site_b', poolId: 'pool_metal', bmc })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(call('enroll', { tenantId: 'ten_other', siteId: 'site_a', poolId: 'pool_metal', bmc })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      call('enroll', { tenantId: 'root', siteId: 'site_a', poolId: 'pool_metal', bmc: { ...bmc, credentials: 'hunter2' } }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('deploy, release, retire', () => {
  it('deploys a tenant profile: streams the catalog image, kexecs, completes on rejoin as node', async () => {
    const id = await enrollReady();
    seen.length = 0;
    const deploying = await call('deploy', { tenantId: 'root', nodeId: id, profileId: 'ubuntu-24.04-gpu-host', profileVersion: 1 });
    expect(deploying.provisionState).toBe('deploying');
    await settle();
    expect(await node(id)).toMatchObject({ provision_state: 'deployed', role: 'host' });
    expect(seen.find((c) => c.kind === 'deploy.image')!.payload).toMatchObject({
      url: 'https://images.example.com/ubuntu.raw.zst',
      sha256: Buffer.from('ab'.repeat(32), 'hex').toString('base64'),
      format: 'IMAGE_FORMAT_RAW',
      compression: 'IMAGE_COMPRESSION_ZSTD',
    });
    expect(seen.find((c) => c.kind === 'boot.kexec')!.node).toBe(id);
    // User data travels as a secret reference only; the stored document embeds a single-use token.
    const deployPayload = seen.find((c) => c.kind === 'deploy.image')!.payload;
    expect(deployPayload).toMatchObject({ userDataKind: 'cloud-init', userDataRef: expect.stringMatching(/^secret:\/\//) });
    expect(JSON.stringify(seen)).not.toContain('bcj_secret_');
    const document = stored.get(deployPayload.userDataRef as string)!;
    expect(document).toContain(`bcj_secret_${issuedTokens.length}`);
    expect(document).toContain(`--node-id, ${id}`);
    expect(issuedTokens.at(-1)).toMatchObject({ role: 'provisioned', maxUses: 1 });
    const session = await db.query<{ role: string }>('SELECT role FROM node_sessions WHERE node_id = $1', [id]);
    expect(session.rows[0]!.role).toBe('node');
  });

  it('releases with the chosen wipe, and returns to ready only after an attested wipe', async () => {
    const id = await enrollReady();
    await call('deploy', { tenantId: 'root', nodeId: id, profileId: 'ubuntu-24.04-gpu-host', profileVersion: 1 });
    await settle();
    seen.length = 0;
    agents.attestWipe = false;
    await call('undeploy', { tenantId: 'root', nodeId: id, wipe: 'secure-erase' });
    await settle();
    expect(seen.find((c) => c.kind === 'disk.wipe')!.payload).toMatchObject({ mode: 'WIPE_MODE_SECURE_ERASE' });
    expect(await node(id)).toMatchObject({ provision_state: 'failed', failed_from: 'releasing', maintenance: true });
    const view = await db.query<{ last_error: { code: string } }>('SELECT last_error FROM metal_nodes WHERE node_id = $1', [id]);
    expect(view.rows[0]!.last_error.code).toBe('UNVERIFIED_WIPE');

    agents.attestWipe = true;
    expect((await call('recover', { tenantId: 'root', nodeId: id })).provisionState).toBe('releasing');
    await settle();
    expect((await node(id)).provision_state).toBe('ready');
  });

  it('aborts a deploy: the workflow is cancelled and the node fails with maintenance on', async () => {
    const id = await enrollReady();
    agents.kexecRejoins = false;
    await call('deploy', { tenantId: 'root', nodeId: id, profileId: 'ubuntu-24.04-gpu-host', profileVersion: 1 });
    await settle(30);
    const { workflowId } = await call('abort', { tenantId: 'root', nodeId: id, reason: 'wrong image' }).then(async () =>
      (await db.query<{ id: string }>(`SELECT id FROM workflows WHERE node_id = $1 ORDER BY id DESC LIMIT 1`, [id])).rows[0]!,
    ).then((row) => ({ workflowId: row.id }));
    await settle();
    expect(await node(id)).toMatchObject({ provision_state: 'failed', failed_from: 'deploying', maintenance: true });
    const wf = await db.query<{ state: string }>('SELECT state FROM workflows WHERE id = $1', [workflowId]);
    expect(wf.rows[0]!.state).toBe('cancelled');
    // A failed deploy recovers into releasing, which wipes before ready.
    expect((await call('recover', { tenantId: 'root', nodeId: id })).provisionState).toBe('releasing');
    await settle();
    expect((await node(id)).provision_state).toBe('ready');
  });

  it('retires: erases, revokes the identity and forgets the BMC credentials', async () => {
    const id = await enrollReady();
    await db.query(
      `INSERT INTO node_certs (serial, node_id, role, identity_gen, spki_sha256, der, not_before, not_after)
       VALUES ('s-1', $1, 'node', 0, '\\x00', '\\x00', compute_now(), compute_now() + interval '1 day')`,
      [id],
    );
    seen.length = 0;
    await call('retire', { tenantId: 'root', nodeId: id });
    await settle();
    expect((await node(id)).provision_state).toBe('retired');
    expect(seen.find((c) => c.kind === 'disk.wipe')!.payload).toMatchObject({ mode: 'WIPE_MODE_CRYPTO_ERASE' });
    const row = await db.query<{ bmc_credentials: string | null; revoked: boolean; identity_gen: number }>(
      `SELECT m.bmc_credentials, (SELECT revoked_at IS NOT NULL FROM node_certs WHERE serial = 's-1') AS revoked, n.identity_gen
         FROM metal_nodes m JOIN nodes n ON n.id = m.node_id WHERE m.node_id = $1`,
      [id],
    );
    expect(row.rows[0]).toMatchObject({ bmc_credentials: null, revoked: true, identity_gen: 1 });
    await expect(call('recover', { tenantId: 'root', nodeId: id })).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});

describe('verbs', () => {
  it('rejects illegal moves with INVALID_STATE and other tenants with NOT_FOUND', async () => {
    const id = await enrollReady();
    await expect(call('undeploy', { tenantId: 'root', nodeId: id })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(call('recover', { tenantId: 'root', nodeId: id })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(call('deploy', { tenantId: 'ten_other', nodeId: id, profileId: 'x', profileVersion: 1 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('sends a power action to the site agent, but not while a workflow controls the node', async () => {
    const id = await enrollReady();
    const { commandId } = await call('power', { tenantId: 'root', nodeId: id, action: 'on' });
    const command = await db.query<{ node_id: string; kind: string }>('SELECT node_id, kind FROM commands WHERE id = $1', [commandId]);
    expect(command.rows[0]).toEqual({ node_id: SITE_AGENT, kind: 'bmc.power' });
    await call('provide', { tenantId: 'root', nodeId: id });
    await expect(call('power', { tenantId: 'root', nodeId: id, action: 'off' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(call('power', { tenantId: 'root', nodeId: id, action: 'force-off' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await settle();
  });
});

describe('payloads', () => {
  it("every command metal sent parses as its kind's payload message in proto3 JSON", async () => {
    const { rows } = await db.query<{ kind: string; body: Uint8Array }>('SELECT DISTINCT ON (kind) kind, body FROM commands ORDER BY kind, seq');
    const kinds = new Map<string, string>([
      ...metalCommandKinds.map((k) => [k.kind, k.payload.typeName] as const),
      ...Object.entries(commandKinds).map(([kind, spec]) => [kind, spec.payload.typeName] as const),
    ]);
    const checked: string[] = [];
    for (const row of rows) {
      const typeName = kinds.get(row.kind);
      expect(typeName, row.kind).toBeDefined();
      const schema = protocolRegistry.getMessage(typeName!) as DescMessage | undefined;
      expect(schema, typeName).toBeDefined();
      expect(() => fromJson(schema!, JSON.parse(new TextDecoder().decode(row.body)))).not.toThrow();
      checked.push(row.kind);
    }
    expect(checked.sort()).toEqual(
      ['bmc.boot', 'bmc.power', 'bmc.query', 'boot.cleanUp', 'boot.kexec', 'boot.prepareRamdisk', 'deploy.image', 'diag.dcgm', 'disk.wipe', 'inventory.refresh'].sort(),
    );
  });
});
