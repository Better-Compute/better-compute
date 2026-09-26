import { createHash } from 'node:crypto';
import { ComputeError } from '@better-compute/core';

// bcd as a Kubernetes DaemonSet (PLAN.md §3.8, [595a2f] decision (A)): a pool adopts the nodes of an existing
// cluster. Each node's bcd joins with a `hosted: 'kubernetes'` join token from a Secret (JoinService lands it
// at `tenant-controlled` unless the pool is `platformOperated`), keeps its identity in a hostPath data
// directory across pod restarts, and hands the GPUs compute binds with `binding: 'kubernetes'` to the kubelet
// through its device plugin. Compute never schedules pods: it books devices; the cluster runs the workloads.
//
// The manifests are plain objects (`bcdDaemonSetManifests`), rendered as one `v1 List` in JSON
// (`renderKubernetesManifests`), which `kubectl apply -f` takes as it takes YAML.

/** One Kubernetes object, as `kubectl apply` takes it. */
export interface KubernetesObject {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  [field: string]: unknown;
}

/** A pod toleration (core/v1 Toleration). */
export interface Toleration {
  key?: string;
  operator?: 'Exists' | 'Equal';
  value?: string;
  effect?: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';
  tolerationSeconds?: number;
}

/** The three pins a bcd joining without an installed configuration needs (pki `bootstrapPins`). */
export interface BcdPins {
  servingCaPin: string;
  joinSigningPin: string;
  joinEncryptionPin: string;
}

export interface BcdDaemonSetOptions {
  /** The bcd image, pinned by digest: `registry/repo[:tag]@sha256:<64 hex>`. */
  image: string;
  /** The regional gateway bcd dials, `https://host[:port]`. */
  gatewayUrl: string;
  /** The site of the pool whose join token the Secret holds. */
  siteId: string;
  pins: BcdPins;
  /**
   * The JoinService encryption key (a P-256 JWK, JSON) bcd seals the join token to; checked against
   * `pins.joinEncryptionPin`. Or, instead, `controlPlaneUrl`: bcd then fetches it from the control plane's
   * well-known document at join time (pinned just the same). One of the two is required.
   */
  joinEncryptionJwk?: string;
  /** The control plane's public URL (`https://…/api/compute`), for the well-known join key. */
  controlPlaneUrl?: string;
  /**
   * The Secret holding a multi-use join token created with `hosted: 'kubernetes'` for the pool (one use per
   * node). Only the join init container mounts it.
   */
  joinTokenSecret: { name: string; key?: string };
  /** Default `bcd-system`. */
  namespace?: string;
  /** The DaemonSet's name, and its ConfigMap's prefix (default `bcd`). */
  name?: string;
  /** Emit the Namespace too (default true). */
  createNamespace?: boolean;
  /** Only these nodes (e.g. `{ 'nvidia.com/gpu.present': 'true' }`); default every node. */
  nodeSelector?: Readonly<Record<string, string>>;
  /** Default: tolerate every taint, as node agents do. */
  tolerations?: readonly Toleration[];
  /** Default `system-node-critical`; `null` for none. */
  priorityClassName?: string | null;
  imagePullSecrets?: readonly string[];
  /** Default requests 100m CPU and 128Mi, a 512Mi memory limit. */
  resources?: { requests?: { cpu?: string; memory?: string }; limits?: { cpu?: string; memory?: string } };
  /**
   * Let bcd apply NodeSpec.host units (drivers, MIG, hugepages, sysctls) on the cluster's nodes. Default false
   * (`[host] units = false`): the cluster's own tooling, e.g. the NVIDIA GPU operator, owns the host.
   */
  hostUnits?: boolean;
  /** The name the gateway certificate carries, when it differs from the gatewayUrl host. */
  gatewayServerName?: string;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  /**
   * How bound GPUs reach pods: bcd's device plugins (`bcd.dev/gpu`, the default) or its DRA driver
   * (`gpu.bcd.dev`, needs resource.k8s.io on the API server). A node runs one, never both.
   */
  gpuApi?: 'device-plugin' | 'dra';
  /**
   * The RuntimeClass that injects the NVIDIA driver's libraries and `nvidia-smi` into bcd's own container
   * (default `nvidia`, which the GPU operator creates): bcd reads and resets GPUs through them. `null`
   * when the image carries the driver's user space itself. bcd's container asks for every GPU with the
   * `utility` capability only, which the runtime grants a privileged container even with
   * accept-nvidia-visible-devices-envvar-when-unprivileged=false; workload pods still get CDI devices only.
   */
  nvidiaRuntimeClass?: string | null;
}

