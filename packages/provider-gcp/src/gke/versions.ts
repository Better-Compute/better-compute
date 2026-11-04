import type { KubernetesClusterSpec, KubernetesVersions } from '@better-compute/core';
import { checkLocation, type GkeClient } from './client.js';

// The Kubernetes versions GKE offers in a location (`serverConfig`).

interface GkeServerConfig {
  defaultClusterVersion?: string;
  validMasterVersions?: string[];
  channels?: { channel?: string; defaultVersion?: string; validVersions?: string[] }[];
}

const channelNames: Readonly<Record<string, KubernetesClusterSpec['releaseChannel']>> = {
  RAPID: 'rapid',
  REGULAR: 'regular',
  STABLE: 'stable',
  EXTENDED: 'extended',
};

export async function readVersions(
  client: GkeClient,
  location: string,
  signal: AbortSignal,
): Promise<KubernetesVersions> {
  checkLocation(location);
  const config = await client.request<GkeServerConfig>('GET', location, 'serverConfig', {
    signal,
    what: `Reading the GKE versions of ${location}`,
  });
  const channels: Partial<
    Record<
      KubernetesClusterSpec['releaseChannel'],
      { defaultVersion: string; validVersions: string[] }
    >
  > = {};
  for (const entry of config.channels ?? []) {
    const name = channelNames[entry.channel ?? ''];
    if (!name) continue;
    channels[name] = {
      defaultVersion: entry.defaultVersion ?? '',
      validVersions: [...(entry.validVersions ?? [])],
    };
  }
  return {
    defaultVersion: config.defaultClusterVersion ?? '',
    validVersions: [...(config.validMasterVersions ?? [])],
    channels,
  };
}
