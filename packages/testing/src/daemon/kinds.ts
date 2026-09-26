import { createHash } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { anyUnpack } from '@bufbuild/protobuf/wkt';
import { redactSecrets } from '@better-compute/pki';
import {
  AgentRole,
  DiagNvmlResultSchema,
  GpuResetResultSchema,
  INVENTORY_SECTIONS,
  InstanceSnapshotRequestSchema,
  InstanceSnapshotResultSchema,
  InventoryRefreshResultSchema,
  Lane,
  LogsCollectResultSchema,
  MAX_COMMAND_BODY_BYTES,
  commandKinds,
  encodeCommandResult,
  encodeMessage,
  isInventorySectionName,
  unpackCommandPayload,
  type CommandBody,
  type CommandKind,
  type CommandPayload,
} from '@better-compute/protocol';
import type { EncodedSection, FakeHardware } from '../fake-hw.js';
import type { FakeSnapshot } from './instances.js';

/** Test knobs a FakeDaemon's handlers read; change them at any time. */
export interface FakeDaemonKnobs {
  diag: {
    /** NVML cannot initialize (the node reports `nvml.init` failed and 0 GPUs). */
    nvmlInitFails?: boolean;
    /** GPU UUID → names of the per-GPU checks that fail (e.g. `ecc.uncorrectable`). */
    failGpus?: Record<string, string[]>;
    /** The command itself fails with this error code instead of reporting. */
    error?: string;
  };
  logs: {
    /** The upload fails: FAILED{upload-failed}. */
    uploadFails?: boolean;
  };
  /** The next `n` CDI writes fail; the devices section reports PROGRESSING and retries. */
  cdiWriteFailures: number;
  /**
   * Pods keep a released Kubernetes hold's devices this long (ms; 0: none): bcd stops offering them
   * at once but keeps them claimed, and reports AllocationReleased only once the pods let go (its
   * fail-closed InUse). A new hold on them meanwhile fails with overlap.
   */
  kubePodReleaseMs?: number;
}

/** What a kind handler can see and do on its node. */
export interface FakeKindContext {
  readonly nodeId: string;
  readonly bootId: string;
  readonly daemonVersion: string;
  readonly hardware: FakeHardware;
  readonly knobs: FakeDaemonKnobs;
  /** The CommandBody being executed. */
  readonly body: CommandBody;
  /** Server time (local clock + Welcome offset), in milliseconds. */
  now(): number;
  /** The last inventory collection, or a fresh one when `rescan`. */
  collectInventory(rescan: boolean): EncodedSection[];
  /** Sends InventorySection frames now (if a session is up). */
  sendInventory(sections: readonly EncodedSection[]): void;
  /** Device ids held by a live CDI assignment. */
  assignedDevices(): ReadonlySet<string>;
  /** Stores an upload in the fake object store (logs.collect). */
  upload(url: string, bytes: Uint8Array): void;
  /**
   * (v0.5) Captures a managed instance's state on this host's fake hypervisor (`instance.snapshot`);
   * absent on hosts without one. Throws for an unknown or failed instance.
   */
  snapshot?(instanceId: string, includeMemory: boolean): FakeSnapshot;
}

/** A command outcome a handler returns. */
export type FakeKindOutcome =
  | { outcome: 'succeeded'; result?: Uint8Array; attest?: true }
  | { outcome: 'failed'; code: string; message?: string; result?: Uint8Array; attest?: true };

/**
 * The daemon's view of one kind (Go: dispatch.Kind): its lane and allowed roles, how long its side
 * effect takes, and the handler. The retry_safe / self_terminating flags come from the CommandBody.
 */
