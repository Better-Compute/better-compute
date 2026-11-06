import type { KubernetesVersions } from '@better-compute/core';
import type { DoClient } from '../client/http.js';
import { fail } from './common.js';
import type { DoksOptions, DoksVersion } from './types.js';

// DOKS versions: `GET /kubernetes/options` lists the version slugs (`1.33.5-do.1`) the account can
// create, for every region alike. DOKS has no release channels: `channels` stays empty, and the
// default is the newest version (what DO's `latest` slug resolves to).

const slugPattern = /^(\d+)\.(\d+)\.(\d+)-do\.(\d+)$/;

/** A version as numbers: `1.33` → [1, 33], `1.33.5` → [1, 33, 5], `1.33.5-do.1` → [1, 33, 5, 1]. */
export function parseDoksVersion(value: string): number[] | undefined {
  const match = /^(\d+)\.(\d+)(?:\.(\d+)(?:-do\.(\d+))?)?$/.exec(value);
  if (!match) return undefined;
  return match
    .slice(1)
    .filter((part) => part !== undefined)
    .map(Number);
}

/**
 * Compares the desired version with the actual one over the parts the desired one names: 0 when
 * the actual satisfies it (`1.33` is satisfied by `1.33.5-do.1`), negative when the desired is
 * older (a downgrade), positive when it is newer.
 */
export function compareDoksVersion(desired: string, actual: string): number {
  const want = parseDoksVersion(desired) ?? [];
  const have = parseDoksVersion(actual) ?? [];
  for (let i = 0; i < want.length; i++) {
    const difference = want[i]! - (have[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * How the actual version stands to the desired one for an existing cluster: 0 when it satisfies
 * it, positive when an upgrade is due, negative only for a downgrade of the minor. A newer patch of
 * the desired minor satisfies a full-version or slug pin: DOKS's auto-upgrade (every channel but
 * `extended`) moves a cluster's patch on its own, and DOKS cannot go back to the older one.
 */
export function versionGap(desired: string, actual: string): number {
  const gap = compareDoksVersion(desired, actual);
  if (gap >= 0) return gap;
  const want = parseDoksVersion(desired) ?? [];
  const have = parseDoksVersion(actual) ?? [];
  return want[0] === have[0] && want[1] === have[1] ? 0 : gap;
}

/** Newest first. */
export function byNewest(versions: readonly DoksVersion[]): DoksVersion[] {
  return versions
    .filter((version) => slugPattern.test(version.slug))
    .sort((a, b) => compareDoksVersion(b.slug, a.slug) || b.slug.localeCompare(a.slug));
}

/** The newest version that satisfies `wanted` (a minor, a full version or a slug), if any. */
export function pickVersion(
  versions: readonly DoksVersion[],
  wanted: string,
): DoksVersion | undefined {
  return byNewest(versions).find(
    (version) =>
      compareDoksVersion(wanted, version.slug) === 0 && (parseDoksVersion(wanted)?.length ?? 0) > 0,
  );
}

export async function readOptions(client: DoClient, signal: AbortSignal): Promise<DoksOptions> {
  const reply = await client.request<{ options?: DoksOptions }>('GET', '/kubernetes/options', {
    signal,
    budget: 'observe',
  });
  return reply.options ?? {};
}

export async function readVersions(
  client: DoClient,
  signal: AbortSignal,
): Promise<KubernetesVersions> {
  const versions = byNewest((await readOptions(client, signal)).versions ?? []);
  if (!versions[0])
    throw fail('PROVIDER_ERROR', 'DigitalOcean lists no Kubernetes versions', 'noVersions');
  return {
    defaultVersion: versions[0].slug,
    validVersions: versions.map((version) => version.slug),
    channels: {},
  };
}
