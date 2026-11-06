import { createHash } from 'node:crypto';
import {
  ComputeError,
  field,
  isSecretRef,
  manifest,
  type HostSpec,
  type Json,
  type Manifest,
  type ModuleContext,
  type NodeRecord,
  type NodeSpec,
  type NodeSpecPart,
  type SqlTx,
} from '@better-compute/core';
import { evaluateWhen } from './expand.js';
import type { ImageUseOptions } from './images.js';
import { siteCacheImagesFor } from './site-cache.js';

// Config units (PLAN.md §11.2, §11.3): a profile's `hostConfig` becomes the node's desired state
// after join (NodeSpec `host.config`), so the daemon's converger keeps correcting drift. Each unit
// has a settings manifest; `when:` (the §11.2 label expression) turns a unit on per node, and
// `mig-layout` may take its layout from the pool (`from: 'pool'`).

/** A config unit kind: its settings manifest. */
export interface ConfigUnitDefinition {
  name: string;
  settings: Manifest<Record<string, Json>>;
  description: string;
}

export const builtinConfigUnits: readonly ConfigUnitDefinition[] = Object.freeze([
  {
    name: 'nvidia-driver',
    description: 'The NVIDIA driver branch (and the open kernel modules or not)',
    settings: manifest({ branch: field.string({ pattern: '^[0-9]{3}$' }), open: field.boolean().optional() }) as Manifest<Record<string, Json>>,
  },
  {
    name: 'container-toolkit',
    description: 'The NVIDIA container toolkit, generating CDI specs',
    settings: manifest({ cdi: field.boolean().default(true) }) as Manifest<Record<string, Json>>,
  },
  {
    name: 'mig-layout',
    description: "A MIG layout: a named profile per GPU, or the pool's layout",
    settings: manifest({
      from: field.option(['pool', 'profile']).default('profile'),
      layout: field.string({ maxLength: 64 }).optional(),
    }) as Manifest<Record<string, Json>>,
  },
  {
    name: 'fabric-manager',
    description: 'NVIDIA Fabric Manager for NVSwitch systems',
    settings: manifest({}) as Manifest<Record<string, Json>>,
  },
  {
    name: 'sysctl',
    description: 'Kernel parameters',
    settings: manifest({}) as Manifest<Record<string, Json>>,
  },
  {
    name: 'hugepages',
    description:
      'Huge pages: 2 MiB pages allocated at runtime, 1 GiB pages through the kernel command line (effective after a reboot), and the transparent huge page policy',
    settings: manifest({
      pages2m: field.int({ min: 0, max: 4_194_304 }).optional(),
      pages1g: field.int({ min: 0, max: 16_384 }).optional(),
      transparent: field.option(['always', 'madvise', 'never']).optional(),
      /** The counts are per NUMA node (each node gets them), not for the whole host. */
      perNuma: field.boolean().optional(),
    }) as Manifest<Record<string, Json>>,
  },
  {
    name: 'gpu-sharing',
    description:
      "How a shared pool's GPUs are split between clients: MPS (bcd-mps.service, 100/replicas % of the SMs each) or time-slicing (MPS stopped)",
    settings: manifest({
      mode: field.option(['mps', 'timeslice']),
      replicas: field.int({ min: 1, max: 48 }).optional(),
    }) as Manifest<Record<string, Json>>,
  },
  {
    name: 'cpu',
    description:
      'Host CPUs: the cpufreq governor (live), and CPUs isolated from the kernel scheduler for pinned VMs and holds (isolcpus/nohz_full/rcu_nocbs, effective after a reboot)',
    // Validated by validateCpu: the cpulist needs more than a pattern.
    settings: manifest({}) as Manifest<Record<string, Json>>,
  },
  {
    name: 'iommu',
    description:
      'The IOMMU for GPU passthrough to VMs and sandboxes: intel_iommu=on or amd_iommu=on (by CPU vendor) and iommu=pt on the kernel command line, effective after a reboot',
    settings: manifest({ passthrough: field.boolean().default(true) }) as Manifest<Record<string, Json>>,
  },
  {
    name: 'gpu-settings',
    description: 'Per-GPU settings kept by bcd: the power cap (nvidia-smi -pl, re-applied on drift) and ECC (effective after a reboot)',
    settings: manifest({
      powerLimitWatts: field.int({ min: 1, max: 10_000 }).optional(),
      ecc: field.boolean().optional(),
    }) as Manifest<Record<string, Json>>,
  },
  {
    name: 'kernel-modules',
    description:
      'Kernel modules loaded at boot and now (modules-load.d), with their options (modprobe.d): kvm_intel/kvm_amd, vhost_net and tun for VM hosts',
    // Validated by validateKernelModules: a module list and an options map.
    settings: manifest({}) as Manifest<Record<string, Json>>,
  },
  {
    name: 'k8s-join',
    description:
      "Joins the node to a Kubernetes cluster as a worker (kubeadm join with a bootstrap token fetched by reference) and keeps its kubelet, labels and taints; GPUs through containerd's NVIDIA runtime and CDI",
    // Validated by validateK8sJoin: the manifest cannot express its label map and taint list.
    settings: manifest({}) as Manifest<Record<string, Json>>,
  },
]);