export interface FakeKind {
  lane: Lane;
  roles: readonly AgentRole[];
  /** Side-effect duration in milliseconds (default 1 000). */
  durationMs?: number | ((body: CommandBody) => number);
  /** `reboot`: the side effect reboots the node (node.reboot); `run` is not called. */
  effect?: 'reboot';
  /**
   * The daemon's own verdict (never the body's): a destructive kind runs only with a valid worker
   * signature when the daemon enforces signed intent (§6, v0.2). Defaults to the wire kind table.
   */
  destructive?: boolean;
  /**
   * The side effect's outcome, reported once `durationMs` has passed; a Promise (e.g. a bcx driver
   * call) is reported when it settles, if the process is still the one that started it.
   */
  run?(context: FakeKindContext): FakeKindOutcome | Promise<FakeKindOutcome>;
}

const invalid = (error: unknown): FakeKindOutcome => ({
  outcome: 'failed',
  code: 'invalid-payload',
  message: error instanceof Error ? error.message : String(error),
});

function payloadOf<K extends CommandKind>(kind: K, body: CommandBody): CommandPayload<K> {
  return unpackCommandPayload(kind, body.payload);
}

/** diag.nvml: checks every (or the listed) GPU; the result says whether all checks passed. */
export const fakeDiagNvml: FakeKind = {
  lane: commandKinds['diag.nvml'].lane,
  roles: commandKinds['diag.nvml'].roles,
  durationMs: 2_000,
  run(ctx) {
    let request;
    try {
      request = payloadOf('diag.nvml', ctx.body);
    } catch (error) {
      return invalid(error);
    }
    const { diag } = ctx.knobs;
    if (diag.error) return { outcome: 'failed', code: diag.error, message: 'diag.nvml failed' };
    const section = ctx.hardware.inventory.gpus;
    const nvml = section !== undefined && !diag.nvmlInitFails;
    const checks = [
      { name: 'nvml.init', passed: nvml, message: nvml ? '' : 'NVML is not available on this node' },
    ];
    if (!nvml) {
      const result = create(DiagNvmlResultSchema, { passed: false, gpuCount: 0, checks });
      return { outcome: 'succeeded', result: encodeCommandResult('diag.nvml', result) };
    }
    const visible = section.gpus;
    if (request.expectedGpuCount > 0)
      checks.push({
        name: 'gpu.count',
        passed: visible.length >= request.expectedGpuCount,
        message: `${visible.length} of ${request.expectedGpuCount} GPUs visible`,
      });
    const byUuid = new Map(visible.map((gpu) => [gpu.uuid, gpu]));
    const wanted = request.gpuUuids.length > 0 ? [...new Set(request.gpuUuids)] : [...byUuid.keys()];
    const gpus = wanted.sort().map((uuid) => {
      const gpu = byUuid.get(uuid);
      if (!gpu)
        return { uuid, passed: false, checks: [{ name: 'gpu.present', passed: false, message: 'not visible to NVML' }] };
      const failing = new Set(diag.failGpus?.[uuid] ?? []);
      const ecc = gpu.ecc?.volatileCounts?.uncorrectable ?? 0n;
      if (ecc > 0n) failing.add('ecc.uncorrectable');
      if (gpu.rowRemap?.pending) failing.add('row-remap.pending');
      if (gpu.rowRemap?.failure) failing.add('row-remap.failure');
      const names = ['ecc.uncorrectable', 'row-remap.pending', 'row-remap.failure', 'pcie.link', 'xid.recent'];
      for (const extra of failing) if (!names.includes(extra)) names.push(extra);
      const gpuChecks = names.map((name) => ({
        name,
        passed: !failing.has(name),
        message: failing.has(name) ? `${name} failed` : '',
      }));
      return { uuid, passed: gpuChecks.every((c) => c.passed), checks: gpuChecks };
    });
    const result = create(DiagNvmlResultSchema, {
      passed: checks.every((c) => c.passed) && gpus.every((g) => g.passed),
      gpuCount: visible.length,
      driverVersion: section.driverVersion,
      checks,
      gpus,
    });
    return { outcome: 'succeeded', result: encodeCommandResult('diag.nvml', result) };
  },
};

