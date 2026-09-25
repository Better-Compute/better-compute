import { createHash, type KeyObject } from 'node:crypto';
import { create, toBinary } from '@bufbuild/protobuf';
import type {
  CommandQueue,
  ComputeModule,
  EventPublisher,
  MethodContext,
  Migration,
  ModuleContext,
  ProfileDocument,
  Reconciler,
  SqlExecutor,
  StepDefinition,
  WorkQueue,
} from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import {
  CommandState,
  DiagDcgmResultSchema,
  InventoryRefreshResultSchema,
  WipeResultSchema,
  site,
} from '@better-compute/protocol';
import { provisionMigrations, provisionModule } from '@better-compute/provision';
import {
  metal,
  metalCommandKinds,
  metalMigrations,
  metalWorkKind,
  reconcileMetalNode,
  type HardwareProfile,
  type MetalApi,
} from '@better-compute/metal';
import {
  createCsr,
  createNodeCa,
  generateP256KeyPair,
  nodeSpiffeId,
  signCommandUpdate,
  spkiSha256,
} from '@better-compute/pki';

// A simulated metal site for walkthrough and chaos tests: PGlite, the real provision engine and
// metal module, a site agent, and per-machine BMC state. Booting from PXE brings up the ramdisk;
// booting from a CD whose ISO the `install` hook accepts brings up the installed OS (role node).
// Command results are the kinds' binary result messages, as real agents send them.

export interface SimMachine {
  bootDevice: string;
  mounted: string;
  power: 'on' | 'off';
  /** What the BMC reports for firmware.components. */
  firmware: Record<string, string>;
  /** The BMC account password once rotated; before that any credential is accepted. */
  bmcPassword?: string;
  /** BIOS attributes in effect, and those set to apply on the next boot. */
  bios: Record<string, string>;
  pendingBios: Record<string, string>;
  /** The RAID volumes' levels, as the storage controller reports them. */
  raid: string[];
}

/** The firmware every simulated machine ships with. */
export const simFirmware = Object.freeze({ bmc: '1.12.0', bios: '2.4.1', 'gpu-vbios': '96.00.5f' });

export interface MetalSimOptions {
  modules?: readonly Pick<ComputeModule, 'extensions' | 'profiles'>[];
  steps?: readonly StepDefinition[];
  profiles?: readonly ProfileDocument[];
  /** Called when a machine boots from its CD: return a boot id to join as `node`, or undefined. */
  install?: (nodeId: string, machine: SimMachine) => string | undefined;
  /** More module migrations (another module running next to metal, e.g. capacity). */
  migrations?: readonly Migration[];
  /** Their reconcilers: `settle()` runs queued work of these kinds too. */
  reconcilers?: readonly Reconciler[];
  /** metal()'s hardware profiles (BIOS settings, RAID layouts). */
  hardwareProfiles?: Record<string, HardwareProfile>;
}

/** A stable, locally unique PXE MAC per machine. */
const macOf = (nodeId: string) => {
  const h = createHash('sha256').update(nodeId).digest('hex');
  return `52:54:00:${h.slice(0, 2)}:${h.slice(2, 4)}:${h.slice(4, 6)}`;
};
const attested = new Set(metalCommandKinds.filter((k) => k.attested).map((k) => k.kind));
const idChars = '0123456789abcdefghjkmnpqrstvwxyz';
/** A valid `node_…` id from a number. */
export const simNodeId = (n: number) =>
  `node_${[...n.toString(32).padStart(26, '0')].map((c) => idChars[parseInt(c, 32)]).join('')}`;

