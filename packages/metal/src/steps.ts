import {
  ComputeError,
  field,
  manifest,
  type Json,
  type SqlTx,
  type StepContext,
  type StepDefinition,
} from '@better-compute/core';
import {
  awaitCommand,
  defineStep,
  renderedUserData,
  resolveImageRef,
  siteAgentFor,
  stepNotReady,
  workflowProfile,
  type CommandOutcome,
} from '@better-compute/provision';
import { isIP } from 'node:net';
import { nodeSignedResults } from './attestation.js';
import { newIdentityGeneration, tenantRootPolicy } from './tenant-root.js';
import { bmcResult, dcgmResult, deployResult, inventoryRefreshResult, wipeResult } from './results.js';
import { readMetalNode, type MetalNodeRow } from './store.js';

// Metal's workflow steps (PLAN.md §3.5, §11.3). Most are control-plane steps that build a command
// only the control plane can build (BMC address and credential ref, resolved image, ramdisk boot
// entry) and relay it with `awaitCommand` to the site agent or to the ramdisk on the machine.
// `boot.kexec` is a plain ramdisk step: it ends the ramdisk, so it completes when the installed OS
// rejoins (`await: 'rejoin'`).

/** Decides whether an attested command result is trustworthy (pki verifies `node_sig`, §13). */
export type AttestationVerifier = (tx: SqlTx, outcome: CommandOutcome, context: StepContext) => Promise<boolean>;

/**
 * FOR TESTS AND SIMULATIONS ONLY: accepts `commands.attested`, which says only that the kind must be
 * node-signed, not that it was. The default is `nodeSignedResults()` (attestation.ts), which checks
 * the stored `node_sig` with pki against `node_certs`.
 */
export const acceptIngestedAttestation: AttestationVerifier = async (_tx, outcome) => outcome.attested;

export interface MetalStepOptions {
  verifyAttestation?: AttestationVerifier;
}

function requireNode(context: StepContext): string {
  if (!context.node) throw new ComputeError('INVALID_STATE', `${context.stepId} needs a node`);
  return context.node.id;
}

async function metalNode(context: StepContext): Promise<MetalNodeRow> {
  return readMetalNode(context.sql, requireNode(context));
}

async function siteAgent(context: StepContext, nodeId: string): Promise<string> {
  const agent = await siteAgentFor(context.sql, nodeId);
  // No site agent yet: wait for one until the step times out.
  if (!agent) throw stepNotReady(5_000);
  return agent;
}

/** A BMC operation relayed to the site agent (`BmcOperationRequest`). */
async function bmc(
  context: StepContext,
  kind: 'bmc.query' | 'bmc.boot' | 'bmc.power',
  operation: string,
  args: Record<string, Json>,
  key?: string,
): Promise<Json> {
  const node = await metalNode(context);
  if (!node.bmc_credentials) throw new ComputeError('INVALID_STATE', `Node ${node.node_id} has no BMC credentials`);
  const outcome = await awaitCommand(context, {
    nodeId: await siteAgent(context, node.node_id),
    kind,
    payload: bmcOperationJson(node, operation, args),
    ...(key ? { key } : {}),
  });
  return bmcResult(outcome).result;
}

// Payloads are the proto3 JSON of each kind's message (`metalPayloads`): the runtime packs them.

/** `bettercompute.site.v1.BmcOperationRequest` as proto3 JSON. */
export function bmcOperationJson(
  node: Pick<MetalNodeRow, 'bmc_driver' | 'bmc_address' | 'bmc_credentials' | 'bmc_tls_spki_sha256'>,
  operation: string,
  args: Record<string, Json>,
): Json {
  return {
    driver: node.bmc_driver,
    address: node.bmc_address,
    credentialsRef: node.bmc_credentials ?? '',
    operation,
    argsJson: JSON.stringify(args),
    ...(node.bmc_tls_spki_sha256 ? { tlsSpkiSha256: Buffer.from(node.bmc_tls_spki_sha256, 'hex').toString('base64') } : {}),
  };
}

