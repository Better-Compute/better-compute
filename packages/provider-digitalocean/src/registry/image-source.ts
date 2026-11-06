import { createHash } from 'node:crypto';
import {
  ComputeError,
  isSecretRef,
  systemClock,
  type Clock,
  type ErrorCode,
  type ImageCompression,
  type ImageFormat,
  type ImageSource,
  type Logger,
  type ResolvedImage,
  type SecretRef,
  type SecretResolver,
} from '@better-compute/core';
import { budgetFor } from '../client/budget.js';
import { defaultEndpoint } from '../client/build.js';
import { doClient } from '../client/http.js';
import { docrCredentialSource, docrHost, type DocrCredentialSource } from './credentials.js';

// An OCI `ImageSource` for DigitalOcean Container Registry: resolves
// `oci://registry.digitalocean.com/<registry>/<repository>:<tag>` (or `@sha256:…`) to the disk
// image layer of that artifact. The control plane authenticates with short-lived, read-only
// registry credentials; nodes get only the registry's own short-lived presigned blob URL (its
// redirect to storage), and verify the layer digest the resolution returns. No credential ever
// leaves this process, and none goes to a token realm off DigitalOcean's hosts.

const nameComponent = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const referencePattern = new RegExp(
  `^oci://([^/]+)/(${nameComponent}(?:/${nameComponent})+)(?::([A-Za-z0-9_][A-Za-z0-9._-]{0,127}))?(?:@(sha256:[0-9a-f]{64}))?$`,
);
const digestPattern = /^sha256:([0-9a-f]{64})$/;
const maxManifestBytes = 4 * 1024 * 1024;
const manifestTypes = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');
/** `application/vnd.better-compute.disk.<format>[+<compression>]`. */
const diskMediaType = /^application\/vnd\.better-compute\.disk\.(raw|qcow2|iso)(?:\+(zstd|gzip))?$/;
const diskTitle = /\.(raw|img|qcow2|iso)(?:\.(zst|zstd|gz))?$/i;

export interface DocrImageSourceOptions {
  /** A DigitalOcean API token with registry read scope, as a secret reference. */
  token: SecretRef;
  secrets: SecretResolver;
  fetch?: typeof fetch;
  /** The DigitalOcean API; default `https://api.digitalocean.com/v2`. A code-level option. */
  endpoint?: string;
  /** The registry; default `https://registry.digitalocean.com`. A code-level option. */
  registryUrl?: string;
  /** How long each registry credential lasts (120–3600 s). Default 600. */
  expirySeconds?: number;
  clock?: Clock;
  log?: Logger;
}

export interface OciReference {
  host: string;
  /** `<registry>/<repository>`. */
  name: string;
  /** The tag, or the digest. */
  reference: string;
  digest?: string;
}

function registryError(
  code: ErrorCode,
  message: string,
  reason: string,
  extra: Record<string, unknown> = {},
): ComputeError {
  return new ComputeError(code, message, undefined, {
    provider: 'digitalocean',
    service: 'registry',
    reason,
    ...extra,
  });
}

/** Parses an `oci://` reference; a tag or a digest is required (never an implied `latest`). */
export function parseOciReference(ref: string): OciReference {
  const match = referencePattern.exec(ref);
  if (!match || (!match[3] && !match[4]))
    throw registryError(
      'INVALID_INPUT',
      'An image reference is oci://<host>/<registry>/<repository>:<tag> or @sha256:<digest>',
      'ociReference',
    );
  return {
    host: match[1]!,
    name: match[2]!,
    reference: match[4] ?? match[3]!,
    ...(match[4] ? { digest: match[4] } : {}),
  };
}

function statusError(status: number, what: string): ComputeError {
  const code: ErrorCode =
    status === 401
      ? 'INVALID_CONFIG'
      : status === 403
        ? 'ACCESS_DENIED'
        : status === 404
          ? 'NOT_FOUND'
          : status === 429
            ? 'RATE_LIMITED'
            : status >= 500
              ? 'UNAVAILABLE'
              : 'PROVIDER_ERROR';
  return registryError(code, `Registry ${what}: HTTP ${status}`, `http${status}`, {
    status,
    ...(status === 429 ? { retryAfterMs: 1000 } : {}),
  });
}

interface Challenge {
  realm: string;
  service?: string;
  scope?: string;
}