/** inventory.refresh: (re)sends the requested sections as InventorySection frames, then succeeds. */
export const fakeInventoryRefresh: FakeKind = {
  lane: commandKinds['inventory.refresh'].lane,
  roles: commandKinds['inventory.refresh'].roles,
  durationMs: 500,
  run(ctx) {
    let request;
    try {
      request = payloadOf('inventory.refresh', ctx.body);
    } catch (error) {
      return invalid(error);
    }
    const unknown = request.sections.filter((name) => !isInventorySectionName(name));
    if (unknown.length > 0) return invalid(new Error(`unknown inventory sections ${unknown.join(', ')}`));
    const names = new Set<string>(request.sections.length > 0 ? request.sections : INVENTORY_SECTIONS);
    const sections = ctx.collectInventory(request.rescan).filter((s) => names.has(s.name));
    ctx.sendInventory(sections);
    const result = create(InventoryRefreshResultSchema, {
      sectionHashes: Object.fromEntries(sections.map((s) => [s.name, s.sha256])),
    });
    return { outcome: 'succeeded', result: encodeCommandResult('inventory.refresh', result) };
  },
};

/** logs.collect: "uploads" a small bundle to the presigned URL (the fake object store). */
export const fakeLogsCollect: FakeKind = {
  lane: commandKinds['logs.collect'].lane,
  roles: commandKinds['logs.collect'].roles,
  durationMs: 5_000,
  run(ctx) {
    let request;
    try {
      request = payloadOf('logs.collect', ctx.body);
    } catch (error) {
      return invalid(error);
    }
    if (!request.uploadUrl.startsWith('https://'))
      return invalid(new Error('upload_url must be a presigned https URL'));
    if (ctx.knobs.logs.uploadFails)
      return { outcome: 'failed', code: 'upload-failed', message: 'PUT returned 403' };
    const units = request.units.length > 0 ? request.units : ['bcd.service'];
    const lines = [
      `bcd ${ctx.daemonVersion} node=${ctx.nodeId} boot=${ctx.bootId}`,
      `lookback=${request.lookbackSeconds}s units=${units.join(',')}`,
      ...units.map((unit) => `${unit}: started`),
      // Support bundles are scanned for join and IAM tokens before upload (PLAN.md §6).
      'env: BCD_JOIN_TOKEN=bcjt_01example.secret',
    ];
    if (request.supportBundle) lines.push('support-bundle: status, doctor, journal metadata, inventory');
    // pki's scanner: join and IAM tokens, JWTs, private keys, URL passwords (bcd mirrors the patterns).
    let bytes: Uint8Array = new TextEncoder().encode(`${redactSecrets(lines.join('\n')).text}\n`);
    let truncated = false;
    const max = Number(request.maxBytes);
    if (max > 0 && bytes.byteLength > max) {
      bytes = bytes.slice(bytes.byteLength - max); // oldest first goes
      truncated = true;
    }
    ctx.upload(request.uploadUrl, bytes);
    const result = create(LogsCollectResultSchema, {
      uploadedBytes: BigInt(bytes.byteLength),
      sha256: new Uint8Array(createHash('sha256').update(bytes).digest()),
      truncated,
      contentType: 'text/plain',
    });
    return { outcome: 'succeeded', result: encodeCommandResult('logs.collect', result) };
  },
};

/** node.reboot: after `delay_ms`, journals running{boot_id} and reboots the node. */
export const fakeNodeReboot: FakeKind = {
  lane: commandKinds['node.reboot'].lane,
  roles: commandKinds['node.reboot'].roles,
  destructive: commandKinds['node.reboot'].destructive,
  effect: 'reboot',
  durationMs: (body) => {
    try {
      return payloadOf('node.reboot', body).delayMs;
    } catch {
      return 0;
    }
  },
};

/**
 * gpu.reset (not a v0.1 daemon kind: opt in with `kinds: { 'gpu.reset': fakeGpuReset }`). NOT
 * retry-safe, which makes it the kind to test FAILED{interrupted} and journal-lost with.
 */