const bootArch = (node: Pick<MetalNodeRow, 'arch' | 'uefi'>) =>
  node.arch === 'arm64' ? 'BOOT_ARCH_ARM64_EFI' : node.uefi ? 'BOOT_ARCH_X86_64_EFI' : 'BOOT_ARCH_BIOS';

/** One `bettercompute.site.v1.ProxyDhcpEntry` per PXE MAC, as proto3 JSON. */
export function proxyDhcpEntriesJson(node: MetalNodeRow, workflowId: string, notAfter: Date): Json[] {
  return node.macs.map((mac) => ({
    mac,
    ...(node.product_uuid ? { productUuid: node.product_uuid } : {}),
    arch: bootArch(node),
    workflowId,
    notAfter: notAfter.toISOString(),
  }));
}

const wipeModeNames: Readonly<Record<string, string>> = {
  quick: 'WIPE_MODE_QUICK',
  'secure-erase': 'WIPE_MODE_SECURE_ERASE',
  'crypto-erase': 'WIPE_MODE_CRYPTO_ERASE',
};
const imageFormatNames: Readonly<Record<string, string>> = { raw: 'IMAGE_FORMAT_RAW', qcow2: 'IMAGE_FORMAT_QCOW2' };
const compressionNames: Readonly<Record<string, string>> = {
  none: 'IMAGE_COMPRESSION_NONE',
  zstd: 'IMAGE_COMPRESSION_ZSTD',
  gzip: 'IMAGE_COMPRESSION_GZIP',
};

/** Sends the boot entries (one per MAC) through the site agent. */
async function prepareBootEntries(context: StepContext, node: MetalNodeRow, keyPrefix?: string): Promise<void> {
  if (node.macs.length === 0)
    throw new ComputeError('INVALID_STATE', `Node ${node.node_id} has no known PXE MAC; inspect it out of band first`);
  const agent = await siteAgent(context, node.node_id);
  const { rows } = await context.sql.query<{ not_after: Date }>(`SELECT compute_now() + interval '2 hours' AS not_after`);
  const entries = proxyDhcpEntriesJson(node, context.workflowId, rows[0]!.not_after);
  for (const [i, entry] of entries.entries())
    await awaitCommand(context, {
      nodeId: agent,
      kind: 'boot.prepareRamdisk',
      key: `${keyPrefix ?? 'entry'}-${i}`,
      payload: entry,
    });
}

const powerActions = ['on', 'off', 'graceful-off', 'reset', 'graceful-restart', 'cycle', 'nmi'] as const;

/** Is the machine's ramdisk connected right now? */
async function ramdiskConnected(context: StepContext, nodeId: string): Promise<boolean> {
  const { rows } = await context.sql.query<{ ok: boolean }>(
    `SELECT (role = 'ramdisk' AND connected_at IS NOT NULL AND (disconnected_at IS NULL OR connected_at > disconnected_at)) AS ok
       FROM node_sessions WHERE node_id = $1`,
    [nodeId],
  );
  return rows[0]?.ok === true;
}

