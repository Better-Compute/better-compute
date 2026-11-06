import type { KubernetesClusterSpec, KubernetesVersions } from '@better-compute/core';
import type { EksClient } from './client.js';

// The Kubernetes versions EKS offers (DescribeClusterVersions). EKS has no release channels: the
// `rapid`, `regular` and `stable` channels list the versions in standard support, `extended` adds
// those in extended support (upgradePolicy EXTENDED keeps a cluster on one of them).

interface EksClusterVersion {
  clusterVersion?: string;
  clusterType?: string;
  defaultVersion?: boolean;
  status?: string;
  versionStatus?: string;
}

const order = (a: string, b: string): number => {
  const [am = 0, an = 0] = a.split('.').map(Number);
  const [bm = 0, bn = 0] = b.split('.').map(Number);
  return bm - am || bn - an;
};

function supportOf(entry: EksClusterVersion): 'standard' | 'extended' | 'unsupported' {
  const status = (entry.versionStatus ?? entry.status ?? '').toUpperCase().replace(/-/g, '_');
  if (status === 'STANDARD_SUPPORT') return 'standard';
  if (status === 'EXTENDED_SUPPORT') return 'extended';
  return 'unsupported';
}

export async function readVersions(client: EksClient, signal: AbortSignal): Promise<KubernetesVersions> {
  const entries: EksClusterVersion[] = [];
  const seen = new Set<string>();
  let token: string | undefined;
  do {
    const page = await client.request<{ clusterVersions?: EksClusterVersion[]; nextToken?: string }>(
      'GET',
      '/cluster-versions',
      {
        signal,
        what: 'Reading the EKS versions',
        query: { clusterType: 'eks', maxResults: '100', ...(token ? { nextToken: token } : {}) },
      },
    );
    entries.push(...(page.clusterVersions ?? []));
    token = page.nextToken || undefined;
    if (token && seen.has(token)) break;
    if (token) seen.add(token);
  } while (token);
  const usable = entries.filter(
    (entry) =>
      typeof entry.clusterVersion === 'string' &&
      /^\d+\.\d+$/.test(entry.clusterVersion) &&
      (entry.clusterType ?? 'eks') === 'eks',
  );
  const standard = usable.filter((entry) => supportOf(entry) === 'standard').map((e) => e.clusterVersion!).sort(order);
  const extended = usable.filter((entry) => supportOf(entry) !== 'unsupported').map((e) => e.clusterVersion!).sort(order);
  const defaultVersion =
    usable.find((entry) => entry.defaultVersion === true)?.clusterVersion ?? standard[0] ?? '';
  const standardChannel = { defaultVersion, validVersions: standard };
  const channels: Partial<
    Record<KubernetesClusterSpec['releaseChannel'], { defaultVersion: string; validVersions: string[] }>
  > = {
    rapid: standardChannel,
    regular: standardChannel,
    stable: standardChannel,
    extended: { defaultVersion, validVersions: extended },
  };
  return { defaultVersion, validVersions: extended, channels };
}