const dns1123Label = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const dns1123Subdomain = /^(?=.{1,253}$)[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?)*$/;
const imageRef = /^[a-z0-9][a-z0-9._\-/:]{0,254}@sha256:[0-9a-f]{64}$/;
const pin = /^sha256\/[A-Za-z0-9+/]{43}=$/;
const siteIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const quantity = /^[0-9]+(?:\.[0-9]+)?(?:m|Ki|Mi|Gi|Ti|k|M|G|T)?$/;
const labelKey = /^(?:[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?\/)?[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
const labelValue = /^(?:[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?)?$/;

function invalid(message: string): never {
  throw new ComputeError('INVALID_CONFIG', `bcdDaemonSetManifests: ${message}`);
}

/** The gateway as bcd's config.toml wants it: an https origin. */
function httpsOrigin(value: string, what: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid(`${what} must be an https URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== ''))
    invalid(`${what} must be https://host[:port]`);
  return url.origin;
}

/** The control plane's URL for `bcd join --server`: https, no credentials, query or fragment. */
function controlPlane(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid('controlPlaneUrl must be an https URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    invalid('controlPlaneUrl must be https://host[:port][/path]');
  return url.href.replace(/\/$/, '');
}

/** A TOML basic string; the values are validated to plain characters first, so this only guards. */
const tomlString = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** bcd's /etc/bcd/config.toml for a node of the pool (daemon/internal/config's subset of TOML). */
export function bcdConfigToml(
  options: Pick<BcdDaemonSetOptions, 'gatewayUrl' | 'siteId' | 'pins' | 'hostUnits' | 'gatewayServerName' | 'logLevel' | 'gpuApi'>,
): string {
  if (options.gpuApi !== undefined && options.gpuApi !== 'device-plugin' && options.gpuApi !== 'dra') invalid('gpuApi must be device-plugin or dra');
  const gateway = httpsOrigin(options.gatewayUrl, 'gatewayUrl');
  if (!siteIdPattern.test(options.siteId)) invalid('siteId must be a site id');
  for (const name of ['servingCaPin', 'joinSigningPin', 'joinEncryptionPin'] as const)
    if (typeof options.pins?.[name] !== 'string' || !pin.test(options.pins[name])) invalid(`pins.${name} must be sha256/<base64 of 32 bytes>`);
  if (options.gatewayServerName !== undefined && !dns1123Subdomain.test(options.gatewayServerName)) invalid('gatewayServerName must be a DNS name');
  const lines = [
    '# Written by @better-compute/provider-kubernetes: bcd as a DaemonSet. Never holds the join token.',
    `gateway_url = ${tomlString(gateway)}`,
    `site = ${tomlString(options.siteId)}`,
    `serving_ca_spki_pin = ${tomlString(options.pins.servingCaPin)}`,
    `join_signing_key_pin = ${tomlString(options.pins.joinSigningPin)}`,
    `join_encryption_key_pin = ${tomlString(options.pins.joinEncryptionPin)}`,
    `data_dir = ${tomlString(dataDir)}`,
    ...(options.gatewayServerName ? [`gateway_server_name = ${tomlString(options.gatewayServerName)}`] : []),
    '',
    '[log]',
    `level = ${tomlString(options.logLevel ?? 'info')}`,
    'json = true',
    '',
    '[host]',
    // The cluster's own tooling owns drivers, MIG and kernel settings unless the pool says otherwise.
    `units = ${options.hostUnits === true ? 'true' : 'false'}`,
    '',
    ...(options.gpuApi ? ['[kubernetes]', `gpu_api = ${tomlString(options.gpuApi)}`, ''] : []),
  ];
  return lines.join('\n');
}

/**
 * What the cluster must be for bcd to give pods only the GPUs compute bound (README "GPU isolation"): the
 * DaemonSet carries it as `bcd.dev/requires`, since JSON manifests have no comments.
 */
export const gpuIsolationRequirements =
  'bcd must be the only source of GPUs on these nodes. NVIDIA GPU operator: devicePlugin.enabled=false; container toolkit ' +
  'accept-nvidia-visible-devices-envvar-when-unprivileged=false (CDI only); CDI --device-name-strategy=uuid. Workload namespaces: ' +
  'Pod Security baseline or restricted (no hostPath: /var/lib/bcd holds the node key). Revoke the join token and delete its Secret ' +
  'once every node has joined.';

/**
 * Where the NVIDIA container toolkit keeps its config.toml: the distribution packages', and the GPU
 * operator's. bcd reads either (9f860ad) to refuse a toolkit that hands GPUs out by environment variable.
 */
export const nvidiaToolkitConfigDirs = ['/etc/nvidia-container-runtime', '/usr/local/nvidia/toolkit/.config/nvidia-container-runtime'] as const;

const dataDir = '/var/lib/bcd';
const configPath = '/etc/bcd/config.toml';
const tokenDir = '/etc/bcd/token';
const bcdBinary = '/usr/local/bin/bcd';
/** bcd join's name for the JoinService encryption key beside config.toml (daemon/cmd/bcd joinKeyFile). */
const joinKeyFile = 'join-encryption.jwk';

/**
 * The objects that run bcd on every (selected) node of a cluster: the Namespace, a ConfigMap with
 * config.toml, and the DaemonSet. Deterministic: the same options give the same objects.
 *
 * The pod:
 * - a `join` init container: `bcd join` with the token Secret mounted read-only, unprivileged, no
 *   capabilities. On a node that joined before it succeeds without spending anything;
 * - the `bcd` container: `bcd node`, privileged (devices, cgroups, CDI specs, the kubelet's device-plugin
 *   socket), with the kubelet's credentials read-only for its own Node's `bcd.dev/*` labels. It never sees
 *   the token;
 * - no service account token (bcd needs no Kubernetes API access of its own), host networking;
 * - identity and journal in the hostPath /var/lib/bcd, so a restarted pod is the same node.
 */
export function bcdDaemonSetManifests(options: BcdDaemonSetOptions): KubernetesObject[] {
  if (typeof options.image !== 'string' || !imageRef.test(options.image))
    invalid('image must be pinned by digest: registry/repo[:tag]@sha256:<64 hex>');
  const namespace = options.namespace ?? 'bcd-system';
  const name = options.name ?? 'bcd';
  if (!dns1123Label.test(namespace)) invalid('namespace must be a DNS-1123 label');
  if (!dns1123Label.test(name) || name.length > 40) invalid('name must be a DNS-1123 label of at most 40 characters');
  const secretName = options.joinTokenSecret?.name;
  const secretKey = options.joinTokenSecret?.key ?? 'token';
  if (typeof secretName !== 'string' || !dns1123Subdomain.test(secretName)) invalid('joinTokenSecret.name must be a Secret name');
  if (!/^[-._A-Za-z0-9]{1,253}$/.test(secretKey)) invalid('joinTokenSecret.key must be a Secret key');
  for (const [key, value] of Object.entries(options.nodeSelector ?? {}))
    if (!labelKey.test(key) || typeof value !== 'string' || !labelValue.test(value)) invalid(`nodeSelector ${key}=${String(value)} is not a label selector`);
  for (const secret of options.imagePullSecrets ?? []) if (!dns1123Subdomain.test(secret)) invalid(`imagePullSecrets: ${secret} is not a Secret name`);
  const priorityClassName = options.priorityClassName === undefined ? 'system-node-critical' : options.priorityClassName;
  if (priorityClassName !== null && !dns1123Subdomain.test(priorityClassName)) invalid('priorityClassName must be a PriorityClass name');
  const runtimeClassName = options.nvidiaRuntimeClass === undefined ? 'nvidia' : options.nvidiaRuntimeClass;
  if (runtimeClassName !== null && !dns1123Subdomain.test(runtimeClassName)) invalid('nvidiaRuntimeClass must be a RuntimeClass name');
  const resources = {
    requests: { cpu: '100m', memory: '128Mi', ...options.resources?.requests },
    limits: { memory: '512Mi', ...options.resources?.limits },
  };
  for (const [kind, values] of Object.entries(resources))
    for (const [resource, value] of Object.entries(values))
      if (typeof value !== 'string' || !quantity.test(value)) invalid(`resources.${kind}.${resource} must be a quantity such as 100m or 128Mi`);
  const config = bcdConfigToml(options);
  let jwk: string | undefined;
  if (options.joinEncryptionJwk !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(options.joinEncryptionJwk);
    } catch {
      parsed = undefined;
    }
    const key = parsed as { kty?: unknown; crv?: unknown; x?: unknown; y?: unknown; d?: unknown } | undefined;
    if (!key || key.kty !== 'EC' || key.crv !== 'P-256' || typeof key.x !== 'string' || typeof key.y !== 'string')
      invalid('joinEncryptionJwk must be the JoinService encryption key as a P-256 public JWK');
    if (key!.d !== undefined) invalid('joinEncryptionJwk must be the public key only (it has "d")');
    jwk = JSON.stringify({ kty: 'EC', crv: 'P-256', x: key!.x, y: key!.y });
  }
  const server = options.controlPlaneUrl !== undefined ? controlPlane(options.controlPlaneUrl) : undefined;
  if (!jwk && !server) invalid('give joinEncryptionJwk or controlPlaneUrl: bcd join needs the JoinService encryption key');
  const configSha256 = createHash('sha256')
    .update(config)
    .update(jwk ?? '')
    .digest('hex');

  const labels = { 'app.kubernetes.io/name': 'bcd', 'app.kubernetes.io/instance': name, 'app.kubernetes.io/part-of': 'better-compute' };
  const selector = { 'app.kubernetes.io/name': 'bcd', 'app.kubernetes.io/instance': name };
  const hostPath = (volume: string, path: string, type: string) => ({ name: volume, hostPath: { path, type } });
  const mount = (volume: string, mountPath: string, readOnly = false, subPath?: string) => ({
    name: volume,
    mountPath,
    ...(readOnly ? { readOnly: true } : {}),
    ...(subPath ? { subPath } : {}),
  });
  const configMount = mount('config', configPath, true, 'config.toml');
  const objects: KubernetesObject[] = [];
  if (options.createNamespace !== false)
    objects.push({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: namespace,
        // bcd's pod is privileged with host paths: its own namespace allows that; workload namespaces must not.
        labels: { 'app.kubernetes.io/part-of': 'better-compute', 'pod-security.kubernetes.io/enforce': 'privileged' },
      },
    });
  objects.push({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: `${name}-config`, namespace, labels },
    data: { 'config.toml': config, ...(jwk ? { [joinKeyFile]: jwk } : {}) },
  });
  objects.push({
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: { name, namespace, labels, annotations: { 'bcd.dev/requires': gpuIsolationRequirements } },
    spec: {
      selector: { matchLabels: selector },
      updateStrategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 1 } },
      template: {
        metadata: {
          labels,
          // A changed configuration rolls the pods.
          annotations: { 'bcd.dev/config-sha256': configSha256 },
        },
        spec: {
          hostNetwork: true,
          dnsPolicy: 'ClusterFirstWithHostNet',
          hostPID: false,
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          terminationGracePeriodSeconds: 30,
          ...(priorityClassName !== null ? { priorityClassName } : {}),
          ...(runtimeClassName !== null ? { runtimeClassName } : {}),
          ...(options.nodeSelector && Object.keys(options.nodeSelector).length ? { nodeSelector: { ...options.nodeSelector } } : {}),
          tolerations: options.tolerations ? options.tolerations.map((toleration) => ({ ...toleration })) : [{ operator: 'Exists' }],
          ...(options.imagePullSecrets?.length ? { imagePullSecrets: options.imagePullSecrets.map((secret) => ({ name: secret })) } : {}),
          initContainers: [
            {
              name: 'join',
              image: options.image,
              imagePullPolicy: 'IfNotPresent',
              command: [bcdBinary, 'join', '--config', configPath, '--token-file', `${tokenDir}/token`, ...(server ? ['--server', server] : [])],
              // Root for the root-owned hostPath data directory, but no capabilities at all.
              securityContext: {
                runAsUser: 0,
                privileged: false,
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              resources,
              volumeMounts: [
                configMount,
                // bcd join reads the key next to config.toml.
                ...(jwk ? [mount('config', `/etc/bcd/${joinKeyFile}`, true, joinKeyFile)] : []),
                mount('join-token', tokenDir, true),
                mount('data', dataDir),
              ],
            },
          ],
          containers: [
            {
              name: 'bcd',
              image: options.image,
              imagePullPolicy: 'IfNotPresent',
              command: [bcdBinary, 'node', '--config', configPath],
              env: [
                { name: 'NODE_NAME', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } },
                // bcd itself reads and resets every GPU (nvidia-smi, NVML): the driver's utilities only.
                ...(runtimeClassName !== null
                  ? [
                      { name: 'NVIDIA_VISIBLE_DEVICES', value: 'all' },
                      { name: 'NVIDIA_DRIVER_CAPABILITIES', value: 'utility' },
                    ]
                  : []),
              ],
              securityContext: { runAsUser: 0, privileged: true, readOnlyRootFilesystem: true },
              resources,
              livenessProbe: { exec: { command: [bcdBinary, 'status'] }, initialDelaySeconds: 30, periodSeconds: 60, failureThreshold: 5 },
              volumeMounts: [
                configMount,
                mount('data', dataDir),
                mount('run', '/run/bcd'),
                mount('tmp', '/tmp'),
                mount('dev', '/dev'),
                mount('sys', '/sys'),
                mount('kubelet', '/var/lib/kubelet'),
                mount('kubernetes', '/etc/kubernetes', true),
                mount('cdi-etc', '/etc/cdi'),
                mount('cdi-run', '/var/run/cdi'),
                // Read only, so bcd can see a permissive NVIDIA container toolkit (README "GPU isolation").
                mount('nvidia-runtime-etc', nvidiaToolkitConfigDirs[0], true),
                mount('nvidia-runtime-operator', nvidiaToolkitConfigDirs[1], true),
              ],
            },
          ],
          volumes: [
            { name: 'config', configMap: { name: `${name}-config`, defaultMode: 0o400 } },
            { name: 'join-token', secret: { secretName, defaultMode: 0o400, items: [{ key: secretKey, path: 'token' }] } },
            hostPath('data', dataDir, 'DirectoryOrCreate'),
            { name: 'run', emptyDir: { medium: 'Memory' } },
            { name: 'tmp', emptyDir: {} },
            hostPath('dev', '/dev', 'Directory'),
            hostPath('sys', '/sys', 'Directory'),
            hostPath('kubelet', '/var/lib/kubelet', 'Directory'),
            hostPath('kubernetes', '/etc/kubernetes', 'Directory'),
            hostPath('cdi-etc', '/etc/cdi', 'DirectoryOrCreate'),
            hostPath('cdi-run', '/var/run/cdi', 'DirectoryOrCreate'),
            hostPath('nvidia-runtime-etc', nvidiaToolkitConfigDirs[0], 'DirectoryOrCreate'),
            hostPath('nvidia-runtime-operator', nvidiaToolkitConfigDirs[1], 'DirectoryOrCreate'),
          ],
        },
      },
    },
  });
  return objects;
}

/** The objects as one `v1 List`, JSON (valid YAML): `kubectl apply -f bcd.json`. */
export function renderKubernetesManifests(objects: readonly KubernetesObject[]): string {
  return `${JSON.stringify({ apiVersion: 'v1', kind: 'List', items: objects }, null, 2)}\n`;
}