export async function createMetalSim(options: MetalSimOptions = {}) {
  const db: SqlExecutor = pglite();
  // metal's default verifier: the stored node_sig, checked by pki against node_certs.
  const bareMetal = metal(options.hardwareProfiles ? { hardwareProfiles: options.hardwareProfiles } : {});
  const provision = provisionModule({
    modules: [bareMetal, ...(options.modules ?? [])],
    steps: [...(options.steps ?? [])],
    profiles: [...(options.profiles ?? [])],
  });
  await db.migrate([...provisionMigrations, ...metalMigrations, ...(options.migrations ?? [])]);
  await db.query(`INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_a', 'root', 'shared', 'eu', 1), ('site_b', 'root', 'shared', 'eu', 1)`);
  await db.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, sharing, agent, policy, version)
     VALUES ('pool_metal', 'root', 'site_a', 'metal-host', 'exclusive', 'bcd', '{}', 1)`,
  );

  const queue = new Map<string, { kind: string; key: string }>();
  const work: WorkQueue = {
    async enqueue(_tx, kind, key) {
      queue.set(`${kind}:${key}`, { kind, key });
    },
  };
  const events: { type: string; subject: string; data: Record<string, unknown> }[] = [];
  const eventLog: EventPublisher = {
    async publish(_tx, event) {
      events.push({ type: event.type, subject: event.subject, data: event.data as Record<string, unknown> });
    },
  };
  let seq = 0;
  const commands: CommandQueue = {
    async enqueue(tx, command) {
      const existing = await tx.query<{ id: string }>('SELECT id FROM commands WHERE node_id = $1 AND idempotency_key = $2', [
        command.nodeId,
        command.idempotencyKey,
      ]);
      if (existing.rows[0]) return { id: existing.rows[0].id, seq: 0 };
      const id = `cmd_sim_${++seq}`;
      await tx.query(
        `INSERT INTO commands (id, node_id, seq, kind, body, state, not_after, retry_safe, self_terminating, attested, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, 'pending', to_timestamp($6 / 1000.0), false, false, $7, $8)`,
        [id, command.nodeId, seq, command.kind, new TextEncoder().encode(JSON.stringify(command.payload)), command.notAfter, attested.has(command.kind), command.idempotencyKey],
      );
      return { id, seq };
    },
    async cancel(tx, id) {
      await tx.query(`UPDATE commands SET state = 'cancelled' WHERE id = $1 AND state IN ('pending', 'dispatched', 'acked', 'running')`, [id]);
    },
  };
  const tokens: string[] = [];
  /** Every join token request (role, site, pool, ttl, uses, expect), in order. */
  const tokenRequests: Record<string, unknown>[] = [];
  const pki = {
    async issueJoinToken(_tx: unknown, input: { role: string }) {
      tokenRequests.push({ ...input });
      const token = `bcj_${input.role}_${tokens.length + 1}`;
      tokens.push(token);
      return { id: `jt_${tokens.length}`, token };
    },
  };
  const secretsStore = new Map<string, string>();
  // Refs are never reused, even after deletes (a reused ref would overwrite a live secret).
  let secretSeq = 0;
  const secrets = {
    async put(tenantId: string, value: string) {
      const ref = `secret://${tenantId}/${++secretSeq}` as const;
      secretsStore.set(ref, value);
      return ref;
    },
    async resolve(ref: string) {
      return secretsStore.get(ref) ?? '';
    },
    async delete(ref: string) {
      secretsStore.delete(ref);
    },
  };
  // What other modules' reconcilers and methods also reach for (capacity: clock, authz, desired).
  const ports = {
    clock: { now: () => Date.now() },
    authz: { async upsert() {}, async remove() {}, async setPending() {} },
    desired: { async invalidate() {} },
  };
  const base = { sql: db, work, events: eventLog, commands, pki, secrets, requestId: 'req_sim', iam: { rootTenantId: 'root' }, ...ports };
  const context = { ...base, workflows: provision.workflowEngine(base as never) } as unknown as ModuleContext & MethodContext;
  const api: MetalApi = bareMetal.api!(context);

  const machines = new Map<string, SimMachine>();
  const seen: { id: string; kind: string; node: string; payload: Record<string, any>; args: Record<string, any> }[] = [];
  /** Switches for failure injection. */
  const faults = {
    /** false: the ramdisk sends its wipe result unsigned. */
    attestWipe: true,
    siteAgentDown: false,
    dropNextResults: 0,
    /** The daemon's wipe reports a disk it could not verify; with `forgeWipe` the gateway rewrites it as verified. */
    failWipeReadBack: false,
    forgeWipe: false,
    /** Results are signed by another machine's key (a stolen or confused identity). */
    foreignSigner: false,
    /** Results are signed with this key instead of the ramdisk's (e.g. a lessee's node-tenant key). */
    signWith: undefined as KeyObject | undefined,
    /** BMC rotation: the BMC refuses the new password; or takes it but the login with it fails; or the site agent does not sign. */
    rotateRejected: false,
    rotateLoginFails: false,
    rotateUnsigned: false,
    /** A firmware flash reports success but the component keeps its old version. */
    flashFails: false,
    /** The BIOS drops pending settings at boot. */
    biosIgnored: false,
  };
  // Node keys and certificates from a node CA, as JoinService issues them: every ramdisk boot joins
  // with a fresh key (role ramdisk), so revoking an identity generation never outlives a reboot.
  const nodeCa = createNodeCa({});
  const nodeKeys = new Map<string, KeyObject>();
  async function issueNodeCert(nodeId: string, role: 'ramdisk' | 'node' | 'node-tenant' | 'site'): Promise<KeyObject> {
    const key = generateP256KeyPair().privateKey;
    const issued = await nodeCa.sign(createCsr(key), {
      usage: 'client',
      role,
      ttlSeconds: 3600,
      uriSans: [nodeSpiffeId({ trustDomain: 'compute.test', siteId: 'site_a', nodeId })],
    });
    await db.query(
      `INSERT INTO node_certs (serial, node_id, role, identity_gen, spki_sha256, der, not_before, not_after)
       VALUES ($1, $2, $3, (SELECT identity_gen FROM nodes WHERE id = $2), $4, $5, $6, $7)`,
      [issued.serial, nodeId, role, spkiSha256(key), issued.certificate, new Date(issued.notBefore), new Date(issued.notAfter)],
    );
    if (role !== 'node-tenant') nodeKeys.set(nodeId, key);
    return key;
  }
  async function nodeKey(nodeId: string): Promise<KeyObject> {
    return nodeKeys.get(nodeId) ?? issueNodeCert(nodeId, 'ramdisk');
  }
  const outsider = generateP256KeyPair().privateKey;
  let sessionEpoch = 0;

  async function connect(nodeId: string, role: string, bootId: string) {
    if (role === 'ramdisk') await issueNodeCert(nodeId, 'ramdisk');
    await db.query(
      `INSERT INTO node_sessions (node_id, session_epoch, boot_id, role, connected_at) VALUES ($1, $4, $2, $3, compute_now())
       ON CONFLICT (node_id) DO UPDATE SET boot_id = EXCLUDED.boot_id, role = EXCLUDED.role, connected_at = compute_now(),
         disconnected_at = NULL, session_epoch = EXCLUDED.session_epoch`,
      [nodeId, bootId, role, ++sessionEpoch],
    );
  }
  async function disconnect(nodeId: string) {
    await db.query(`UPDATE node_sessions SET disconnected_at = compute_now() + interval '1 millisecond' WHERE node_id = $1`, [nodeId]);
  }

  /** Adds a site agent node (connected) for a site. */
  async function addSiteAgent(id: string, siteId = 'site_a') {
    await db.query(
      `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity, trust,
         generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       VALUES ($1, $2, 'root', 'site', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 0, 0, 1)`,
      [id, siteId],
    );
    await connect(id, 'site', `site-${id}`);
    await issueNodeCert(id, 'site');
  }

  function machineOf(nodeId: string): SimMachine {
    let m = machines.get(nodeId);
    if (!m) machines.set(nodeId, (m = { bootDevice: 'disk', mounted: '', power: 'off', firmware: { ...simFirmware }, bios: { BootMode: 'Legacy', SriovGlobalEnable: 'Disabled' }, pendingBios: {}, raid: [] }));
    return m;
  }
  const bmcResult = (value: unknown) =>
    toBinary(site.BmcOperationResultSchema, create(site.BmcOperationResultSchema, { ok: true, resultJson: JSON.stringify(value) }));

  /** Answers pending commands; the site agent's commands wait while it is down. */
  async function runAgents(): Promise<number> {
    const { rows } = await db.query<{ id: string; node_id: string; kind: string; body: Uint8Array }>(
      `SELECT c.id, c.node_id, c.kind, c.body FROM commands c JOIN nodes n ON n.id = c.node_id
        WHERE c.state = 'pending' ORDER BY c.seq`,
    );
    let answered = 0;
    for (const command of rows) {
      const agentIsSite = command.kind.startsWith('bmc.') || command.kind.startsWith('boot.prepare') || command.kind === 'boot.cleanUp';
      if (agentIsSite && faults.siteAgentDown) continue;
      const payload = JSON.parse(new TextDecoder().decode(command.body)) as Record<string, any>;
      const args = typeof payload.argsJson === 'string' ? (JSON.parse(payload.argsJson) as Record<string, any>) : {};
      seen.push({ id: command.id, kind: command.kind, node: command.node_id, payload, args });
      const byBmc = payload.address
        ? (await db.query<{ node_id: string }>('SELECT node_id FROM metal_nodes WHERE bmc_address = $1', [payload.address])).rows[0]?.node_id
        : undefined;
      const target = byBmc ?? payload.nodeId ?? command.node_id;
      let result = new Uint8Array();
      // A BMC whose password was rotated accepts only that password (the ref the site agent resolves).
      const bmcAuthFails =
        command.kind.startsWith('bmc.') && machineOf(target).bmcPassword !== undefined && secretsStore.get(payload.credentialsRef) !== machineOf(target).bmcPassword;
      if (bmcAuthFails) command.kind = 'bmc.denied';
      switch (command.kind) {
        case 'bmc.denied':
          result = toBinary(site.BmcOperationResultSchema, create(site.BmcOperationResultSchema, { ok: false, errorCode: 'auth', message: 'authentication failed' }));
          break;
        case 'bmc.storage': {
          machineOf(target).raid = (args.volumes as { level: string }[]).map((volume) => volume.level);
          result = bmcResult({});
          break;
        }
        case 'bmc.firmware': {
          // The site agent writes the image; a bad flash leaves the old version in place.
          if (!faults.flashFails) machineOf(target).firmware[args.component] = args.version;
          result = bmcResult({ flashed: !faults.flashFails });
          break;
        }
        case 'bmc.rotate': {
          const m = machineOf(target);
          if (faults.rotateRejected) {
            result = toBinary(site.BmcOperationResultSchema, create(site.BmcOperationResultSchema, { ok: false, errorCode: 'policy', message: 'password rejected by the BMC' }));
            break;
          }
          // The site agent fetches the new value (SecretRequest → JWE), applies it, then logs in with it.
          const next = secretsStore.get(args.newCredentialRef);
          if (next) m.bmcPassword = next;
          result = bmcResult({ verified: Boolean(next) && !faults.rotateLoginFails });
          break;
        }
        case 'bmc.query':
          result = bmcResult(
            payload.operation === 'inspect.inspect'
              ? { macs: [macOf(target)] }
              : payload.operation === 'firmware.components'
                ? { components: Object.entries(machineOf(target).firmware).map(([id, version]) => ({ id, version })) }
                : payload.operation === 'bios.getSettings'
                  ? { settings: machineOf(target).bios }
                  : payload.operation === 'raid.getLayout'
                    ? { volumes: machineOf(target).raid.map((level) => ({ level })) }
                    : { power: machineOf(target).power },
          );
          break;
        case 'bmc.boot': {
          const m = machineOf(target);
          if (payload.operation === 'management.setBootDevice') m.bootDevice = args.device;
          if (payload.operation === 'virtual-media.insert') m.mounted = args.url;
          if (payload.operation === 'virtual-media.eject') m.mounted = '';
          if (payload.operation === 'bios.applySettings') Object.assign(m.pendingBios, args.settings);
          result = bmcResult({});
          break;
        }
        case 'bmc.power': {
          const m = machineOf(target);
          result = bmcResult({});
          if (args.action === 'off' || args.action === 'graceful-off') {
            m.power = 'off';
            await disconnect(target);
          } else if (['cycle', 'on', 'reset'].includes(args.action)) {
            m.power = 'on';
            // Pending BIOS settings take effect on this boot (unless the firmware ignores them).
            if (!faults.biosIgnored) Object.assign(m.bios, m.pendingBios);
            m.pendingBios = {};
            if (m.bootDevice === 'pxe') await connect(target, 'ramdisk', `ramdisk-${command.id}`);
            else if (m.bootDevice === 'cd') {
              const boot = options.install?.(target, m);
              if (boot) await connect(target, 'node', boot);
            }
          }
          break;
        }
        case 'diag.dcgm':
          result = toBinary(DiagDcgmResultSchema, create(DiagDcgmResultSchema, { passed: true, level: payload.level }));
          break;
        case 'disk.wipe':
          result = toBinary(
            WipeResultSchema,
            create(WipeResultSchema, { disks: [{ id: 'wwn-0x5000', method: 'nvme-format', verified: !faults.failWipeReadBack }] }),
          );
          break;
        case 'inventory.refresh':
          result = toBinary(InventoryRefreshResultSchema, create(InventoryRefreshResultSchema, {}));
          break;
      }
      if (faults.dropNextResults > 0) {
        // The command ran but its result was lost (a worker or gateway died); it stays dispatched.
        faults.dropNextResults--;
        await db.query(`UPDATE commands SET state = 'dispatched' WHERE id = $1`, [command.id]);
        continue;
      }
      // The node signs attested results (`CommandUpdate.node_sig`); the gateway stores what it relays.
      let signature: { kid: string; sig: Uint8Array } | undefined;
      if (attested.has(command.kind) && (command.kind !== 'disk.wipe' || faults.attestWipe) && !(command.kind === 'bmc.rotate' && faults.rotateUnsigned)) {
        const key = faults.signWith ?? (faults.foreignSigner ? outsider : await nodeKey(command.node_id));
        signature = signCommandUpdate(key, { commandId: command.id, state: CommandState.SUCCEEDED, result });
      }
      if (command.kind === 'disk.wipe' && faults.forgeWipe)
        result = toBinary(WipeResultSchema, create(WipeResultSchema, { disks: [{ id: 'wwn-0x5000', method: 'nvme-format', verified: true }] }));
      await db.query('UPDATE commands SET state = $2, result = $3, result_sig_kid = $4, result_sig = $5 WHERE id = $1', [
        command.id,
        'succeeded',
        result,
        signature?.kid ?? null,
        signature?.sig ?? null,
      ]);
      answered++;
    }
    return answered;
  }

  /** Runs agents and reconcilers until nothing moves (at most `rounds`). */
  async function settle(rounds = 300): Promise<void> {
    const signal = new AbortController().signal;
    for (let i = 0; i < rounds; i++) {
      const answered = await runAgents();
      const due = [...queue.values()];
      queue.clear();
      for (const item of due) {
        if (item.kind === metalWorkKind) await reconcileMetalNode(context, item.key);
        else if (item.kind === 'workflow') await provision.reconcilers![0]!.run({ ...context, signal } as never, item.key);
        else await options.reconcilers?.find((reconciler) => reconciler.name === item.kind)?.run({ ...context, signal } as never, item.key);
      }
      if (answered === 0 && due.length === 0) return;
    }
  }

  async function call<M extends keyof MetalApi['metal']>(method: M, input: unknown): Promise<any> {
    const definition = api.metal[method] as unknown as { validate(i: unknown): unknown; handler(c: MethodContext, i: unknown): Promise<any> };
    return definition.handler(context, definition.validate(input));
  }
  const state = async (id: string) =>
    (
      await db.query<{ provision_state: string; failed_from: string | null; role: string; maintenance: boolean }>(
        'SELECT provision_state, failed_from, role, maintenance FROM nodes WHERE id = $1',
        [id],
      )
    ).rows[0]!;

  return { db, context, api, provision, bareMetal, queue, events, seen, faults, tokens, tokenRequests, secretsStore, machines, machineOf, issueNodeCert, connect, disconnect, addSiteAgent, runAgents, settle, call, state, close: () => db.close() };
}
export type MetalSim = Awaited<ReturnType<typeof createMetalSim>>;