/** The `Bearer` challenge of a 401's `www-authenticate`, or undefined. */
export function parseBearerChallenge(header: string | null): Challenge | undefined {
  if (!header || !/^Bearer\s/i.test(header)) return undefined;
  const params: Record<string, string> = {};
  for (const [, key, value] of header.slice(7).matchAll(/([a-zA-Z]+)="([^"]*)"/g))
    params[key!.toLowerCase()] = value!;
  if (!params.realm) return undefined;
  return {
    realm: params.realm,
    ...(params.service ? { service: params.service } : {}),
    ...(params.scope ? { scope: params.scope } : {}),
  };
}

function formatOf(layer: {
  mediaType?: string;
  annotations?: Record<string, string>;
}): { format: ImageFormat; compression: ImageCompression } | undefined {
  const media = diskMediaType.exec(layer.mediaType ?? '');
  if (media)
    return {
      format: media[1] as ImageFormat,
      compression: (media[2] as ImageCompression | undefined) ?? 'none',
    };
  const title = diskTitle.exec(layer.annotations?.['org.opencontainers.image.title'] ?? '');
  if (!title) return undefined;
  const ext = title[1]!.toLowerCase();
  const comp = title[2]?.toLowerCase();
  return {
    format: ext === 'img' ? 'raw' : (ext as ImageFormat),
    compression: comp === 'gz' ? 'gzip' : comp ? 'zstd' : 'none',
  };
}

