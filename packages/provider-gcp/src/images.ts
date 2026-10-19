import {
  ComputeError,
  isComputeError,
  type CallContext,
  type ImageRef,
  type ProviderContext,
  type ProviderImage,
  type ProviderImageMiss,
  type ProviderImages,
} from '@better-compute/core';
import { googleEndpoint } from '@better-compute/gcp-common';
import type { GceClient } from './client.js';
import type { GcpConfig, GcpProviderOptions } from './config.js';

// Image safety and resolution (U-03). Every image a VM boots comes from a project the account allows: the
// public OS image projects (or the account's own `imageProjects` list), the project image families resolve in
// (`imageProject`), and the account's own project unless `ownProjectImages` is false. `sourceImage()` refuses
// anything else with INVALID_INPUT, so a tenant naming another project's image never boots it. Families resolve
// through `images.getFromFamily`, cached for a day; a deprecated image is never offered.

/**
 * The public image projects an account allows when it names no `imageProjects`: the operating systems Google and
 * the distributions publish on Compute Engine, plus Canonical's accelerator images and Google's Deep Learning VMs.
 */
export const defaultImageProjects: readonly string[] = Object.freeze([
  'almalinux-cloud',
  'centos-cloud',
  'cos-cloud',
  'debian-cloud',
  'deeplearning-platform-release',
  'fedora-coreos-cloud',
  'opensuse-cloud',
  'oracle-linux-cloud',
  'rhel-cloud',
  'rhel-sap-cloud',
  'rocky-linux-cloud',
  'suse-cloud',
  'suse-sap-cloud',
  'ubuntu-os-accelerator-images',
  'ubuntu-os-cloud',
  'ubuntu-os-pro-cloud',
  'windows-cloud',
  'windows-sql-cloud',
]);

/** A project id as an image reference may name it (a domain-scoped `example.com:project` too). */
export const imageProjectPattern = '^(?:[a-z0-9][a-z0-9.-]{0,62}:)?[a-z][a-z0-9-]{0,62}$';

const name = '[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?';
const project = '(?:[a-z0-9][a-z0-9.-]{0,62}:)?[a-z][a-z0-9-]{0,62}';
const projectImage = new RegExp(`^projects/(${project})/global/images/(family/)?(${name})$`);
const globalImage = new RegExp(`^global/images/(family/)?(${name})$`);
const bareName = new RegExp(`^${name}$`);
const projectFamily = new RegExp(`^(${project})/(${name})$`);

/** The default project image families resolve in. */
const defaultFamilyProject = 'ubuntu-os-cloud';

/** A day: how long a resolved family is kept. */
export const imageCacheMs = 86_400_000;
/** How long a family with no image is remembered (it may be published meanwhile). */
const missCacheMs = 3_600_000;
const cacheLimit = 2_000;
/** Families read from GCE at once within one `resolve`. */
const readConcurrency = 8;
/** At most this many families per `resolve`. */
export const maxResolveFamilies = 50;

/** The projects an account's VMs may boot images from. */
export function allowedImageProjects(config: GcpConfig): Set<string> {
  const allowed = new Set(config.imageProjects ?? defaultImageProjects);
  allowed.add(config.imageProject ?? defaultFamilyProject);
  if (config.ownProjectImages !== false) allowed.add(config.projectId);
  return allowed;
}

function imageRefError(image: string): ComputeError {
  return new ComputeError(
    'INVALID_INPUT',
    `${JSON.stringify(image.slice(0, 200))} is not a Compute Engine image: name an image family, ` +
      'projects/<project>/global/images/[family/]<name>, global/images/[family/]<name> or a compute image URL',
    undefined,
    { provider: 'gcp', reason: 'imageRef' },
  );
}

function refuseProject(config: GcpConfig, image: string, imageProject: string): never {
  throw new ComputeError(
    'INVALID_INPUT',
    `Images from project ${imageProject} are not allowed for this account (imageProjects)`,
    undefined,
    {
      provider: 'gcp',
      reason: 'imageProjectNotAllowed',
      image: image.slice(0, 200),
      project: imageProject,
      allowed: [...allowedImageProjects(config)].sort(),
    },
  );
}