const sysctlKey = /^[a-z0-9_]+(?:\.[a-z0-9_-]+)+$/;

/**
 * Keys bcd's host converger refuses (terminal): they run programs as root or lower the host's defenses.
 * Mirrored here so a profile or pool naming one is INVALID_INPUT up front, not a failed host section.
 * `prefix.*` covers the subtree.
 */
export const forbiddenSysctls: readonly string[] = Object.freeze([
  'kernel.core_pattern',
  'kernel.modprobe',
  'kernel.usermodehelper.*',
  'kernel.poweroff_cmd',
  'kernel.hotplug',
  'fs.binfmt_misc.*',
  'fs.suid_dumpable',
  'fs.protected_*',
  'kernel.randomize_va_space',
  'kernel.kptr_restrict',
  'kernel.dmesg_restrict',
  'kernel.yama.*',
  'kernel.kexec_load_disabled',
  'kernel.unprivileged_bpf_disabled',
  'kernel.perf_event_paranoid',
  'kernel.sysrq',
  'kernel.modules_disabled',
  'vm.mmap_min_addr',
  'vm.unprivileged_userfaultfd',
  'net.core.bpf_jit_harden',
  'user.*',
  'kernel.unprivileged_userns_clone',
  'kernel.apparmor_restrict_unprivileged_userns',
]);

/**
 * Keys bcd lets through only at safe values (a894cd2): set them to harden, never to loosen.
 */
export const restrictedSysctls: Readonly<Record<string, { what: string; allows(value: string): boolean }>> = Object.freeze({
  'dev.tty.legacy_tiocsti': { what: '0', allows: (value) => value === '0' },
  'dev.tty.ldisc_autoload': { what: '0', allows: (value) => value === '0' },
  'kernel.io_uring_disabled': { what: '1 or 2', allows: (value) => value === '1' || value === '2' },
  'net.ipv4.ip_unprivileged_port_start': {
    what: '1024 or more',
    allows: (value) => /^\d{1,5}$/.test(value) && Number(value) >= 1024 && Number(value) <= 65536,
  },
});

/**
 * Module options bcd refuses (a894cd2): each turns off a protection VFIO passthrough depends on
 * (`module` → option names; `-` and `_` are the same in module names).
 */
export const forbiddenModuleOptions: Readonly<Record<string, readonly string[]>> = Object.freeze({
  vfio: ['enable_unsafe_noiommu_mode'],
  vfio_iommu_type1: ['allow_unsafe_interrupts'],
});

function sysctlForbidden(key: string): boolean {
  return forbiddenSysctls.some((rule) => {
    if (rule.endsWith('.*')) return key.startsWith(rule.slice(0, -1)) || key === rule.slice(0, -2);
    if (rule.endsWith('*')) return key.startsWith(rule.slice(0, -1));
    return key === rule;
  });
}

