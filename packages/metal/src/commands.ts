import type { CommandKindSpec, MessageDescriptor } from '@better-compute/core';

// The command kinds metal sends (PLAN.md §6, §7.4): BMC and boot operations run by the site agent
// (`bettercompute.site.v1`, a DRAFT package), and disk, diagnostics and kexec operations run by the
// ramdisk (`bettercompute.agent.v1`, frozen and additive only).

const message = (typeName: string): MessageDescriptor => Object.freeze({ kind: 'message' as const, typeName });

export const metalPayloads = Object.freeze({
  bmcOperation: message('bettercompute.site.v1.BmcOperationRequest'),
  proxyDhcpEntry: message('bettercompute.site.v1.ProxyDhcpEntry'),
  /** `{ node_id, macs[], workflow_id }`: removes every boot entry for the node. */
  bootCleanUp: message('bettercompute.site.v1.BootCleanUpRequest'),
  /** `{ level, gpu_uuids[] }` → `DiagDcgmResult` (attested). */
  diagDcgm: message('bettercompute.agent.v1.DiagDcgmRequest'),
  /** `{ mode, disks[] }` → `WipeResult { mode, disks[{ id, method, verified, message }] }` (attested). */
  wipe: message('bettercompute.agent.v1.WipeRequest'),
  /** `{ url, sha256, format, compression, root_disk, user_data_ref, user_data_kind, uefi }` → `DeployImageResult`. */
  deployImage: message('bettercompute.agent.v1.DeployImageRequest'),
  /** `{ kernel_path, initrd_path, kernel_cmdline[] }`: boots the installed OS, so it never reports success itself. */
  kexec: message('bettercompute.agent.v1.KexecRequest'),
  /** Proposed: `{ url, method, headers, body, tls_spki_sha256, timeout_ms }` → `HttpProxyResponse { status, headers, body }`. */
  httpProxy: message('bettercompute.site.v1.HttpProxyRequest'),
});

/**
 * Metal's command kinds.
 * - Site agent: `bmc.query` (power state, OOB inspection), `bmc.boot` (boot device, virtual
 *   media), `bmc.power` (power actions: destructive, not retry-safe, since a cycle is not
 *   idempotent), `boot.prepareRamdisk`, `boot.cleanUp`.
 * - Ramdisk: `diag.dcgm` (attested), `disk.wipe` (attested, destructive), `deploy.image`
 *   (destructive), `boot.kexec` (self-terminating: completes on rejoin).
 */
export const metalCommandKinds: readonly CommandKindSpec[] = Object.freeze([
  { kind: 'bmc.query', lane: 'control', retrySafe: true, timeout: '2m', roles: ['site'], payload: metalPayloads.bmcOperation },
  { kind: 'bmc.boot', lane: 'control', retrySafe: true, timeout: '2m', roles: ['site'], payload: metalPayloads.bmcOperation },
  {
    kind: 'bmc.power',
    lane: 'control',
    retrySafe: false,
    destructive: true,
    timeout: '5m',
    roles: ['site'],
    payload: metalPayloads.bmcOperation,
  },
  { kind: 'boot.prepareRamdisk', lane: 'control', retrySafe: true, timeout: '2m', roles: ['site'], payload: metalPayloads.proxyDhcpEntry },
  { kind: 'boot.cleanUp', lane: 'control', retrySafe: true, timeout: '2m', roles: ['site'], payload: metalPayloads.bootCleanUp },
  { kind: 'diag.dcgm', lane: 'provision', retrySafe: true, attested: true, timeout: '1h', roles: ['ramdisk', 'node'], payload: metalPayloads.diagDcgm },
  {
    kind: 'disk.wipe',
    lane: 'provision',
    retrySafe: false,
    attested: true,
    destructive: true,
    timeout: '6h',
    roles: ['ramdisk'],
    payload: metalPayloads.wipe,
  },
  {
    kind: 'deploy.image',
    lane: 'provision',
    retrySafe: false,
    destructive: true,
    timeout: '1h',
    roles: ['ramdisk'],
    payload: metalPayloads.deployImage,
  },
  // One HTTP(S) request from the site agent to a machine's own address (§5.6 walkthrough 3): how
  // control-plane steps reach agentless machines (the Talos API) without breaking P5.
  { kind: 'site.httpProxy', lane: 'control', retrySafe: false, timeout: '1m', roles: ['site'], payload: metalPayloads.httpProxy },
  {
    kind: 'boot.kexec',
    lane: 'control',
    retrySafe: false,
    selfTerminating: true,
    timeout: '15m',
    roles: ['ramdisk'],
    payload: metalPayloads.kexec,
  },
] satisfies CommandKindSpec[]);