/** The hosts a compute image URL may name: the provider's compute endpoint, in its universe. */
function imageHosts(options: Pick<GcpProviderOptions, 'endpoint' | 'universeDomain'>): Set<string> {
  const hosts = new Set<string>([
    new URL(googleEndpoint('compute', { universeDomain: options.universeDomain })).host,
  ]);
  if (options.endpoint) hosts.add(new URL(options.endpoint).host);
  // The legacy host of the public universe's resource URLs.
  if (options.universeDomain === undefined || options.universeDomain === 'googleapis.com')
    hosts.add('www.googleapis.com');
  return hosts;
}

/** An image reference, parsed: the project it lives in and whether it names a family. */
export interface ParsedImageRef {
  project: string;
  family: boolean;
  name: string;
}

/**
 * Parses an image reference: a family name (in `imageProject`), `projects/<p>/global/images/[family/]<name>`,
 * `global/images/[family/]<name>` (the account's project) or an `https://` compute URL of the provider's own
 * endpoint naming one of those. Anything else is INVALID_INPUT (`imageRef`).
 */
export function parseImageRef(
  config: GcpConfig,
  image: ImageRef,
  options: Pick<GcpProviderOptions, 'endpoint' | 'universeDomain'> = {},
): ParsedImageRef {
  if (typeof image !== 'string') throw imageRefError(String(image));
  let path = image;
  if (/^https?:\/\//i.test(image)) {
    let url: URL;
    try {
      url = new URL(image);
    } catch {
      throw imageRefError(image);
    }
    const compute = /^\/compute\/(?:v1|beta|alpha)\/(projects\/.+)$/.exec(url.pathname);
    if (
      // Only a canonical URL: what is checked is exactly what GCE is given (no `..`, escapes or case to normalize).
      url.href !== image ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !imageHosts(options).has(url.host) ||
      !compute
    )
      throw imageRefError(image);
    path = compute[1]!;
  }
  const projectMatch = projectImage.exec(path);
  if (projectMatch)
    return {
      project: projectMatch[1]!,
      family: projectMatch[2] !== undefined,
      name: projectMatch[3]!,
    };
  // A URL names its project; the shorter forms below are only for references given as they are.
  if (path !== image) throw imageRefError(image);
  const globalMatch = globalImage.exec(path);
  if (globalMatch)
    return {
      project: config.projectId,
      family: globalMatch[1] !== undefined,
      name: globalMatch[2]!,
    };
  if (bareName.test(path))
    return { project: config.imageProject ?? defaultFamilyProject, family: true, name: path };
  throw imageRefError(image);
}

/**
 * The `sourceImage` of a boot disk for `image`, refused with INVALID_INPUT unless the image comes from a project
 * the account allows (`imageProjectNotAllowed`) and is a well-formed reference (`imageRef`). A family name becomes
 * `projects/<imageProject>/global/images/family/<name>`; other forms are kept as given.
 */