// Kubernetes label syntax (k8s.io/docs/concepts/overview/working-with-objects/labels): an optional DNS
// subdomain prefix and a name of at most 63 characters; values the same, or empty.
const labelName = /^[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
const dnsSubdomain = /^(?=.{1,253}$)[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?)*$/;
const reservedPrefix = /(^|\.)(kubernetes\.io|k8s\.io)$/;
const taintEffects = ['NoSchedule', 'PreferNoSchedule', 'NoExecute'];

function labelKeyProblem(key: string): string | undefined {
  const slash = key.indexOf('/');
  const prefix = slash >= 0 ? key.slice(0, slash) : undefined;
  const name = slash >= 0 ? key.slice(slash + 1) : key;
  if (!labelName.test(name)) return 'is not a Kubernetes label name';
  if (prefix !== undefined && !dnsSubdomain.test(prefix)) return 'has a prefix that is not a DNS subdomain';
  // The kubelet refuses to set most of these itself, and the rest belong to the cluster.
  if (prefix !== undefined && reservedPrefix.test(prefix)) return 'uses a prefix reserved for Kubernetes (kubernetes.io, k8s.io)';
  return undefined;
}

const governors = ['performance', 'schedutil', 'ondemand', 'powersave'];
const cpulist = /^[0-9]+(-[0-9]+)?(,[0-9]+(-[0-9]+)?)*$/;

/** `cpu` settings: `governor`, and `isolate` (a kernel cpulist that never includes CPU 0, the housekeeping CPU). */
function validateCpu(settings: Record<string, Json>): Record<string, Json> {
  const bad = (message: string): never => {
    throw new ComputeError('INVALID_INPUT', `hostConfig.cpu.${message}`);
  };
  for (const key of Object.keys(settings)) if (key !== 'governor' && key !== 'isolate') bad(`${key} is not a setting (governor, isolate)`);
  const out: Record<string, Json> = {};
  if (settings.governor !== undefined) {
    if (typeof settings.governor !== 'string' || !governors.includes(settings.governor)) bad(`governor must be one of ${governors.join(', ')}`);
    out.governor = settings.governor;
  }
  if (settings.isolate !== undefined) {
    const list = settings.isolate;
    if (typeof list !== 'string' || list.length > 256 || !cpulist.test(list)) bad('isolate must be a cpulist such as 4-63,68-127 (at most 256 characters)');
    for (const part of (list as string).split(',')) {
      const [from, to = from] = part.split('-').map(Number);
      if (to! < from!) bad(`isolate: ${part} is a descending range`);
      if (from === 0) bad('isolate must not include CPU 0, which the kernel keeps for housekeeping');
    }
    out.isolate = list;
  }
  return out;
}

const moduleName = /^[a-z0-9_-]{1,64}$/;
const moduleOptions = /^[A-Za-z0-9_.,:=/ -]{0,256}$/;

/** `kernel-modules` settings: `load` (module names) and `options` (module → "k=v k2=v2"). */
function validateKernelModules(settings: Record<string, Json>): Record<string, Json> {
  const bad = (message: string): never => {
    throw new ComputeError('INVALID_INPUT', `hostConfig.kernel-modules.${message}`);
  };
  for (const key of Object.keys(settings)) if (key !== 'load' && key !== 'options') bad(`${key} is not a setting (load, options)`);
  const out: Record<string, Json> = {};
  if (settings.load !== undefined) {
    const load = settings.load;
    if (!Array.isArray(load) || load.length > 64) bad('load must be a list of at most 64 module names');
    for (const name of load as Json[]) if (typeof name !== 'string' || !moduleName.test(name)) bad(`load: ${JSON.stringify(name)} is not a module name`);
    out.load = [...new Set(load as string[])].sort();
  }
  if (settings.options !== undefined) {
    const options = settings.options;
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).length > 64)
      bad('options must be an object of at most 64 module: "key=value …" entries');
    for (const [name, value] of Object.entries(options as Record<string, Json>)) {
      if (!moduleName.test(name)) bad(`options: ${name} is not a module name`);
      if (typeof value !== 'string' || !moduleOptions.test(value)) bad(`options.${name} must be "key=value …" (letters, digits and _.,:=/ -)`);
      const refused = forbiddenModuleOptions[name.replace(/-/g, '_')] ?? [];
      for (const option of (value as string).split(/\s+/).filter(Boolean)) {
        const key = option.split('=')[0]!.replace(/-/g, '_');
        if (refused.includes(key)) bad(`options.${name}: ${key} turns off a protection GPU passthrough depends on`);
      }
    }
    out.options = Object.fromEntries(Object.entries(options as Record<string, string>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
  return out;
}

/**
 * `k8s-join` settings. `mode: 'kubeadm'` (the default): the API server, its CA pin, the bootstrap token by
 * reference, the kubelet release. `mode: 'eks'` (AWS A9): the EKS cluster nodeadm joins (`cluster`), with no
 * token (the node authenticates as its instance profile's role through an EC2_LINUX access entry). Both: labels,
 * taints, `gpu` and `gpuApi`.
 */
function validateK8sJoin(settings: Record<string, Json>): Record<string, Json> {
  const bad = (message: string): never => {
    throw new ComputeError('INVALID_INPUT', `hostConfig.k8s-join.${message}`);
  };
  const { mode } = settings;
  if (mode !== undefined && mode !== 'kubeadm' && mode !== 'eks') bad('mode must be kubeadm or eks');
  if (mode === 'eks') {
    const allowed = new Set(['mode', 'cluster', 'nodeLabels', 'taints', 'gpu', 'gpuApi']);
    for (const key of Object.keys(settings)) if (!allowed.has(key)) bad(`${key} is not a setting of mode eks (${[...allowed].join(', ')})`);
    const out: Record<string, Json> = { mode: 'eks', cluster: checkEksCluster(settings.cluster, 'hostConfig.k8s-join.cluster') };
    joinGpu(settings, out, bad);
    return joinLabels(settings, out, bad);
  }
  const allowed = new Set(['mode', 'server', 'caCertSha256', 'tokenRef', 'kubernetesVersion', 'nodeLabels', 'taints', 'gpu', 'gpuApi']);
  for (const key of Object.keys(settings)) if (!allowed.has(key)) bad(`${key} is not a setting (${[...allowed].join(', ')})`);
  const { server, caCertSha256, tokenRef, kubernetesVersion } = settings;
  let url: URL | undefined;
  try {
    url = typeof server === 'string' ? new URL(server) : undefined;
  } catch {
    url = undefined;
  }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search)
    bad('server must be the API server as https://host[:port]');
  // kubeadm's --discovery-token-ca-cert-hash: "sha256:<hex>" or the bare hex.
  const pin = typeof caCertSha256 === 'string' ? caCertSha256.toLowerCase().replace(/^sha256:/, '') : '';
  if (!/^[0-9a-f]{64}$/.test(pin)) bad('caCertSha256 must be the SHA-256 of the cluster CA public key, 64 hex digits (optionally "sha256:")');
  // The bootstrap token never travels in the spec: the daemon fetches it by reference, through the broker,
  // which releases secret:// refs only.
  if (typeof tokenRef !== 'string' || !isSecretRef(tokenRef) || !tokenRef.startsWith('secret://'))
    bad('tokenRef must be a secret:// reference to the bootstrap token (the broker releases secret:// refs only)');
  const out: Record<string, Json> = {
    ...(mode === 'kubeadm' ? { mode: 'kubeadm' } : {}),
    server: url!.origin,
    caCertSha256: pin,
    tokenRef: tokenRef as string,
  };
  joinGpu(settings, out, bad);
  if (kubernetesVersion !== undefined) {
    if (typeof kubernetesVersion !== 'string' || !/^1.[0-9]{2}.[0-9]{1,3}$/.test(kubernetesVersion)) bad('kubernetesVersion must be a release such as 1.34.1');
    out.kubernetesVersion = kubernetesVersion as string;
  }
  return joinLabels(settings, out, bad);
}

/** `k8s-join` `gpu` and `gpuApi` (both modes), validated into `out`. */
function joinGpu(settings: Record<string, Json>, out: Record<string, Json>, bad: (message: string) => never): void {
  const { gpu, gpuApi } = settings;
  out.gpu = gpu ?? true;
  if (typeof out.gpu !== 'boolean') bad('gpu must be true or false');
  // How GPUs reach the kubelet: bcd's device plugins (default) or its DRA driver (gpu.bcd.dev), never both.
  if (gpuApi !== undefined) {
    if (gpuApi !== 'device-plugin' && gpuApi !== 'dra') bad('gpuApi must be device-plugin or dra');
    out.gpuApi = gpuApi as string;
  }
}

/** `k8s-join` `nodeLabels` and `taints` (both modes), validated into `out`. */
function joinLabels(settings: Record<string, Json>, out: Record<string, Json>, bad: (message: string) => never): Record<string, Json> {
  const { nodeLabels, taints } = settings;
  if (nodeLabels !== undefined) {
    if (!nodeLabels || typeof nodeLabels !== 'object' || Array.isArray(nodeLabels)) bad('nodeLabels must be an object of label: value');
    const labels = nodeLabels as Record<string, Json>;
    if (Object.keys(labels).length > 64) bad('nodeLabels has more than 64 labels');
    for (const [key, value] of Object.entries(labels)) {
      const problem = labelKeyProblem(key);
      if (problem) bad(`nodeLabels.${key} ${problem}`);
      if (typeof value !== 'string' || (value !== '' && !labelName.test(value))) bad(`nodeLabels.${key} must be a Kubernetes label value (at most 63 characters)`);
    }
    out.nodeLabels = Object.fromEntries(Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
  if (taints !== undefined) {
    if (!Array.isArray(taints) || taints.length > 32) bad('taints must be a list of at most 32 "key[=value]:Effect" strings');
    for (const taint of taints as Json[]) {
      const match = typeof taint === 'string' ? /^([^=:]+)(?:=([^:]*))?:([A-Za-z]+)$/.exec(taint) : null;
      if (!match) bad(`taints: ${JSON.stringify(taint)} is not "key[=value]:Effect"`);
      const [, key, value, effect] = match!;
      const problem = labelKeyProblem(key!);
      if (problem) bad(`taints: the key ${key} ${problem}`);
      if (value && !labelName.test(value)) bad(`taints: the value of ${key} is not a Kubernetes label value`);
      if (!taintEffects.includes(effect!)) bad(`taints: ${effect} is not one of ${taintEffects.join(', ')}`);
    }
    out.taints = [...(taints as string[])];
  }
  return out;
}

/** A unit's settings minus the unit-level `when:` key. */
function settingsOf(raw: Record<string, Json>): { when?: string; settings: Record<string, Json> } {
  const { when, ...settings } = raw;
  return typeof when === 'string' ? { when, settings } : { settings };
}

async function validateUnit(unit: ConfigUnitDefinition, name: string, settings: Record<string, Json>): Promise<Record<string, Json>> {
  if (name === 'sysctl') {
    // Free-form keys, but only sysctl names with scalar values.
    for (const [key, value] of Object.entries(settings))
      if (!sysctlKey.test(key) || !['string', 'number', 'boolean'].includes(typeof value))
        throw new ComputeError('INVALID_INPUT', `hostConfig.sysctl.${key} must be a sysctl name with a scalar value`);
      else if (sysctlForbidden(key))
        throw new ComputeError('INVALID_INPUT', `hostConfig.sysctl.${key} is not settable: it runs programs as root or lowers the host's defenses`);
      else if (Object.hasOwn(restrictedSysctls, key) && !restrictedSysctls[key]!.allows(String(value)))
        throw new ComputeError('INVALID_INPUT', `hostConfig.sysctl.${key} may only be ${restrictedSysctls[key]!.what}: other values lower the host's defenses`);
    return settings;
  }
  if (name === 'k8s-join') return validateK8sJoin(settings);
  if (name === 'kernel-modules') return validateKernelModules(settings);
  if (name === 'cpu') return validateCpu(settings);
  const result = await unit.settings['~standard'].validate(settings);
  if ('issues' in result && result.issues)
    throw new ComputeError(
      'INVALID_INPUT',
      `hostConfig.${name}: ${result.issues.map((issue) => issue.message).join('; ')}`,
    );
  return (result as { value: Record<string, Json> }).value;
}

export interface ResolveHostConfigContext {
  /** The node's labels, for `when:`. */
  labels: Readonly<Record<string, string>>;
  /** The pool's policy, for `mig-layout: { from: 'pool' }` (`policy.migLayout`). */
  poolPolicy?: Readonly<Record<string, unknown>> | null;
}

/**
 * Resolves a profile's `hostConfig` for one node: units whose `when:` is false are left out, each
 * unit's settings are validated against its manifest (unknown units are `INVALID_INPUT`), and a pool
 * MIG layout is filled in. The result is the NodeSpec `host` section.
 */
export async function resolveHostConfig(
  hostConfig: Readonly<Record<string, Record<string, Json>>> | undefined,
  context: ResolveHostConfigContext,
  units: readonly ConfigUnitDefinition[] = builtinConfigUnits,
): Promise<HostSpec> {
  const byName = new Map(units.map((unit) => [unit.name, unit]));
  const config: Record<string, Record<string, Json>> = {};
  for (const [name, raw] of Object.entries(hostConfig ?? {})) {
    const unit = byName.get(name);
    if (!unit) throw new ComputeError('INVALID_INPUT', `hostConfig.${name} is not a known config unit`);
    const { when, settings } = settingsOf(raw);
    if (when !== undefined && !evaluateWhen(when, context.labels)) continue;
    const valid = await validateUnit(unit, name, settings);
    if (name === 'mig-layout' && valid.from === 'pool') {
      const layout = context.poolPolicy?.migLayout;
      if (typeof layout !== 'string') throw new ComputeError('INVALID_INPUT', 'hostConfig.mig-layout takes its layout from the pool, which has no policy.migLayout');
      valid.layout = layout;
    }
    config[name] = valid;
  }
  return Object.keys(config).length ? { config } : {};
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The config units a pool's policy asks for on every machine of the pool (PLAN.md §3.8):
 * - `policy.kubernetes` { apiServer, caCertSha256, joinTokenRef, labels?, taints?, kubernetesVersion?, gpu? }
 *   → `k8s-join`; with `eks` { name, apiServerEndpoint, certificateAuthority, cidr } instead of the first three,
 *   `k8s-join` mode `eks` (nodeadm, AWS A9);
 * - `policy.hugepages` { size: '2Mi' | '1Gi', count, perNuma? } (core PoolPolicy) → `hugepages`
 *   { pages2m | pages1g: count, perNuma };
 * - `policy.kernelModules` { load?, options? } → `kernel-modules`;
 * - `policy.cpu` { governor?, isolate? } → `cpu`;
 * - `policy.iommu` { passthrough? } → `iommu` (GPU passthrough to VMs; set it on vps-host pools with GPU flavors);
 * - `policy.gpu` { powerLimitWatts?, ecc? } → `gpu-settings`;
 * - a pool shared by `mps` or `timeslice` → `gpu-sharing` { mode, replicas: `policy.sharing.replicas`,
 *   default 10 for MPS and 4 for time-slicing }.
 * They win over a profile's `hostConfig` for the same unit: the pool's operator decides cluster
 * membership, memory layout and GPU sharing, not the profile a machine was deployed with.
 */
export function poolHostConfig(
  policy: Readonly<Record<string, unknown>> | null | undefined,
  sharing?: string | null,
): Record<string, Record<string, Json>> {
  const config: Record<string, Record<string, Json>> = {};
  if (sharing === 'mps' || sharing === 'timeslice') {
    const replicas = isRecord(policy?.sharing) ? policy.sharing.replicas : undefined;
    config['gpu-sharing'] = { mode: sharing, replicas: (replicas ?? (sharing === 'mps' ? 10 : 4)) as Json };
  }
  const kubernetes = policy?.kubernetes;
  if (kubernetes !== undefined) {
    if (!isRecord(kubernetes)) throw new ComputeError('INVALID_INPUT', 'policy.kubernetes must be an object');
    const { apiServer, caCertSha256, joinTokenRef, labels, taints, kubernetesVersion, gpu, gpuApi, platformOperated, eks, ...rest } = kubernetes;
    const unknown = Object.keys(rest);
    if (unknown.length) throw new ComputeError('INVALID_INPUT', `policy.kubernetes.${unknown[0]} is not a setting`);
    if (platformOperated !== undefined && typeof platformOperated !== 'boolean')
      throw new ComputeError('INVALID_INPUT', 'policy.kubernetes.platformOperated must be true or false');
    const given = [apiServer, caCertSha256, joinTokenRef].filter((value) => value !== undefined).length;
    if (given !== 0 && given !== 3)
      throw new ComputeError(
        'INVALID_INPUT',
        'policy.kubernetes needs apiServer, caCertSha256 and joinTokenRef together (machines join that cluster), or none of them (bcd runs inside the cluster as a DaemonSet)',
      );
    if (eks !== undefined && (given !== 0 || kubernetesVersion !== undefined))
      throw new ComputeError(
        'INVALID_INPUT',
        'policy.kubernetes.eks joins an EKS cluster through nodeadm: it does not take apiServer, caCertSha256, joinTokenRef or kubernetesVersion (the AMI ships the kubelet)',
      );
  }
  if (isRecord(kubernetes) && kubernetes.eks !== undefined) {
    const { eks, labels, taints, gpu, gpuApi } = kubernetes;
    config['k8s-join'] = {
      mode: 'eks',
      cluster: eks as Json,
      ...(labels !== undefined ? { nodeLabels: labels as Json } : {}),
      ...(taints !== undefined ? { taints: taints as Json } : {}),
      ...(gpu !== undefined ? { gpu: gpu as Json } : {}),
      ...(gpuApi !== undefined ? { gpuApi: gpuApi as Json } : {}),
    };
  }
  // Machines join the cluster only when the pool names it: a pool whose bcd runs as a DaemonSet inside the
  // cluster (hosted, provider-kubernetes) is in it already, and kubeadm join would fail there.
  if (isRecord(kubernetes) && kubernetes.joinTokenRef !== undefined) {
    const { apiServer, caCertSha256, joinTokenRef, labels, taints, kubernetesVersion, gpu, gpuApi } = kubernetes;
    config['k8s-join'] = {
      server: apiServer as Json,
      caCertSha256: caCertSha256 as Json,
      tokenRef: joinTokenRef as Json,
      ...(labels !== undefined ? { nodeLabels: labels as Json } : {}),
      ...(taints !== undefined ? { taints: taints as Json } : {}),
      ...(kubernetesVersion !== undefined ? { kubernetesVersion: kubernetesVersion as Json } : {}),
      ...(gpu !== undefined ? { gpu: gpu as Json } : {}),
      ...(gpuApi !== undefined ? { gpuApi: gpuApi as Json } : {}),
    };
  }
  if (policy?.hugepages !== undefined) {
    const hugepages = policy.hugepages;
    if (!isRecord(hugepages)) throw new ComputeError('INVALID_INPUT', 'policy.hugepages must be an object');
    const { size, count, perNuma, ...rest } = hugepages;
    const unknown = Object.keys(rest);
    if (unknown.length) throw new ComputeError('INVALID_INPUT', `policy.hugepages.${unknown[0]} is not a setting (size, count, perNuma)`);
    if (size !== '2Mi' && size !== '1Gi') throw new ComputeError('INVALID_INPUT', "policy.hugepages.size must be '2Mi' or '1Gi'");
    config.hugepages = {
      [size === '2Mi' ? 'pages2m' : 'pages1g']: count as Json,
      ...(perNuma !== undefined ? { perNuma: perNuma as Json } : {}),
    };
  }
  if (policy?.cpu !== undefined) {
    if (!isRecord(policy.cpu)) throw new ComputeError('INVALID_INPUT', 'policy.cpu must be an object');
    config.cpu = { ...(policy.cpu as Record<string, Json>) };
  }
  if (policy?.iommu !== undefined) {
    if (!isRecord(policy.iommu)) throw new ComputeError('INVALID_INPUT', 'policy.iommu must be an object');
    config.iommu = { ...(policy.iommu as Record<string, Json>) };
  }
  if (policy?.gpu !== undefined) {
    if (!isRecord(policy.gpu)) throw new ComputeError('INVALID_INPUT', 'policy.gpu must be an object');
    config['gpu-settings'] = { ...(policy.gpu as Record<string, Json>) };
  }
  if (policy?.kernelModules !== undefined) {
    if (!isRecord(policy.kernelModules)) throw new ComputeError('INVALID_INPUT', 'policy.kernelModules must be an object');
    config['kernel-modules'] = { ...(policy.kernelModules as Record<string, Json>) };
  }
  return config;
}

/**
 * Checks a pool policy's host settings (`poolHostConfig`) as nodes will get them: for the pools API to
 * call on create and update, so a bad policy is refused there rather than breaking every node's spec.
 */
export async function validatePoolHostPolicy(policy: Readonly<Record<string, unknown>> | null | undefined, sharing?: string | null): Promise<void> {
  await resolveHostConfig(poolHostConfig(policy, sharing), { labels: {}, poolPolicy: policy ?? null });
}

/**
 * The NodeSpec contribution of provision (`ComputeModule.nodeSpec`): the `host` section from the
 * `hostConfig` of the last workflow that succeeded on the node, plus the units its pool's policy asks for
 * (`poolHostConfig`, which win), resolved for it. A node no workflow ran on (adopted) gets the pool's.
 */
export async function hostSpecFor(
  sql: SqlTx,
  nodeId: string,
  units: readonly ConfigUnitDefinition[] = builtinConfigUnits,
): Promise<Partial<NodeSpec>> {
  // A pool layout change reaches a node only once capacity granted it (every atom free, §10.4):
  // until then the node keeps the layout capacity froze it at (provision/0004). Capacity's
  // `carriesPoolLayout` reads the same source (the last succeeded workflow's
  // profile_document->'hostConfig'): change both together.
  const { rows } = await sql.query<{
    host_config: Record<string, Record<string, Json>> | null;
    pool_policy: Record<string, unknown> | null;
    pool_sharing: string | null;
    gated_layout: string | null;
  }>(
    `SELECT (SELECT w.profile_document->'hostConfig' FROM workflows w
              WHERE w.node_id = n.id AND w.state = 'succeeded' AND w.profile_document ? 'hostConfig'
              ORDER BY w.finished_at DESC NULLS LAST, w.id DESC LIMIT 1) AS host_config,
            p.policy AS pool_policy, p.sharing AS pool_sharing, provision_gated_mig_layout(n.id) AS gated_layout
       FROM nodes n LEFT JOIN pools p ON p.id = n.pool_id
      WHERE n.id = $1`,
    [nodeId],
  );
  const row = rows[0];
  if (!row) return {};
  const fromPool = poolHostConfig(row.pool_policy, row.pool_sharing);
  if (!row.host_config && Object.keys(fromPool).length === 0) return {};
  // `when:` sees a bc.dev/ label only when bcd set it (source `system`, review L11).
  const labels = await sql.query<{ key: string; value: string }>(
    `SELECT key, value FROM node_labels WHERE node_id = $1 AND (NOT starts_with(key, 'bc.dev/') OR source = 'system')`,
    [nodeId],
  );
  const poolPolicy = row.gated_layout !== null ? { ...(row.pool_policy ?? {}), migLayout: row.gated_layout } : row.pool_policy;
  const host = await resolveHostConfig({ ...(row.host_config ?? {}), ...fromPool }, {
    labels: Object.fromEntries(labels.rows.map((label) => [label.key, label.value])),
    poolPolicy,
  }, units);
  return host.config ? { host } : {};
}

/**
 * `ComputeModule.nodeSpec` for provision: the `host` section, and for site agents `site.cacheImages`
 * (the verified images their site's pools pre-warm, §11.5; SiteBoot contributes `site.boot`).
 */
export function provisionNodeSpec(units?: readonly ConfigUnitDefinition[], images?: ImageUseOptions) {
  return async (context: ModuleContext, node: NodeRecord): Promise<NodeSpecPart> => {
    const part: NodeSpecPart = await hostSpecFor(context.sql, node.id, units);
    if (node.role === 'site') part.site = { cacheImages: await siteCacheImagesFor(context.sql, node.id, images) };
    return part;
  };
}

// --- k8s-join mode 'eks' (AWS A9): nodeadm's NodeConfig in the user data --------------------------

/** The EKS cluster a `k8s-join` mode `eks` node joins (nodeadm's `spec.cluster`). */
export interface EksJoinCluster {
  /** The EKS cluster name. */
  name: string;
  /** `https://<id>.<gr>.<region>.eks.amazonaws.com` (DescribeCluster `endpoint`). */
  apiServerEndpoint: string;
  /** The cluster CA, base64 PEM (DescribeCluster `certificateAuthority.data`). */
  certificateAuthority: string;
  /** The cluster's service CIDR (DescribeCluster `kubernetesNetworkConfig.serviceIpv4Cidr` or `serviceIpv6Cidr`). */
  cidr: string;
}

/** `k8s-join` settings of mode `eks`, as `resolveHostConfig` returns them. */
export interface EksJoinSettings {
  mode: 'eks';
  cluster: EksJoinCluster;
  nodeLabels?: Readonly<Record<string, string>>;
  taints?: readonly string[];
  gpu?: boolean;
  gpuApi?: 'device-plugin' | 'dra';
}

const eksClusterName = /^[0-9A-Za-z][A-Za-z0-9_-]{0,99}$/;
const base64Text = /^[A-Za-z0-9+/]{1,16384}={0,2}$/;
const hostName = /^[A-Za-z0-9](?:[-A-Za-z0-9.]{0,251}[A-Za-z0-9])?$/;

function isCidrText(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(value);
  if (v4) return v4.slice(1, 5).every((octet) => Number(octet) <= 255) && Number(v4[5]) <= 32;
  const v6 = /^([0-9a-fA-F:]{2,39})\/(\d{1,3})$/.exec(value);
  return !!v6 && v6[1]!.includes(':') && Number(v6[2]) <= 128;
}

/** Validates an EKS cluster for nodeadm; every value is one plain token, so none can add YAML. */
export function checkEksCluster(value: unknown, what = 'cluster'): Record<string, Json> {
  const bad = (message: string): never => {
    throw new ComputeError('INVALID_INPUT', `${what}.${message}`);
  };
  if (!isRecord(value)) return bad('must be an object { name, apiServerEndpoint, certificateAuthority, cidr }');
  const allowed = ['name', 'apiServerEndpoint', 'certificateAuthority', 'cidr'];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) bad(`${key} is not a setting (${allowed.join(', ')})`);
  const { name, apiServerEndpoint, certificateAuthority, cidr } = value;
  if (typeof name !== 'string' || !eksClusterName.test(name)) bad('name must be an EKS cluster name (letters, digits, - and _, at most 100)');
  let url: URL | undefined;
  try {
    url = typeof apiServerEndpoint === 'string' ? new URL(apiServerEndpoint) : undefined;
  } catch {
    url = undefined;
  }
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !hostName.test(url.hostname) ||
    (apiServerEndpoint as string).replace(/\/$/, '').toLowerCase() !== url.origin
  )
    bad('apiServerEndpoint must be the cluster endpoint as https://host');
  if (typeof certificateAuthority !== 'string' || !base64Text.test(certificateAuthority))
    bad('certificateAuthority must be the cluster CA as base64 PEM (DescribeCluster certificateAuthority.data)');
  const pem = Buffer.from(certificateAuthority as string, 'base64').toString('utf8');
  if (!pem.includes('-----BEGIN CERTIFICATE-----') || !pem.includes('-----END CERTIFICATE-----'))
    bad('certificateAuthority must decode to a PEM certificate');
  if (!isCidrText(cidr)) bad('cidr must be the cluster service CIDR (172.20.0.0/16)');
  return {
    name: name as string,
    // As DescribeCluster wrote it: EKS endpoints carry an upper-case id, which TLS and DNS ignore.
    apiServerEndpoint: (apiServerEndpoint as string).replace(/\/$/, ''),
    certificateAuthority: certificateAuthority as string,
    cidr: cidr as string,
  };
}

/**
 * nodeadm's `NodeConfig` (`node.eks.aws/v1alpha1`) for a node of an AL2023 EKS AMI (`eks-al2023-<k8s>`):
 * the cluster, and the node's labels and taints as kubelet flags. Settings are validated as `resolveHostConfig`
 * validates them; every value is written as a JSON string (valid YAML), so none can add keys.
 */
export function eksNodeConfig(settings: EksJoinSettings): string {
  const valid = validateK8sJoin({ ...(settings as unknown as Record<string, Json>), mode: 'eks' });
  const cluster = valid.cluster as unknown as EksJoinCluster;
  const q = (text: string) => JSON.stringify(text);
  const lines = [
    '---',
    'apiVersion: node.eks.aws/v1alpha1',
    'kind: NodeConfig',
    'spec:',
    '  cluster:',
    `    name: ${q(cluster.name)}`,
    `    apiServerEndpoint: ${q(cluster.apiServerEndpoint)}`,
    `    certificateAuthority: ${q(cluster.certificateAuthority)}`,
    `    cidr: ${q(cluster.cidr)}`,
  ];
  const flags: string[] = [];
  const labels = Object.entries((valid.nodeLabels ?? {}) as Record<string, string>);
  if (labels.length) flags.push(`--node-labels=${labels.map(([key, value]) => `${key}=${value}`).join(',')}`);
  const taints = (valid.taints ?? []) as string[];
  if (taints.length) flags.push(`--register-with-taints=${taints.join(',')}`);
  if (flags.length) lines.push('  kubelet:', '    flags:', ...flags.map((flag) => `      - ${q(flag)}`));
  return `${lines.join('\n')}\n`;
}

function userDataPartType(payload: string): string {
  if (payload.startsWith('#cloud-config')) return 'text/cloud-config';
  if (payload.startsWith('#!')) return 'text/x-shellscript';
  if (payload.startsWith('#cloud-boothook')) return 'text/cloud-boothook';
  return 'text/plain';
}

/**
 * EC2 user data for an EKS node: a MIME multipart whose first part is the NodeConfig
 * (`application/node.eks.aws`, which nodeadm reads) and whose second is `userData` (cloud-init: bcd's own
 * install and join), when there is one. The boundary derives from the content, so the same input packs to
 * the same bytes. A multipart `userData` is refused (nodeadm and cloud-init read one level).
 */
export function eksUserData(settings: EksJoinSettings, userData: string): string {
  if (/^\s*(MIME-Version:|Content-Type:\s*multipart\/)/i.test(userData))
    throw new ComputeError('INVALID_INPUT', 'eksUserData: the user data is already a MIME multipart; pass its single document');
  const nodeConfig = eksNodeConfig(settings);
  const boundary = `bc-eks-${createHash('sha256').update(nodeConfig).update('\0').update(userData).digest('hex').slice(0, 32)}`;
  const part = (type: string, body: string) =>
    `--${boundary}\nContent-Type: ${type}; charset="utf-8"\nMIME-Version: 1.0\nContent-Transfer-Encoding: 7bit\n\n${body}${body.endsWith('\n') ? '' : '\n'}`;
  return (
    `MIME-Version: 1.0\nContent-Type: multipart/mixed; boundary="${boundary}"\n\n` +
    part('application/node.eks.aws', nodeConfig) +
    (userData === '' ? '' : part(userDataPartType(userData), userData)) +
    `--${boundary}--\n`
  );
}
