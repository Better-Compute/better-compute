import {
  ComputeError,
  field,
  manifest,
  type Json,
  type SecretRef,
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
  stepCommandKey,
  stepNotReady,
  verifyImageForUse,
  workflowProfile,
  type CommandOutcome,
  type ImageUseOptions,
} from '@better-compute/provision';
import { isIP } from 'node:net';
import { nodeSignedResults, pkiNodeSignatureCheck } from './attestation.js';
import {
  addPendingCredential,
  failCredential,
  generateBmcPassword,
  markPurged,
  pendingCredential,
  promoteCredential,
  purgeableCredentials,
} from './bmc-rotation.js';
import { newIdentityGeneration, tenantRootPolicy } from './tenant-root.js';
import { bmcResult, dcgmResult, deployResult, inventoryRefreshResult, wipeResult } from './results.js';
import type { HardwareProfile } from './module-types.js';
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
  /** Verifies site-agent-signed results (`bmc.rotate`); default: pki, role `site`. */
  verifySiteAttestation?: AttestationVerifier;
  /** The hardware profiles nodes name (`metal_nodes.hardware_profile`): BIOS settings, RAID layout. */
  hardwareProfiles?: Readonly<Record<string, HardwareProfile>>;
  /**
   * Image signatures are re-verified before `deploy.deploy` writes an image (§11.5): the verifier of
   * `provisionModule({ imageVerifier })`, default the signer allowlist. `allowUnsigned` is for
   * development only.
   */
  images?: ImageUseOptions;
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
  kind: 'bmc.query' | 'bmc.boot' | 'bmc.power' | 'bmc.firmware' | 'bmc.storage',
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

/** How long a ramdisk's discovery token is good for: the boot it was minted for, no more. */
export const discoveryTokenTtlSeconds = 900;

/**
 * Sends the boot entries (one per MAC) through the site agent. Each carries a single-use `discovery`
 * join token for the ramdisk, bound to that MAC (`expect`). It travels only as a secret ref: the
 * site agent fetches the bearer with a SecretRequest for this workflow step and renders it into that
 * MAC's iPXE script, so no command body ever holds it. A token is minted only when its entry's
 * command is first sent, not on every poll of the step. boot.cleanUp deletes the refs.
 */
async function prepareBootEntries(context: StepContext, node: MetalNodeRow, keyPrefix?: string): Promise<void> {
  if (node.macs.length === 0)
    throw new ComputeError('INVALID_STATE', `Node ${node.node_id} has no known PXE MAC; inspect it out of band first`);
  const agent = await siteAgent(context, node.node_id);
  const { rows } = await context.sql.query<{ not_after: Date }>(`SELECT compute_now() + interval '2 hours' AS not_after`);
  const entries = proxyDhcpEntriesJson(node, context.workflowId, rows[0]!.not_after);
  for (const [i, entry] of entries.entries()) {
    const key = `${keyPrefix ?? 'entry'}-${i}`;
    const sent = await context.sql.query('SELECT 1 FROM commands WHERE node_id = $1 AND idempotency_key = $2', [agent, stepCommandKey(context, key)]);
    let payload = entry;
    if (!sent.rowCount && context.pki && context.secrets) {
      const mac = node.macs[i]!;
      const { token } = await context.sql.transaction((tx) =>
        context.pki!.issueJoinToken(tx, {
          tenantId: node.tenant_id,
          role: 'discovery',
          siteId: node.site_id,
          ...(node.pool_id ? { poolId: node.pool_id } : {}),
          ttlSeconds: discoveryTokenTtlSeconds,
          maxUses: 1,
          expect: { mac },
        }),
      );
      const ref = await context.secrets.put(node.tenant_id, token);
      payload = { ...(entry as Record<string, Json>), discoveryTokenRef: ref };
    }
    await awaitCommand(context, { nodeId: agent, kind: 'boot.prepareRamdisk', key, payload });
  }
}

/**
 * The discovery token refs this workflow's boot entries carried. Refs are not secrets, and they appear
 * verbatim in the stored command body, whether it is a protobuf CommandBody or proto3 JSON.
 */