export function sourceImageOf(
  config: GcpConfig,
  image: ImageRef,
  options: Pick<GcpProviderOptions, 'endpoint' | 'universeDomain'> = {},
): string {
  const parsed = parseImageRef(config, image, options);
  if (!allowedImageProjects(config).has(parsed.project))
    refuseProject(config, image, parsed.project);
  if (/^https:\/\//i.test(image) || image.startsWith('projects/') || image.startsWith('global/'))
    return image;
  return `projects/${parsed.project}/global/images/family/${parsed.name}`;
}

/** The login `ssh-keys` names for an image (the distribution's default user). */
export function sshUserOf(image: ImageRef): string {
  const lowered = image.toLowerCase();
  if (lowered.includes('debian')) return 'debian';
  if (lowered.includes('rocky')) return 'rocky';
  if (lowered.includes('centos')) return 'centos';
  return 'ubuntu';
}

/** A GCE `Image` resource, as far as resolution reads it. */
export interface GceImage {
  name: string;
  family?: string;
  status?: string;
  architecture?: string;
  diskSizeGb?: string;
  guestOsFeatures?: { type?: string }[];
  deprecated?: {
    state?: string;
    replacement?: string;
    deprecated?: string;
    obsolete?: string;
    deleted?: string;
  };
  creationTimestamp?: string;
  description?: string;
}

/** A family to resolve, as asked and as parsed. */
function parseFamily(
  config: GcpConfig,
  family: string,
  options: Pick<GcpProviderOptions, 'endpoint' | 'universeDomain'>,
): { project: string; family: string } {
  if (typeof family !== 'string') throw imageRefError(String(family));
  const scoped = projectFamily.exec(family);
  if (scoped) return { project: scoped[1]!, family: scoped[2]! };
  const parsed = parseImageRef(config, family, options);
  if (!parsed.family)
    throw new ComputeError(
      'INVALID_INPUT',
      `${JSON.stringify(family.slice(0, 200))} names an image, not an image family`,
      undefined,
      { provider: 'gcp', reason: 'imageRef' },
    );
  return { project: parsed.project, family: parsed.name };
}

/** Why an image is not offered: undefined when it is usable at `now`. */
export function imageHidden(image: GceImage, now: number): ProviderImageMiss['reason'] | undefined {
  if (image.status !== undefined && image.status !== 'READY') return 'notFound';
  const deprecation = image.deprecated;
  if (!deprecation) return undefined;
  if (deprecation.state !== undefined && deprecation.state !== 'ACTIVE') return 'deprecated';
  for (const at of [deprecation.deprecated, deprecation.obsolete, deprecation.deleted]) {
    if (at === undefined) continue;
    const time = Date.parse(at);
    if (Number.isFinite(time) && time <= now) return 'deprecated';
  }
  return undefined;
}

/** The view of a usable image. */
export function toProviderImage(
  family: string,
  imageProject: string,
  image: GceImage,
): ProviderImage {
  const ref = `projects/${imageProject}/global/images/${image.name}`;
  const diskGiB = Number(image.diskSizeGb);
  const features = (image.guestOsFeatures ?? [])
    .map((feature) => feature.type)
    .filter((type): type is string => typeof type === 'string' && type !== '');
  const deprecation = image.deprecated;
  const schedule = deprecation
    ? {
        ...(deprecation.replacement ? { replacement: deprecation.replacement } : {}),
        ...(deprecation.deprecated ? { deprecated: deprecation.deprecated } : {}),
        ...(deprecation.obsolete ? { obsolete: deprecation.obsolete } : {}),
        ...(deprecation.deleted ? { deleted: deprecation.deleted } : {}),
      }
    : {};
  return {
    family,
    image: ref,
    name: image.name,
    project: imageProject,
    ...(image.architecture && image.architecture !== 'ARCHITECTURE_UNSPECIFIED'
      ? { architecture: image.architecture.toLowerCase() }
      : {}),
    ...(Number.isSafeInteger(diskGiB) && diskGiB > 0 ? { minimumDiskGiB: diskGiB } : {}),
    guestOsFeatures: [...new Set(features)].sort(),
    loginUser: sshUserOf(ref),
    ...(Object.keys(schedule).length > 0
      ? { deprecation: { state: 'ACTIVE' as const, ...schedule } }
      : {}),
    ...(image.creationTimestamp ? { createdAt: image.creationTimestamp } : {}),
    ...(image.description ? { description: image.description } : {}),
  };
}

interface CacheEntry {
  /** Undefined: the family has no image. */
  image: GceImage | undefined;
  until: number;
}

/**
 * The account's image families (U-03): `getFromFamily` per family, each answer kept a day (a family with no image
 * an hour), concurrent asks for one family sharing a read. A deprecated, obsolete or deleted image is never returned,
 * also when it was cached before its deprecation time passed.
 */
export class GcpImages implements ProviderImages {
  readonly #client: GceClient;
  readonly #config: GcpConfig;
  readonly #context: ProviderContext;
  readonly #options: Pick<GcpProviderOptions, 'endpoint' | 'universeDomain'>;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #reading = new Map<string, Promise<CacheEntry>>();

  constructor(
    client: GceClient,
    config: GcpConfig,
    context: ProviderContext,
    options: Pick<GcpProviderOptions, 'endpoint' | 'universeDomain'> = {},
  ) {
    this.#client = client;
    this.#config = config;
    this.#context = context;
    this.#options = options;
  }

  async resolve(
    families: readonly string[],
    context: CallContext,
  ): Promise<{ items: ProviderImage[]; missing: ProviderImageMiss[] }> {
    if (!Array.isArray(families) || families.length > maxResolveFamilies)
      throw new ComputeError(
        'INVALID_INPUT',
        `Resolve at most ${maxResolveFamilies} image families at a time`,
      );
    const asked = [...new Set(families)];
    // Every family is checked before anything is read: one refused family refuses the call.
    const allowed = allowedImageProjects(this.#config);
    const targets = asked.map((family) => {
      const target = parseFamily(this.#config, family, this.#options);
      if (!allowed.has(target.project)) refuseProject(this.#config, family, target.project);
      return { asked: family, ...target };
    });
    // At most `readConcurrency` reads at once, so a call of 50 new families is no burst on the account's API quota.
    const entries: CacheEntry[] = [];
    for (let start = 0; start < targets.length; start += readConcurrency)
      entries.push(
        ...(await Promise.all(
          targets
            .slice(start, start + readConcurrency)
            .map((target) => this.#entry(target.project, target.family, context.signal)),
        )),
      );
    const now = this.#context.clock.now();
    const items: ProviderImage[] = [];
    const missing: ProviderImageMiss[] = [];
    targets.forEach((target, index) => {
      const image = entries[index]!.image;
      const hidden = image ? imageHidden(image, now) : 'notFound';
      if (hidden) missing.push({ family: target.asked, reason: hidden });
      else items.push(toProviderImage(target.asked, target.project, image!));
    });
    return { items, missing };
  }

  /** The cached answer for one family, read when missing or stale. */
  #entry(imageProject: string, family: string, signal: AbortSignal): Promise<CacheEntry> {
    const key = `${imageProject}/${family}`;
    const now = this.#context.clock.now();
    const cached = this.#cache.get(key);
    if (cached && cached.until > now) return Promise.resolve(cached);
    const running = this.#reading.get(key);
    if (running) return running;
    const read = this.#read(imageProject, family, signal).finally(() => this.#reading.delete(key));
    this.#reading.set(key, read);
    return read;
  }

  async #read(imageProject: string, family: string, signal: AbortSignal): Promise<CacheEntry> {
    let image: GceImage | undefined;
    try {
      image = await this.#client.request<GceImage>(
        'GET',
        `/projects/${imageProject}/global/images/family/${family}`,
        { signal },
      );
    } catch (error) {
      // Any other failure (no permission, a busy API) is the caller's, and is not remembered.
      if (!isComputeError(error, 'NOT_FOUND')) throw error;
    }
    const now = this.#context.clock.now();
    const entry: CacheEntry = { image, until: now + (image ? imageCacheMs : missCacheMs) };
    this.#remember(`${imageProject}/${family}`, entry, now);
    return entry;
  }

  #remember(key: string, entry: CacheEntry, now: number): void {
    if (this.#cache.size >= cacheLimit) {
      for (const [stale, value] of this.#cache) if (value.until <= now) this.#cache.delete(stale);
      // Still full: the oldest answers go first.
      for (const oldest of this.#cache.keys()) {
        if (this.#cache.size < cacheLimit) break;
        this.#cache.delete(oldest);
      }
    }
    this.#cache.delete(key);
    this.#cache.set(key, entry);
  }
}