/** Every metal step, configured. */
export function metalSteps(options: MetalStepOptions = {}): StepDefinition[] {
  const verify = options.verifyAttestation ?? nodeSignedResults();

  const getPower = defineStep({
    id: 'power.getPower',
    runsOn: 'control-plane',
    relays: ['site'],
    timeout: '2m',
    retrySafe: true,
    input: manifest({}),
    async run(_input, context) {
      const result = (await bmc(context, 'bmc.query', 'power.getPower', {})) as Record<string, Json>;
      const power = result.power === 'on' || result.power === 'off' ? result.power : 'unknown';
      await context.sql.query('UPDATE nodes SET power = $2 WHERE id = $1', [requireNode(context), power]);
      return { power };
    },
  });

  const setPower = defineStep({
    id: 'power.setPower',
    runsOn: 'control-plane',
    relays: ['site'],
    timeout: '5m',
    retrySafe: false,
    input: manifest({ action: field.option(powerActions) }),
    async run(input, context) {
      const action = input.action;
      await bmc(context, 'bmc.power', 'power.setPower', { action });
      const power = action === 'off' || action === 'graceful-off' ? 'off' : action === 'nmi' ? null : 'on';
      if (power) await context.sql.query('UPDATE nodes SET power = $2 WHERE id = $1', [requireNode(context), power]);
      return { action };
    },
  });

  const setBootDevice = defineStep({
    id: 'management.setBootDevice',
    runsOn: 'control-plane',
    relays: ['site'],
    timeout: '2m',
    retrySafe: true,
    input: manifest({
      device: field.option(['pxe', 'http', 'disk', 'cd']),
      persistent: field.boolean().optional(),
    }),
    async run(input, context) {
      const node = await metalNode(context);
      await bmc(context, 'bmc.boot', 'management.setBootDevice', {
        device: input.device,
        persistent: input.persistent ?? false,
        uefi: node.uefi,
      });
      return { device: input.device };
    },
  });

  const inspectOob = defineStep({
    id: 'inspect.oob',
    runsOn: 'control-plane',
    relays: ['site'],
    timeout: '5m',
    retrySafe: true,
    input: manifest({}),
    async run(_input, context) {
      const result = (await bmc(context, 'bmc.query', 'inspect.inspect', {})) as Record<string, Json>;
      // Redfish reports the PXE MACs and the SMBIOS UUID; keep them for the boot entry.
      const macs = Array.isArray(result.macs) ? result.macs.filter((m): m is string => typeof m === 'string').map((m) => m.toLowerCase()) : [];
      const uuid = typeof result.productUuid === 'string' ? result.productUuid.toLowerCase() : null;
      // The machine's own IPs: the only hosts site.httpProxy may reach for it.
      const addresses = Array.isArray(result.ipAddresses)
        ? result.ipAddresses.filter((a): a is string => typeof a === 'string' && isIP(a) !== 0)
        : [];
      if (macs.length || uuid || addresses.length)
        await context.sql.query(
          `UPDATE metal_nodes SET macs = CASE WHEN cardinality($2::text[]) > 0 THEN $2::text[] ELSE macs END,
             product_uuid = COALESCE($3, product_uuid),
             addresses = CASE WHEN cardinality($4::text[]) > 0 THEN $4::text[] ELSE addresses END,
             updated_at = compute_now() WHERE node_id = $1`,
          [requireNode(context), macs, uuid, addresses],
        );
      return result;
    },
  });

  const prepareRamdisk = defineStep({
    id: 'boot.prepareRamdisk',
    runsOn: 'control-plane',
    relays: ['site'],
    timeout: '2m',
    retrySafe: true,
    input: manifest({}),
    async run(_input, context) {
      const node = await metalNode(context);
      await prepareBootEntries(context, node);
      return { entries: node.macs.length };
    },
  });

  const cleanUp = defineStep({
    id: 'boot.cleanUp',
    runsOn: 'control-plane',
    relays: ['site'],
    timeout: '2m',
    retrySafe: true,
    input: manifest({}),
    async run(_input, context) {
      const node = await metalNode(context);
      await awaitCommand(context, {
        nodeId: await siteAgent(context, node.node_id),
        kind: 'boot.cleanUp',
        payload: { nodeId: node.node_id, macs: node.macs, workflowId: context.workflowId },
      });
      return { cleaned: true };
    },
  });

  /**
   * Boots the machine into the ramdisk unless it is already there: one-time PXE, the boot entry,
   * a power cycle, then it waits for the ramdisk to join. Each command is sent once per attempt.
   */
  const ensureRamdisk = defineStep({
    id: 'metal.ensureRamdisk',
    runsOn: 'control-plane',
    timeout: '20m',
    retrySafe: true,
    input: manifest({}),
    async run(_input, context) {
      const node = await metalNode(context);
      if (await ramdiskConnected(context, node.node_id)) return { ramdisk: 'connected' };
      if (node.macs.length === 0)
        throw new ComputeError('INVALID_STATE', `Node ${node.node_id} has no known PXE MAC; inspect it out of band first`);
      await bmc(context, 'bmc.boot', 'management.setBootDevice', { device: 'pxe', persistent: false, uefi: node.uefi }, 'boot-device');
      await prepareBootEntries(context, node, 'boot-entry');
      await bmc(context, 'bmc.power', 'power.setPower', { action: 'cycle' }, 'power-cycle');
      if (!(await ramdiskConnected(context, node.node_id))) throw stepNotReady(5_000);
      return { ramdisk: 'booted' };
    },
  });

  /**
   * Mounts an ISO (an https URL, usually the site cache) through the BMC's virtual media: a fixed
   * `url`, or `fromStep`, the `url` an earlier step of the workflow returned (a per-node ISO a
   * plugin rendered, §5.6 walkthrough 1).
   */
  const mediaInsert = defineStep({
    id: 'media.insert',
    runsOn: 'control-plane',
    relays: ['site'],
    timeout: '5m',
    retrySafe: true,
    input: manifest({
      url: field.string({ pattern: '^https://', maxLength: 2048 }).optional(),
      fromStep: field.string({ maxLength: 128 }).optional(),
    }),
    async run(input, context) {
      let url = input.url;
      if (!url && input.fromStep) {
        const { rows } = await context.sql.query<{ result: { url?: unknown } | null }>(
          `SELECT result FROM workflow_steps WHERE workflow_id = $1 AND action = $2 AND state = 'succeeded'
            ORDER BY index DESC LIMIT 1`,
          [context.workflowId, input.fromStep],
        );
        const found = rows[0]?.result?.url;
        if (typeof found === 'string' && /^https:\/\/\S{1,2040}$/.test(found)) url = found;
        else throw new ComputeError('INVALID_STATE', `media.insert: step ${input.fromStep} returned no https url`);
      }
      if (!url) throw new ComputeError('INVALID_INPUT', 'media.insert needs url or fromStep');
      await bmc(context, 'bmc.boot', 'virtual-media.insert', { url });
      return { inserted: url };
    },
  });
  const mediaEject = defineStep({
    id: 'media.eject',
    runsOn: 'control-plane',
    relays: ['site'],
    timeout: '5m',
    retrySafe: true,
    input: manifest({}),
    async run(_input, context) {
      await bmc(context, 'bmc.boot', 'virtual-media.eject', {});
      return { ejected: true };
    },
  });

  const refreshInventory = defineStep({
    id: 'inventory.refresh',
    runsOn: 'control-plane',
    relays: ['ramdisk', 'node'],
    timeout: '10m',
    retrySafe: true,
    input: manifest({}),
    async run(_input, context) {
      const outcome = await awaitCommand(context, { nodeId: requireNode(context), kind: 'inventory.refresh', payload: { rescan: true } });
      return inventoryRefreshResult(outcome);
    },
  });

  const dcgm = defineStep({
    id: 'diag.dcgm',
    runsOn: 'control-plane',
    relays: ['ramdisk', 'node'],
    timeout: '1h',
    retrySafe: true,
    input: manifest({ level: field.int({ min: 1, max: 4 }).default(1) }),
    async run(input, context) {
      const outcome = await awaitCommand(context, { nodeId: requireNode(context), kind: 'diag.dcgm', payload: { level: input.level } });
      const attested = await verify(context.sql, outcome, context);
      if (!attested) throw new ComputeError('DRIVER_ERROR', 'The diagnostics result is not attested by the node');
      const result = dcgmResult(outcome);
      const failed = [...result.tests, ...result.gpus.flatMap((gpu) => gpu.checks)].filter((test) => !test.passed).map((test) => test.name);
      if (!result.passed)
        throw new ComputeError('DRIVER_ERROR', `DCGM level ${input.level} failed${failed.length ? `: ${failed.join(', ')}` : ''}`);
      return { passed: true, level: input.level, attested, checks: result.tests.length };
    },
  });

  const wipe = defineStep({
    id: 'disk.wipe',
    runsOn: 'control-plane',
    relays: ['ramdisk'],
    timeout: '6h',
    retrySafe: false,
    input: manifest({ mode: field.option(['none', 'quick', 'secure-erase', 'crypto-erase']).optional() }),
    async run(input, context): Promise<Json> {
      const node = await metalNode(context);
      const mode = input.mode ?? node.release_wipe;
      if (mode === 'none') return { mode, attested: true };
      const outcome = await awaitCommand(context, { nodeId: node.node_id, kind: 'disk.wipe', payload: { mode: wipeModeNames[mode]! } });
      // `ready` follows only a verified wipe (§11.1): the release completes only on attested: true.
      // Verified means both: the node signed the result, and every disk's read-back check passed.
      const result = wipeResult(outcome);
      const unverified = result.disks.filter((disk) => !disk.verified).map((disk) => disk.id);
      const attested = (await verify(context.sql, outcome, context)) && result.disks.length > 0 && unverified.length === 0;
      return { mode, attested, disks: result.disks.map((disk) => ({ id: disk.id, method: disk.method, verified: disk.verified })), unverified };
    },
  });

  const deploy = defineStep({
    id: 'deploy.deploy',
    runsOn: 'control-plane',
    relays: ['ramdisk'],
    timeout: '1h',
    retrySafe: false,
    input: manifest({ image: field.string({ maxLength: 200 }).optional() }),
    async run(input, context) {
      const node = await metalNode(context);
      const pinned = await workflowProfile(context.sql, context.workflowId);
      const ref = input.image ?? pinned?.profile.image?.ref;
      if (!ref) throw new ComputeError('INVALID_INPUT', 'deploy.deploy needs an image: with.image or the profile image');
      const image = await resolveImageRef(context.sql, node.tenant_id, ref);
      if (!image) throw new ComputeError('NOT_FOUND', `Image ${ref} is not in the catalog`);
      const format = imageFormatNames[pinned?.profile.image?.format ?? image.format];
      if (!format) throw new ComputeError('INVALID_INPUT', `deploy.deploy cannot write a ${image.format} image to disk`);
      // A `userdata.render` step earlier in the workflow stored the user data as a secret.
      const userData = await renderedUserData(context.sql, context.workflowId);
      if (pinned?.profile.userData && !userData)
        throw new ComputeError('INVALID_CONFIG', 'The profile has userData but no userdata.render step ran before deploy.deploy');
      const outcome = await awaitCommand(context, {
        nodeId: node.node_id,
        kind: 'deploy.image',
        payload: {
          url: image.source,
          sha256: Buffer.from(image.sha256, 'hex').toString('base64'),
          format,
          compression: compressionNames[pinned?.profile.image?.compression ?? image.compression]!,
          uefi: node.uefi,
          ...(userData ? { userDataRef: userData.userDataRef, userDataKind: userData.kind } : {}),
        },
        timeoutMs: 60 * 60_000,
      });
      const written = deployResult(outcome);
      const streamed = Buffer.from(written.sha256).toString('hex');
      if (streamed && streamed !== image.sha256)
        throw new ComputeError('DRIVER_ERROR', `The ramdisk wrote an image with sha256 ${streamed}, not ${image.sha256}`);
      return { imageId: image.id, sha256: image.sha256, rootDisk: written.rootDisk, writtenBytes: Number(written.writtenBytes) };
    },
  });

  const kexec = defineStep({
    id: 'boot.kexec',
    runsOn: 'ramdisk',
    command: 'boot.kexec',
    await: 'rejoin',
    timeout: '15m',
    retrySafe: false,
    input: manifest({}),
  });

  /** Retirement: the node's certificates are revoked and its BMC credentials forgotten. */
  const revokeIdentity = defineStep({
    id: 'metal.revokeIdentity',
    runsOn: 'control-plane',
    timeout: '1m',
    retrySafe: true,
    input: manifest({}),
    async run(_input, context) {
      const nodeId = requireNode(context);
      return context.sql.transaction(async (tx) => {
        const revoked = await tx.query(
          `UPDATE node_certs SET revoked_at = compute_now(), revocation_reason = 'retired'
            WHERE node_id = $1 AND revoked_at IS NULL`,
          [nodeId],
        );
        await tx.query('UPDATE nodes SET identity_gen = identity_gen + 1, drivers = $2::jsonb WHERE id = $1', [nodeId, '{}']);
        await tx.query('UPDATE metal_nodes SET bmc_credentials = NULL, updated_at = compute_now() WHERE node_id = $1', [nodeId]);
        // A retired machine may join again as a new node: its hardware subjects are free (core/0012).
        const unbound = await tx.query('DELETE FROM node_bindings WHERE node_id = $1', [nodeId]);
        return { revokedCertificates: revoked.rowCount, unboundSubjects: unbound.rowCount };
      });
    },
  });

  // Tenant-root teardown (§13). The tenant's identity goes first: once its node-tenant certificates
  // are revoked, nothing the tenant left behind can sign a result for this node.
  const fenceTenant = defineStep({
    id: 'metal.fenceTenant',
    runsOn: 'control-plane',
    timeout: '1m',
    retrySafe: true,
    input: manifest({}),
    async run(_input, context) {
      const nodeId = requireNode(context);
      return context.sql.transaction(async (tx) => ({ revokedCertificates: await newIdentityGeneration(tx, nodeId, 'tenant-root-ended') }));
    },
  });

  /** Every component of the pool's firmware baseline must report exactly that version (§13 step 5). */
  const firmwareCheck = defineStep({
    id: 'metal.firmwareCheck',
    runsOn: 'control-plane',
    relays: ['site'],
    timeout: '5m',
    retrySafe: true,
    input: manifest({}),
    async run(_input, context) {
      const node = await metalNode(context);
      const { firmwareBaseline } = tenantRootPolicy(node.pool_policy);
      if (!firmwareBaseline || Object.keys(firmwareBaseline).length === 0)
        throw new ComputeError('INVALID_CONFIG', `Pool ${node.pool_id} has no policy.firmwareBaseline to verify against`);
      const result = (await bmc(context, 'bmc.query', 'firmware.components', {})) as Record<string, Json>;
      const reported = new Map<string, string>();
      for (const component of Array.isArray(result.components) ? result.components : [])
        if (component && typeof component === 'object' && !Array.isArray(component)) {
          const { id, version } = component as Record<string, Json>;
          if (typeof id === 'string' && typeof version === 'string') reported.set(id, version);
        }
      const drift = Object.entries(firmwareBaseline)
        .filter(([id, version]) => reported.get(id) !== version)
        .map(([id, expected]) => ({ component: id, expected, found: reported.get(id) ?? null }));
      // Drift quarantines the machine: the workflow fails, and the node fails with maintenance on.
      if (drift.length)
        throw new ComputeError('DRIVER_ERROR', `Firmware differs from the pool baseline: ${drift.map((d) => d.component).join(', ')}`, undefined, {
          code: 'FIRMWARE_DRIFT',
          drift,
        });
      return { verified: Object.keys(firmwareBaseline).length };
    },
  });

  /** The lease is over: a new identity generation, platform trust, no lease. */
  const exitTenantRoot = defineStep({
    id: 'metal.exitTenantRoot',
    runsOn: 'control-plane',
    timeout: '1m',
    retrySafe: true,
    input: manifest({}),
    async run(_input, context) {
      const nodeId = requireNode(context);
      return context.sql.transaction(async (tx) => {
        const revoked = await newIdentityGeneration(tx, nodeId, 'tenant-root-exit');
        await tx.query(`UPDATE nodes SET trust = 'platform' WHERE id = $1`, [nodeId]);
        await tx.query(
          'UPDATE metal_nodes SET tenant_root = false, lease_allocation_id = NULL, updated_at = compute_now(), version = version + 1 WHERE node_id = $1',
          [nodeId],
        );
        return { revokedCertificates: revoked, trust: 'platform' };
      });
    },
  });

  return [
    getPower,
    setPower,
    setBootDevice,
    inspectOob,
    mediaInsert,
    mediaEject,
    prepareRamdisk,
    cleanUp,
    ensureRamdisk,
    refreshInventory,
    dcgm,
    wipe,
    deploy,
    kexec,
    revokeIdentity,
    fenceTenant,
    firmwareCheck,
    exitTenantRoot,
  ];
}