async function discoveryTokenRefs(context: StepContext): Promise<string[]> {
  const { rows } = await context.sql.query<{ body: Uint8Array }>(
    `SELECT body FROM commands WHERE kind = 'boot.prepareRamdisk' AND idempotency_key LIKE $1`,
    [`wf:${context.workflowId}:%`],
  );
  const refs = new Set<string>();
  for (const row of rows)
    for (const match of Buffer.from(row.body).toString('latin1').matchAll(/secret:\/\/[A-Za-z0-9._:-]{1,128}\/[A-Za-z0-9._-]{1,128}/g))
      refs.add(match[0]);
  return [...refs];
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
  const verifySite = options.verifySiteAttestation ?? nodeSignedResults(pkiNodeSignatureCheck({ roles: ['site'] }));

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
      // The entries are gone, and so are their discovery tokens (single-use and short-lived anyway).
      const refs = context.secrets?.delete ? await discoveryTokenRefs(context) : [];
      for (const ref of refs) await context.secrets!.delete!(ref as SecretRef);
      return { cleaned: true, discoveryTokensDeleted: refs.length };
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
      const resolved = await resolveImageRef(context.sql, node.tenant_id, ref);
      if (!resolved) throw new ComputeError('NOT_FOUND', `Image ${ref} is not in the catalog`);
      // Unsigned images, and images whose signer was revoked since, are never written (v0.2 exit).
      const image = await verifyImageForUse(context.sql, resolved, options.images);
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
      const policy = tenantRootPolicy(node.pool_policy);
      const baseline = policy.firmwareBaseline;
      if (!baseline || Object.keys(baseline).length === 0)
        throw new ComputeError('INVALID_CONFIG', `Pool ${node.pool_id} has no policy.firmwareBaseline to verify against`);
      const driftOf = async (key?: string) => {
        const result = (await bmc(context, 'bmc.query', 'firmware.components', {}, key)) as Record<string, Json>;
        const reported = new Map<string, string>();
        for (const component of Array.isArray(result.components) ? result.components : [])
          if (component && typeof component === 'object' && !Array.isArray(component)) {
            const { id, version } = component as Record<string, Json>;
            if (typeof id === 'string' && typeof version === 'string') reported.set(id, version);
          }
        return Object.entries(baseline)
          .filter(([id, version]) => reported.get(id) !== version)
          .map(([id, expected]) => ({ component: id, expected, found: reported.get(id) ?? null }));
      };
      const quarantine = (drift: { component: string }[], reflashed: string[]) =>
        new ComputeError('DRIVER_ERROR', `Firmware differs from the pool baseline: ${drift.map((d) => d.component).join(', ')}`, undefined, {
          code: 'FIRMWARE_DRIFT',
          drift,
          reflashed,
        });
      let drift = await driftOf();
      if (!drift.length) return { verified: Object.keys(baseline).length, reflashed: [] };
      // Drift quarantines the machine (the workflow fails; the node fails with maintenance on), unless
      // the pool reflashes: every drifted component needs a baseline image, then everything is checked
      // again, and anything still off quarantines after all.
      if (policy.firmwareRemediation !== 'reflash' || drift.some((d) => !policy.firmwareImages[d.component])) throw quarantine(drift, []);
      const reflashed: string[] = [];
      for (const { component, expected } of drift) {
        const image = policy.firmwareImages[component]!;
        await bmc(context, 'bmc.firmware', 'firmware.update', { component, url: image.url, sha256: image.sha256, version: expected }, `flash-${component}`);
        reflashed.push(component);
      }
      drift = await driftOf('recheck');
      if (drift.length) throw quarantine(drift, reflashed);
      return { verified: Object.keys(baseline).length, reflashed };
    },
  });

  // BIOS and RAID from the node's hardware profile (§3.5 commissioning, v0.5 drafts). A profile
  // without them makes these steps no-ops that send nothing.
  const profileOf = (node: MetalNodeRow): HardwareProfile | undefined =>
    node.hardware_profile ? options.hardwareProfiles?.[node.hardware_profile] : undefined;
  const settingsOf = (result: Json): Record<string, string> => {
    const settings = (result as Record<string, Json>)?.settings;
    return settings && typeof settings === 'object' && !Array.isArray(settings)
      ? Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, String(value)]))
      : {};
  };

  /** Sets the BIOS attributes that differ from the profile; they take effect on the next boot. */
  const biosApply = defineStep({
    id: 'bios.apply',
    runsOn: 'control-plane',
    relays: ['site'],
    timeout: '5m',
    retrySafe: true,
    input: manifest({}),
    async run(_input, context): Promise<Json> {
      const want = profileOf(await metalNode(context))?.bios;
      if (!want || Object.keys(want).length === 0) return { skipped: true };
      const current = settingsOf(await bmc(context, 'bmc.query', 'bios.getSettings', {}, 'read'));
      const changes = Object.fromEntries(Object.entries(want).filter(([key, value]) => current[key] !== value));
      if (Object.keys(changes).length === 0) return { changed: [] };
      await bmc(context, 'bmc.boot', 'bios.applySettings', { settings: changes }, 'apply');
      // Settings apply on the next boot: power off, so the next ramdisk boot (ensureRamdisk) is a real
      // one rather than the ramdisk inspection left running.
      await bmc(context, 'bmc.power', 'power.setPower', { action: 'off' }, 'power-off');
      await context.sql.query(`UPDATE nodes SET power = 'off' WHERE id = $1`, [requireNode(context)]);
      return { changed: Object.keys(changes).sort(), pendingReboot: true };
    },
  });

  /** After a boot: every profile setting must read back exactly, or the machine is not commissioned. */
  const biosVerify = defineStep({
    id: 'bios.verify',
    runsOn: 'control-plane',
    relays: ['site'],
    timeout: '5m',
    retrySafe: true,
    input: manifest({}),
    async run(_input, context): Promise<Json> {
      const want = profileOf(await metalNode(context))?.bios;
      if (!want || Object.keys(want).length === 0) return { skipped: true };
      const current = settingsOf(await bmc(context, 'bmc.query', 'bios.getSettings', {}));
      const drift = Object.entries(want)
        .filter(([key, value]) => current[key] !== value)
        .map(([setting, expected]) => ({ setting, expected, found: current[setting] ?? null }));
      if (drift.length)
        throw new ComputeError('DRIVER_ERROR', `BIOS settings did not take: ${drift.map((d) => d.setting).join(', ')}`, undefined, {
          code: 'BIOS_DRIFT',
          drift,
        });
      return { verified: Object.keys(want).length };
    },
  });

  /** Builds the profile's RAID layout (destroys the volumes' data: commissioning, before the wipe). */
  const raidApply = defineStep({
    id: 'raid.apply',
    runsOn: 'control-plane',
    relays: ['site'],
    timeout: '1h',
    retrySafe: false,
    input: manifest({}),
    async run(_input, context): Promise<Json> {
      const layout = profileOf(await metalNode(context))?.raid;
      if (!layout || layout.volumes.length === 0) return { skipped: true };
      const volumes = layout.volumes.map((volume) => ({
        level: volume.level,
        ...(volume.sizeGiB === undefined ? {} : { sizeGiB: volume.sizeGiB }),
        ...(volume.disks ? { disks: [...volume.disks] } : {}),
      }));
      await bmc(context, 'bmc.storage', 'raid.applyLayout', { volumes }, 'apply');
      const read = (await bmc(context, 'bmc.query', 'raid.getLayout', {}, 'read')) as Record<string, Json>;
      const levels = Array.isArray(read.volumes) ? read.volumes.map((v) => String((v as Record<string, Json>)?.level)) : [];
      const wanted = volumes.map((v) => v.level);
      if (levels.length !== wanted.length || levels.some((level, i) => level !== wanted[i]))
        throw new ComputeError('DRIVER_ERROR', `The RAID layout reads back as [${levels.join(', ')}], not [${wanted.join(', ')}]`, undefined, {
          code: 'RAID_MISMATCH',
        });
      return { volumes: wanted };
    },
  });

  /** Two-phase BMC password rotation (bmc-rotation.ts); a failure keeps the old password current. */
  const rotateBmcCredential = defineStep({
    id: 'metal.rotateBmcCredential',
    runsOn: 'control-plane',
    relays: ['site'],
    timeout: '10m',
    retrySafe: true,
    input: manifest({ username: field.string().optional() }),
    async run(input, context) {
      const node = await metalNode(context);
      const previousRef = node.bmc_credentials;
      if (!previousRef) throw new ComputeError('INVALID_STATE', `Node ${node.node_id} has no BMC credentials`);
      if (!context.secrets) throw new ComputeError('INVALID_CONFIG', 'metal.rotateBmcCredential needs the secret broker');
      // A retry picks up the pending version, whose password the BMC may already have.
      let pending = await pendingCredential(context.sql, node.node_id);
      if (!pending) {
        const ref = await context.secrets.put(node.tenant_id, generateBmcPassword());
        pending = await context.sql.transaction((tx) => addPendingCredential(tx, node.node_id, ref, previousRef));
      }
      const fail = async (error: ComputeError) => {
        await context.sql.transaction((tx) =>
          failCredential(tx, node.node_id, pending!, {
            code: error.code,
            message: error.message,
            ...(error.details ? { details: error.details as Json } : {}),
          }),
        );
        throw error;
      };
      let outcome: CommandOutcome;
      try {
        outcome = await awaitCommand(context, {
          nodeId: await siteAgent(context, node.node_id),
          kind: 'bmc.rotate',
          payload: bmcOperationJson(node, 'management.rotateCredential', {
            newCredentialRef: pending.ref,
            ...(input.username ? { username: input.username } : {}),
          }),
        });
      } catch (error) {
        if (error instanceof ComputeError && error.code === 'DRIVER_ERROR') return fail(error);
        throw error; // not ready yet, or the engine's own errors
      }
      let verified = false;
      try {
        verified = (bmcResult(outcome).result as Record<string, Json>).verified === true;
      } catch (error) {
        return fail(error as ComputeError);
      }
      if (!verified) return fail(new ComputeError('DRIVER_ERROR', 'The site agent could not log in with the new BMC credential'));
      if (!(await verifySite(context.sql, outcome, context)))
        return fail(new ComputeError('DRIVER_ERROR', 'The rotation result is not signed by the site agent'));
      await context.sql.transaction((tx) => promoteCredential(tx, node.node_id, pending!, previousRef));
      // The old secrets go once nothing queued still names them.
      const purgeable = await purgeableCredentials(context.sql, node.node_id);
      let purged = 0;
      if (context.secrets.delete)
        for (const old of purgeable) {
          await context.secrets.delete(old.ref as SecretRef);
          await markPurged(context.sql, node.node_id, old.version);
          purged++;
        }
      return { version: pending.version, rotated: true, purged };
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
    rotateBmcCredential,
    firmwareCheck,
    exitTenantRoot,
    biosApply,
    biosVerify,
    raidApply,
  ];
}
