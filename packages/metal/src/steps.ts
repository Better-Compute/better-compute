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
  resolveImageRef,
  siteAgentFor,
  stepNotReady,
  workflowProfile,
  type CommandOutcome,
} from '@better-compute/provision';
import { readMetalNode, type MetalNodeRow } from './store.js';

// Metal's workflow steps (PLAN.md §3.5, §11.3). Most are control-plane steps that build a command
// only the control plane can build (BMC address and credential ref, resolved image, ramdisk boot
// entry) and relay it with `awaitCommand` to the site agent or to the ramdisk on the machine.
// `boot.kexec` is a plain ramdisk step: it ends the ramdisk, so it completes when the installed OS
// rejoins (`await: 'rejoin'`).

/** Decides whether an attested command result is trustworthy (pki verifies `node_sig`, §13). */
export type AttestationVerifier = (tx: SqlTx, outcome: CommandOutcome, context: StepContext) => Promise<boolean>;

/** The default verifier accepts what the gateway marked attested on ingest. */
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
    payload: {
      targetNodeId: node.node_id,
      driver: node.bmc_driver,
      address: node.bmc_address,
      credentialsRef: node.bmc_credentials,
      operation,
      args,
      ...(node.bmc_tls_spki_sha256 ? { tlsSpkiSha256: node.bmc_tls_spki_sha256 } : {}),
    },
    ...(key ? { key } : {}),
  });
  return decodeResult(outcome);
}

/** Results travel as canonical JSON (`result_json`) or raw bytes; both come back as JSON here. */
function decodeResult(outcome: CommandOutcome): Json {
  if (!outcome.result || outcome.result.byteLength === 0) return { commandId: outcome.commandId };
  const text = new TextDecoder().decode(outcome.result);
  try {
    const parsed = JSON.parse(text) as Json;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, Json>), commandId: outcome.commandId }
      : { value: parsed, commandId: outcome.commandId };
  } catch {
    return { commandId: outcome.commandId, resultBase64: Buffer.from(outcome.result).toString('base64') };
  }
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
  const verify = options.verifyAttestation ?? acceptIngestedAttestation;

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
      if (macs.length || uuid)
        await context.sql.query(
          `UPDATE metal_nodes SET macs = CASE WHEN cardinality($2::text[]) > 0 THEN $2::text[] ELSE macs END,
             product_uuid = COALESCE($3, product_uuid), updated_at = compute_now() WHERE node_id = $1`,
          [requireNode(context), macs, uuid],
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
      if (node.macs.length === 0)
        throw new ComputeError('INVALID_STATE', `Node ${node.node_id} has no known PXE MAC; inspect it out of band first`);
      const outcome = await awaitCommand(context, {
        nodeId: await siteAgent(context, node.node_id),
        kind: 'boot.prepareRamdisk',
        payload: {
          targetNodeId: node.node_id,
          macs: node.macs,
          ...(node.product_uuid ? { productUuid: node.product_uuid } : {}),
          arch: node.arch,
          uefi: node.uefi,
          workflowId: context.workflowId,
        },
      });
      return decodeResult(outcome);
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
        payload: { targetNodeId: node.node_id, macs: node.macs },
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
      const agent = await siteAgent(context, node.node_id);
      await bmc(context, 'bmc.boot', 'management.setBootDevice', { device: 'pxe', persistent: false, uefi: node.uefi }, 'boot-device');
      await awaitCommand(context, {
        nodeId: agent,
        kind: 'boot.prepareRamdisk',
        key: 'boot-entry',
        payload: {
          targetNodeId: node.node_id,
          macs: node.macs,
          ...(node.product_uuid ? { productUuid: node.product_uuid } : {}),
          arch: node.arch,
          uefi: node.uefi,
          workflowId: context.workflowId,
        },
      });
      await bmc(context, 'bmc.power', 'power.setPower', { action: 'cycle' }, 'power-cycle');
      if (!(await ramdiskConnected(context, node.node_id))) throw stepNotReady(5_000);
      return { ramdisk: 'booted' };
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
      const outcome = await awaitCommand(context, { nodeId: requireNode(context), kind: 'inventory.refresh', payload: {} });
      return decodeResult(outcome);
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
      const result = decodeResult(outcome) as Record<string, Json>;
      if (result.passed === false) throw new ComputeError('DRIVER_ERROR', `DCGM level ${input.level} failed`, undefined, { result });
      return { ...result, level: input.level, attested };
    },
  });

  const wipe = defineStep({
    id: 'disk.wipe',
    runsOn: 'control-plane',
    relays: ['ramdisk'],
    timeout: '6h',
    retrySafe: false,
    input: manifest({ mode: field.option(['none', 'quick', 'secure-erase', 'crypto-erase']).optional() }),
    async run(input, context) {
      const node = await metalNode(context);
      const mode = input.mode ?? node.release_wipe;
      if (mode === 'none') return { mode, attested: true };
      const outcome = await awaitCommand(context, { nodeId: node.node_id, kind: 'disk.wipe', payload: { mode } });
      // `ready` follows only a verified wipe (§11.1): the release completes only on attested: true.
      return { ...(decodeResult(outcome) as Record<string, Json>), mode, attested: await verify(context.sql, outcome, context) };
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
      const outcome = await awaitCommand(context, {
        nodeId: node.node_id,
        kind: 'deploy.image',
        payload: {
          imageId: image.id,
          url: image.source,
          sha256: image.sha256,
          format: pinned?.profile.image?.format ?? image.format,
          compression: pinned?.profile.image?.compression ?? image.compression,
          uefi: node.uefi,
          ...(pinned?.profile.userData ? { userData: pinned.profile.userData as unknown as Json } : {}),
        },
        timeoutMs: 60 * 60_000,
      });
      return { ...(decodeResult(outcome) as Record<string, Json>), imageId: image.id, sha256: image.sha256 };
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
        return { revokedCertificates: revoked.rowCount };
      });
    },
  });

  return [getPower, setPower, setBootDevice, inspectOob, prepareRamdisk, cleanUp, ensureRamdisk, refreshInventory, dcgm, wipe, deploy, kexec, revokeIdentity];
}