export function docrImageSource(options: DocrImageSourceOptions): ImageSource {
  if (!isSecretRef(options.token))
    throw registryError(
      'INVALID_CONFIG',
      'docrImageSource takes the token as a secret reference',
      'secretRef',
    );
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const clock = options.clock ?? systemClock;
  const log: Logger = options.log ?? { debug() {}, info() {}, warn() {}, error() {} };
  const apiEndpoint = options.endpoint ?? defaultEndpoint;
  const registryUrl = new URL(options.registryUrl ?? `https://${docrHost}`);
  // Token realms are trusted only on DigitalOcean's API host and the registry itself.
  const realmHosts = new Set([new URL(apiEndpoint).host, registryUrl.host]);
  const { token, secrets } = options;
  const client = doClient({
    fetch: doFetch,
    endpoint: apiEndpoint,
    token: () => secrets.resolve(token),
    budget: (hash) => budgetFor(hash, { perMinute: 250, perHour: 5000, clock }),
    clock,
    log,
  });
  const credentials: DocrCredentialSource = docrCredentialSource(client, {
    ...(options.expirySeconds !== undefined ? { expirySeconds: options.expirySeconds } : {}),
    clock,
  });
  const bearers = new Map<string, { token: string; expiresAt: number }>();

  async function bearerFor(challenge: Challenge, signal: AbortSignal, retried = false): Promise<string> {
    let realm: URL;
    try {
      realm = new URL(challenge.realm);
    } catch {
      throw registryError('PROVIDER_ERROR', 'The registry named an invalid token realm', 'realm');
    }
    if (realm.protocol !== 'https:' || !realmHosts.has(realm.host))
      throw registryError(
        'PROVIDER_ERROR',
        'The registry named a token realm off DigitalOcean; no credentials were sent',
        'realm',
      );
    if (challenge.service) realm.searchParams.set('service', challenge.service);
    if (challenge.scope) realm.searchParams.set('scope', challenge.scope);
    const pair = await credentials.get(signal);
    const basic = Buffer.from(`${pair.username}:${pair.password}`).toString('base64');
    let response: Response;
    try {
      response = await doFetch(realm.toString(), {
        headers: { authorization: `Basic ${basic}`, accept: 'application/json' },
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw registryError('UNAVAILABLE', 'Registry token service unreachable', 'network');
    }
    if (response.status === 401 && !retried) {
      await response.body?.cancel();
      credentials.forget();
      return bearerFor(challenge, signal, true);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw statusError(response.status, 'token');
    }
    let body: { token?: unknown; access_token?: unknown; expires_in?: unknown };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw registryError('PROVIDER_ERROR', 'The registry token answer is not JSON', 'badBody');
    }
    const value = typeof body.token === 'string' ? body.token : body.access_token;
    if (typeof value !== 'string' || !value)
      throw registryError('PROVIDER_ERROR', 'The registry token answer has no token', 'badBody');
    const seconds = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 60;
    bearers.set(challenge.scope ?? '', {
      token: value,
      expiresAt: clock.now() + Math.max(0, seconds - 10) * 1000,
    });
    return value;
  }

  /** A registry GET with bearer auth (one challenge round), never following redirects. */
  async function registryGet(
    path: string,
    scope: string,
    accept: string,
    signal: AbortSignal,
  ): Promise<Response> {
    const url = new URL(path, registryUrl);
    let challenged = false;
    for (;;) {
      const cached = bearers.get(scope);
      const auth = cached && cached.expiresAt > clock.now() ? cached.token : undefined;
      let response: Response;
      try {
        response = await doFetch(url.toString(), {
          headers: { accept, ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
          redirect: 'manual',
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw registryError('UNAVAILABLE', 'Registry unreachable', 'network');
      }
      if (response.status !== 401 || challenged) return response;
      challenged = true;
      const challenge = parseBearerChallenge(response.headers.get('www-authenticate'));
      await response.body?.cancel();
      if (!challenge) return statusResponse(401);
      bearers.delete(scope);
      await bearerFor({ ...challenge, scope: challenge.scope ?? scope }, signal);
    }
  }

  const statusResponse = (status: number) => new Response(null, { status });

  async function resolve(ref: string): Promise<ResolvedImage> {
    const parsed = parseOciReference(ref);
    if (parsed.host !== registryUrl.host)
      throw registryError(
        'UNSUPPORTED',
        `This image source serves ${registryUrl.host} only`,
        'registryHost',
      );
    const signal = AbortSignal.timeout(30_000);
    const scope = `repository:${parsed.name}:pull`;
    const manifestResponse = await registryGet(
      `/v2/${parsed.name}/manifests/${parsed.reference}`,
      scope,
      manifestTypes,
      signal,
    );
    if (!manifestResponse.ok) {
      await manifestResponse.body?.cancel();
      throw statusError(manifestResponse.status, `manifest of ${parsed.name}`);
    }
    const raw = new Uint8Array(await manifestResponse.arrayBuffer());
    if (raw.length > maxManifestBytes)
      throw registryError('PROVIDER_ERROR', 'The image manifest is too large', 'manifestSize');
    if (parsed.digest) {
      const actual = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
      if (actual !== parsed.digest)
        throw registryError(
          'PROVIDER_ERROR',
          `The manifest of ${parsed.name} does not match its digest`,
          'manifestDigest',
        );
    }
    let manifest: {
      mediaType?: string;
      manifests?: unknown;
      layers?: { mediaType?: string; digest?: string; size?: number; annotations?: Record<string, string> }[];
    };
    try {
      manifest = JSON.parse(new TextDecoder().decode(raw)) as typeof manifest;
    } catch {
      throw registryError('PROVIDER_ERROR', 'The image manifest is not JSON', 'badBody');
    }
    if (Array.isArray(manifest.manifests))
      throw registryError(
        'UNSUPPORTED',
        `${parsed.name} is an image index; reference one platform's manifest by digest`,
        'imageIndex',
      );
    const disks = (manifest.layers ?? [])
      .map((layer) => ({ layer, kind: formatOf(layer) }))
      .filter((entry) => entry.kind !== undefined);
    if (disks.length === 0)
      throw registryError(
        'UNSUPPORTED',
        `${parsed.name} has no disk image layer (raw, qcow2 or iso)`,
        'noDiskLayer',
      );
    if (disks.length > 1)
      throw registryError(
        'INVALID_STATE',
        `${parsed.name} has more than one disk image layer`,
        'ambiguousDiskLayer',
      );
    const { layer, kind } = disks[0]!;
    const digest = digestPattern.exec(layer.digest ?? '');
    if (!digest)
      throw registryError('PROVIDER_ERROR', 'The disk layer has no sha256 digest', 'layerDigest');

    const blob = await registryGet(`/v2/${parsed.name}/blobs/${layer.digest}`, scope, '*/*', signal);
    await blob.body?.cancel();
    const location = blob.headers.get('location');
    if (![301, 302, 303, 307, 308].includes(blob.status) || !location) {
      if (!blob.ok) throw statusError(blob.status, `blob of ${parsed.name}`);
      // The registry served the bytes itself: a node would need our credentials to fetch them.
      throw registryError(
        'UNSUPPORTED',
        'The registry did not hand out a presigned URL for the layer',
        'blobRedirect',
      );
    }
    const target = new URL(location, registryUrl);
    if (target.protocol !== 'https:')
      throw registryError('PROVIDER_ERROR', 'The registry redirected to a non-https URL', 'blobRedirect');
    log.debug('digitalocean.registry.resolved', { name: parsed.name });
    return {
      url: target.toString(),
      sha256: digest[1]!,
      ...(typeof layer.size === 'number' ? { sizeBytes: layer.size } : {}),
      format: kind!.format,
      compression: kind!.compression,
    };
  }

  return {
    extension: 'image-source',
    id: 'digitalocean-registry',
    version: '0.1.0',
    schemes: ['oci'],
    resolve,
  };
}
