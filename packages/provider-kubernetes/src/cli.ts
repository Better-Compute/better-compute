import { createHash, createPublicKey } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ComputeError, parseDuration } from '@better-compute/core';
import {
  bcdDaemonSetManifests,
  gpuIsolationRequirements,
  renderKubernetesManifests,
  type BcdDaemonSetOptions,
  type BcdPins,
  type KubernetesObject,
} from './daemonset.js';

// `better-compute kubernetes manifest` (PLAN.md §3.8), shipped with the provider: the CLI never imports a
// provider (PLAN §4.3), so an application that uses this one adds the command to its configuration:
//
//   import { kubernetesManifestCommand } from '@better-compute/provider-kubernetes';
//   export const commands = [kubernetesManifestCommand()];
//
// It renders everything `kubectl apply -f` needs to run bcd as a DaemonSet on a cluster a pool adopts: it
// mints a multi-use `hosted: 'kubernetes'` join token, reads the gateway, its pins and the join key from
// the control plane's well-known document, and renders bcdDaemonSetManifests. The token only ever goes to
// a new 0600 file, as the Secret manifest (never the output).

/** The part of the CLI's command context this command uses (better-compute/cli `CommandContext`). */
export interface ManifestCommandContext {
  flags: Record<string, string | number | boolean | undefined>;
  path(value: string): string;
  note(message: string): void;
  io: { out(message: string): void };
  api(): Promise<{ call<T = unknown>(path: string, input?: Record<string, unknown>): Promise<T> }>;
  compute(): Promise<{
    handler(request: Request): Promise<Response>;
    endpoint: { basePath: string };
  }>;
}

interface WellKnown {
  gateway?: { url: string; serverName?: string; servingCaPin?: string };
  join?: { encryptionJwk: Record<string, string>; encryptionKeyPin: string; signingKeyPin: string };
}

const wellKnownPath = '/.well-known/better-compute';

const usage = (message: string) => new ComputeError('INVALID_INPUT', message);

/** The well-known document: from --control-plane over https, or in process from the configured deployment. */
async function readWellKnown(
  context: ManifestCommandContext,
  controlPlane: string | undefined,
  fetcher: typeof fetch,
): Promise<WellKnown> {
  let response: Response;
  if (controlPlane) {
    let url: URL;
    try {
      url = new URL(controlPlane);
    } catch {
      throw usage(
        `--control-plane ${controlPlane}: the API's https URL, e.g. https://compute.example.com/api/compute`,
      );
    }
    if (url.protocol !== 'https:' || url.username || url.password)
      throw usage('--control-plane must be an https URL without credentials');
    response = await fetcher(`${url.href.replace(/\/$/, '')}${wellKnownPath}`);
  } else {
    const compute = await context.compute();
    response = await compute.handler(
      new Request(`http://localhost${compute.endpoint.basePath}${wellKnownPath}`),
    );
  }
  if (!response.ok)
    throw new ComputeError(
      'UNAVAILABLE',
      `The control plane's well-known document answered ${response.status}`,
    );
  return (await response.json()) as WellKnown;
}