export const fakeGpuReset: FakeKind = {
  lane: commandKinds['gpu.reset'].lane,
  roles: commandKinds['gpu.reset'].roles,
  destructive: commandKinds['gpu.reset'].destructive,
  durationMs: 3_000,
  run(ctx) {
    let request;
    try {
      request = payloadOf('gpu.reset', ctx.body);
    } catch (error) {
      return invalid(error);
    }
    if (request.gpuUuids.length === 0) return invalid(new Error('gpu_uuids is empty'));
    const known = new Set(ctx.hardware.gpuUuids);
    const busy = ctx.assignedDevices();
    const blocked = request.gpuUuids.filter((uuid) => busy.has(uuid));
    if (blocked.length > 0)
      return { outcome: 'failed', code: 'gpu-busy', message: `${blocked.join(', ')} has a live assignment` };
    const result = create(GpuResetResultSchema, {
      gpus: [...request.gpuUuids].sort().map((uuid) => ({
        uuid,
        reset: known.has(uuid),
        healthy: known.has(uuid),
        message: known.has(uuid) ? '' : 'unknown GPU',
      })),
    });
    return { outcome: 'succeeded', result: encodeCommandResult('gpu.reset', result) };
  },
};

/**
 * instance.snapshot (v0.5, sandboxes §3.7; a vps module kind, not a built-in): captures the
 * instance on the host's fake hypervisor, "uploads" it to the presigned URL (the fake object store)
 * and reports `InstanceSnapshotResult` with the host CPU model for memory snapshots. A VPS host
 * (`instances` given) runs it; others answer `unsupported`. Not retry-safe.
 */
export const fakeInstanceSnapshot: FakeKind = {
  lane: Lane.BULK,
  roles: [AgentRole.NODE],
  durationMs: 3_000,
  run(ctx) {
    const request = ctx.body.payload && anyUnpack(ctx.body.payload, InstanceSnapshotRequestSchema);
    if (!request) return invalid(new Error('instance.snapshot takes an InstanceSnapshotRequest'));
    if (!request.uploadUrl.startsWith('https://'))
      return invalid(new Error('upload_url must be a presigned https URL'));
    if (!ctx.snapshot)
      return { outcome: 'failed', code: 'unsupported', message: 'no instances runtime on this host' };
    let captured: FakeSnapshot;
    try {
      captured = ctx.snapshot(request.instanceId, request.includeMemory);
    } catch (error) {
      return {
        outcome: 'failed',
        code: 'instance-missing',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    ctx.upload(request.uploadUrl, captured.bytes);
    const result = create(InstanceSnapshotResultSchema, {
      uploadedBytes: BigInt(captured.bytes.byteLength),
      sha256: Uint8Array.from(Buffer.from(captured.sha256, 'hex')),
      runtime: captured.runtime,
      cpuModel: request.includeMemory ? (ctx.hardware.inventory.cpu?.model ?? '') : '',
    });
    return {
      outcome: 'succeeded',
      result: encodeMessage(InstanceSnapshotResultSchema, result, MAX_COMMAND_BODY_BYTES),
    };
  },
};

/** The v0.1 daemon's kinds (Go: the dispatch registry once the v0.1 handlers land). */
export const defaultFakeKinds: Readonly<Record<string, FakeKind>> = {
  'diag.nvml': fakeDiagNvml,
  'inventory.refresh': fakeInventoryRefresh,
  'logs.collect': fakeLogsCollect,
  'node.reboot': fakeNodeReboot,
};

/** Default worker pools per lane (PLAN.md §6 "Internals"). */
export const DEFAULT_WORKERS: Readonly<Record<Lane, number>> = {
  [Lane.UNSPECIFIED]: 0,
  [Lane.CONTROL]: 4,
  [Lane.PROVISION]: 2,
  [Lane.BULK]: 1,
};

/** Default per-lane credits when Welcome carries none (PLAN.md §7.5). */
export const DEFAULT_CREDITS: Readonly<Record<Lane, number>> = {
  [Lane.UNSPECIFIED]: 0,
  [Lane.CONTROL]: 8,
  [Lane.PROVISION]: 4,
  [Lane.BULK]: 2,
};