async function writeNew(file: string, content: string, mode: number): Promise<void> {
  try {
    await writeFile(file, content, { mode, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new ComputeError('CONFLICT', `${file} exists; it is never written over`);
    throw error;
  }
}

/** `k=v,k2=v2` → an object. */
function pairs(value: string, flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const at = item.indexOf('=');
    if (at <= 0) throw usage(`--${flag} ${item}: key=value`);
    out[item.slice(0, at)] = item.slice(at + 1);
  }
  return out;
}

/** The `sha256/<base64>` SPKI pin of a public JWK; "" when it is not one. */
function joinKeyPin(jwk: Record<string, string>): string {
  try {
    const der = createPublicKey({
      key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
      format: 'jwk',
    }).export({ type: 'spki', format: 'der' });
    return `sha256/${createHash('sha256').update(der).digest('base64')}`;
  } catch {
    return '';
  }
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

/**
 * The `kubernetes manifest` command, as a better-compute CLI CommandSpec (structural: this package does not
 * depend on the CLI). `fetch` is for tests.
 */
export function kubernetesManifestCommand(
  options: {
    fetch?: typeof fetch;
    /**
     * The trust anchors, from the application's own PKI bundle (`readPkiPins` of @better-compute/pki), for
     * a command that needs no pin flags. Never taken from the control plane: whoever answers its well-known
     * document would pin themselves.
     */
    pins?: BcdPins;
  } = {},
) {
  const fetcher = options.fetch ?? fetch;
  return {
    name: 'kubernetes manifest',
    group: 'Nodes',
    summary: 'Render the manifests that run bcd as a DaemonSet on a cluster a pool adopts',
    description:
      "kubernetes manifest renders what `kubectl apply -f` needs for bcd on every node of an existing Kubernetes cluster: a Namespace, bcd's ConfigMap and the DaemonSet, pointed at the gateway and join key of the control plane's well-known document (from --control-plane, else the configured deployment) and pinned to the anchors the operator gives out of band: --serving-ca-pin, --join-signing-pin and --join-encryption-pin (the PKI bundle's pins, pki show on the control-plane host), never the document's own (whoever answered it would pin themselves). The join key is checked against --join-encryption-pin. It mints a join token for --pool with hosted kubernetes (--max-uses nodes, valid for --ttl) and writes it, as the Secret the DaemonSet's join container reads, to --secret-out: a new file (0600), never the output. Apply the Secret first, then the manifests. Decided as compute:join-tokens:create.",
    target: 'token' as const,
    flags: {
      tenant: {
        type: 'string' as const,
        value: 'ID',
        env: 'BETTER_COMPUTE_TENANT',
        required: true,
        description: 'The tenant that owns the pool',
      },
      pool: {
        type: 'string' as const,
        value: 'ID',
        required: true,
        description: "The pool the cluster's nodes join",
      },
      image: {
        type: 'string' as const,
        value: 'REF',
        required: true,
        description: 'The bcd image, pinned by digest (registry/repo[:tag]@sha256:…)',
      },
      'secret-out': {
        type: 'string' as const,
        value: 'PATH',
        required: true,
        description: 'A new file (0600) for the join token Secret manifest',
      },
      out: {
        type: 'string' as const,
        value: 'PATH',
        description: 'Write the manifests to this new file instead of the output',
      },
      'control-plane': {
        type: 'string' as const,
        value: 'URL',
        description:
          "The API's public https URL; bcd fetches the pinned join key there too (default: the configuration)",
      },
      'serving-ca-pin': {
        type: 'string' as const,
        value: 'PIN',
        env: 'BCD_SERVING_CA_PIN',
        description:
          "The gateway serving CA's sha256/… pin, from the PKI bundle (pki show), never the network",
      },
      'join-signing-pin': {
        type: 'string' as const,
        value: 'PIN',
        env: 'BCD_JOIN_SIGNING_PIN',
        description: "The JoinService signing key's sha256/… pin, from the PKI bundle",
      },
      'join-encryption-pin': {
        type: 'string' as const,
        value: 'PIN',
        env: 'BCD_JOIN_ENCRYPTION_PIN',
        description: "The JoinService encryption key's sha256/… pin, from the PKI bundle",
      },
      namespace: { type: 'string' as const, value: 'NAME', description: 'Default bcd-system' },
      name: { type: 'string' as const, value: 'NAME', description: 'The DaemonSet (default bcd)' },
      'node-selector': {
        type: 'string' as const,
        value: 'K=V,…',
        description: 'Only these nodes, e.g. nvidia.com/gpu.present=true',
      },
      'host-units': {
        type: 'boolean' as const,
        description:
          "Let bcd apply NodeSpec.host units (default: the cluster's tooling owns the host)",
      },
      'gpu-api': {
        type: 'string' as const,
        value: 'API',
        choices: ['device-plugin', 'dra'],
        description:
          'How bcd offers the GPUs compute binds to the kubelet (default device-plugin; dra needs resource.k8s.io)',
      },
      'container-runtime': {
        type: 'string' as const,
        value: 'RUNTIME',
        choices: ['containerd', 'k3s', 'rke2', 'cri-o'],
        description:
          "The nodes' container runtime, whose config bcd reads (read-only) to rule out other paths to the GPUs (default containerd)",
      },
      'nvidia-toolkit': {
        type: 'string' as const,
        value: 'INSTALL',
        choices: ['gpu-operator', 'packages'],
        description:
          "Where the NVIDIA container toolkit's config lives: the GPU operator's /usr/local/nvidia/toolkit/.config or the packages' /etc/nvidia-container-runtime (default gpu-operator)",
      },
      'nvidia-runtime-class': {
        type: 'string' as const,
        value: 'NAME',
        description:
          "The RuntimeClass bcd's own container runs under to read the GPUs with nvidia-smi (default nvidia; none for no RuntimeClass)",
      },
      ttl: {
        type: 'string' as const,
        value: 'DURATION',
        description: 'How long the token admits nodes (default 24h, at most 24h)',
      },
      'max-uses': {
        type: 'integer' as const,
        value: 'N',
        min: 1,
        max: 10000,
        description: 'Nodes it admits (default 100)',
      },
      key: {
        type: 'string' as const,
        value: 'KEY',
        description: 'Idempotency key of the token, to retry the same request',
      },
    },
    examples: [
      'better-compute kubernetes manifest --pool pool_… --image ghcr.io/acme/bcd:0.5.0@sha256:… --control-plane https://compute.example.com/api/compute --secret-out ./bcd-join.json --out ./bcd.json',
      'kubectl apply -f ./bcd-join.json && kubectl apply -f ./bcd.json',
    ],
    async run(context: ManifestCommandContext) {
      const { flags } = context;
      const tenantId = text(flags.tenant);
      const poolId = text(flags.pool);
      const image = text(flags.image);
      const secretOut = text(flags['secret-out']);
      if (!tenantId || !poolId || !image || !secretOut)
        throw usage('--tenant, --pool, --image and --secret-out are required');
      let ttlSeconds = 86_400;
      if (text(flags.ttl)) {
        let ms: number;
        try {
          ms = parseDuration(flags.ttl as string);
        } catch {
          throw usage(`--ttl ${flags.ttl}: a duration like 2h`);
        }
        if (ms < 60_000 || ms > 86_400_000 || ms % 1000 !== 0)
          throw usage('--ttl must be whole seconds from 1m to 24h');
        ttlSeconds = ms / 1000;
      }
      // The trust anchors come from the operator (or the application's bundle), all three or none.
      const given = [
        flags['serving-ca-pin'],
        flags['join-signing-pin'],
        flags['join-encryption-pin'],
      ].map(text);
      if (given.some(Boolean) && !given.every(Boolean))
        throw usage('--serving-ca-pin, --join-signing-pin and --join-encryption-pin go together');
      const pins: BcdPins | undefined = given.every(Boolean)
        ? { servingCaPin: given[0]!, joinSigningPin: given[1]!, joinEncryptionPin: given[2]! }
        : options.pins;
      if (!pins)
        throw usage(
          'The pins must come from you, not the control plane: pass --serving-ca-pin, --join-signing-pin and --join-encryption-pin (better-compute pki show on the control-plane host prints them)',
        );
      const controlPlane = text(flags['control-plane']);
      const known = await readWellKnown(context, controlPlane, fetcher);
      const gateway = known.gateway;
      if (!gateway?.url)
        throw new ComputeError(
          'INVALID_STATE',
          "The control plane's well-known document has no gateway: set gateway.url, as `bcd join --server` needs too",
        );
      if (!known.join)
        throw new ComputeError(
          'INVALID_STATE',
          "The control plane's well-known document has no join keys: configure pki.join with public keys",
        );
      // bcd pins the join key too, but a mismatch would only surface as failed joins on every node.
      if (joinKeyPin(known.join.encryptionJwk) !== pins.joinEncryptionPin)
        throw new ComputeError(
          'INVALID_STATE',
          "The control plane's join encryption key does not match --join-encryption-pin: check the pin (pki show) and that --control-plane is the right deployment",
        );
      const api = await context.api();
      const pool = await api.call<{ siteId: string }>('pools/get', { tenantId, poolId });
      const namespace = text(flags.namespace) ?? 'bcd-system';
      const name = text(flags.name) ?? 'bcd';
      const secretName = `${name}-join-token`;
      const daemonSet: BcdDaemonSetOptions = {
        image,
        gatewayUrl: gateway.url,
        siteId: pool.siteId,
        pins,
        // Data, not trust: bcdDaemonSetManifests checks it against pins.joinEncryptionPin.
        joinEncryptionJwk: JSON.stringify(known.join.encryptionJwk),
        ...(controlPlane ? { controlPlaneUrl: controlPlane } : {}),
        joinTokenSecret: { name: secretName },
        namespace,
        name,
        ...(text(flags['node-selector'])
          ? { nodeSelector: pairs(flags['node-selector'] as string, 'node-selector') }
          : {}),
        ...(flags['host-units'] === true ? { hostUnits: true } : {}),
        ...(flags['gpu-api'] === 'dra' || flags['gpu-api'] === 'device-plugin'
          ? { gpuApi: flags['gpu-api'] }
          : {}),
        ...(gateway.serverName ? { gatewayServerName: gateway.serverName } : {}),
        ...(text(flags['container-runtime'])
          ? {
              containerRuntime: flags['container-runtime'] as
                | 'containerd'
                | 'k3s'
                | 'rke2'
                | 'cri-o',
            }
          : {}),
        ...(text(flags['nvidia-toolkit'])
          ? { nvidiaToolkit: flags['nvidia-toolkit'] as 'gpu-operator' | 'packages' }
          : {}),
        ...(text(flags['nvidia-runtime-class'])
          ? {
              nvidiaRuntimeClass:
                flags['nvidia-runtime-class'] === 'none'
                  ? null
                  : (flags['nvidia-runtime-class'] as string),
            }
          : {}),
      };
      // Rendered first: a bad image or pin fails before a token exists.
      const manifests = renderKubernetesManifests(bcdDaemonSetManifests(daemonSet));
      const secretFile = context.path(secretOut);
      const created = await api.call<{ id?: string; token?: string; expiresAt?: string | number }>(
        'joinTokens/create',
        {
          tenantId,
          poolId,
          ttlSeconds,
          maxUses: typeof flags['max-uses'] === 'number' ? flags['max-uses'] : 100,
          hosted: 'kubernetes',
          idempotencyKey: text(flags.key) ?? `kubernetes-manifest-${crypto.randomUUID()}`,
        },
      );
      if (typeof created.token !== 'string')
        throw new ComputeError(
          'INVALID_STATE',
          'The answer carries no token: this --key replays an earlier request, and a token is shown only once. Revoke it (join-tokens revoke) and run again without --key.',
        );
      const secret: KubernetesObject = {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: secretName,
          namespace,
          labels: { 'app.kubernetes.io/name': name, 'app.kubernetes.io/component': 'join-token' },
        },
        type: 'Opaque',
        stringData: { token: created.token },
      };
      await writeNew(secretFile, renderKubernetesManifests([secret]), 0o600);
      context.note(
        `Wrote the join token Secret to ${secretFile} (0600); apply it before the manifests.`,
      );
      context.note(
        `Once every node has joined, revoke the token (join-tokens revoke ${created.id ?? '<id>'}) and delete the Secret ${namespace}/${secretName}; a later batch of nodes gets a fresh token. ${gpuIsolationRequirements}`,
      );
      const out = text(flags.out);
      if (!out) {
        context.io.out(manifests);
        return undefined;
      }
      const manifestFile = context.path(out);
      await writeNew(manifestFile, manifests, 0o644);
      context.note(`Wrote the manifests to ${manifestFile}.`);
      return {
        poolId,
        siteId: pool.siteId,
        namespace,
        tokenId: created.id,
        expiresAt: created.expiresAt,
        secretFile,
        manifestFile,
      };
    },
  };
}
