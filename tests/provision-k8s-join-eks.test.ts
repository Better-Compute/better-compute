import { describe, expect, it } from 'vitest';
import {
  eksNodeConfig,
  eksUserData,
  poolHostConfig,
  resolveHostConfig,
  validatePoolHostPolicy,
} from '@better-compute/provision';

// provision k8s-join mode 'eks' (AWS A9): machines join an EKS cluster through nodeadm (AL2023 EKS
// AMIs), which reads a NodeConfig from a MIME part of the user data. The node authenticates with
// its instance profile's role (an EC2_LINUX access entry), so there is no bootstrap token.

const caPem = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUEKS\n-----END CERTIFICATE-----\n';
const ca = Buffer.from(caPem).toString('base64');
const cluster = {
  name: 'bc-k-one',
  apiServerEndpoint: 'https://ABCDEF0123456789.gr7.us-west-2.eks.amazonaws.com',
  certificateAuthority: ca,
  cidr: '172.20.0.0/16',
};

describe('provision k8s-join mode eks', () => {
  it('validates the eks settings and keeps kubeadm unchanged', async () => {
    const resolved = await resolveHostConfig(
      {
        'k8s-join': {
          mode: 'eks',
          cluster,
          nodeLabels: { tier: 'gpu' },
          taints: ['nvidia.com/gpu=:NoSchedule'],
        },
      },
      { labels: {} },
    );
    expect(resolved.config!['k8s-join']).toEqual({
      mode: 'eks',
      cluster,
      gpu: true,
      nodeLabels: { tier: 'gpu' },
      taints: ['nvidia.com/gpu=:NoSchedule'],
    });
    // kubeadm mode: as before (no mode key unless given).
    const kubeadm = await resolveHostConfig(
      {
        'k8s-join': {
          server: 'https://k8s.example:6443',
          caCertSha256: 'ab'.repeat(32),
          tokenRef: 'secret://acme/k8s',
        },
      },
      { labels: {} },
    );
    expect(kubeadm.config!['k8s-join']).not.toHaveProperty('mode');
    await expect(
      resolveHostConfig(
        { 'k8s-join': { mode: 'kubeadm', server: 'https://k8s.example:6443', caCertSha256: 'ab'.repeat(32), tokenRef: 'secret://acme/k8s' } },
        { labels: {} },
      ),
    ).resolves.toMatchObject({ config: { 'k8s-join': { mode: 'kubeadm' } } });
  });

  it('renders a nodeadm NodeConfig', () => {
    const yaml = eksNodeConfig({
      mode: 'eks',
      cluster,
      nodeLabels: { tier: 'gpu', 'bcd.dev/pool': 'p1' },
      taints: ['nvidia.com/gpu=:NoSchedule'],
    });
    expect(yaml).toBe(
      [
        '---',
        'apiVersion: node.eks.aws/v1alpha1',
        'kind: NodeConfig',
        'spec:',
        '  cluster:',
        '    name: "bc-k-one"',
        `    apiServerEndpoint: "${cluster.apiServerEndpoint}"`,
        `    certificateAuthority: "${ca}"`,
        '    cidr: "172.20.0.0/16"',
        '  kubelet:',
        '    flags:',
        '      - "--node-labels=bcd.dev/pool=p1,tier=gpu"',
        '      - "--register-with-taints=nvidia.com/gpu=:NoSchedule"',
        '',
      ].join('\n'),
    );
    // Without labels or taints there are no kubelet flags.
    expect(eksNodeConfig({ mode: 'eks', cluster })).not.toContain('kubelet');
  });

  it('puts the NodeConfig first in a MIME multipart, then the rest of the user data', () => {
    const userData = '#cloud-config\nruncmd:\n  - [echo, hi]\n';
    const doc = eksUserData({ mode: 'eks', cluster }, userData);
    const boundary = /boundary="([^"]+)"/.exec(doc)![1]!;
    expect(doc.startsWith(`MIME-Version: 1.0\nContent-Type: multipart/mixed; boundary="${boundary}"\n\n`)).toBe(true);
    const parts = doc.split(`--${boundary}`);
    expect(parts[1]).toContain('Content-Type: application/node.eks.aws');
    expect(parts[1]).toContain('kind: NodeConfig');
    expect(parts[2]).toContain('Content-Type: text/cloud-config');
    expect(parts[2]).toContain('runcmd:');
    expect(doc.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
    // Deterministic: the same input packs to the same bytes (EC2 compares parameters per ClientToken).
    expect(eksUserData({ mode: 'eks', cluster }, userData)).toBe(doc);
    // A multipart user data is not nested: refused.
    expect(() => eksUserData({ mode: 'eks', cluster }, doc)).toThrow(/multipart/);
    // No other user data: the NodeConfig alone.
    const alone = eksUserData({ mode: 'eks', cluster }, '');
    const aloneBoundary = /boundary="([^"]+)"/.exec(alone)![1]!;
    expect(alone.split(`--${aloneBoundary}`)).toHaveLength(3);
    expect(alone).not.toContain('text/');
  });

  it('refuses missing CA', async () => {
    const refused = (patch: Record<string, unknown>, pattern: RegExp) =>
      expect(
        resolveHostConfig({ 'k8s-join': { mode: 'eks', cluster: { ...cluster, ...patch } } as never }, { labels: {} }),
      ).rejects.toThrow(pattern);
    const { certificateAuthority: _, ...withoutCa } = cluster;
    await expect(
      resolveHostConfig({ 'k8s-join': { mode: 'eks', cluster: withoutCa } as never }, { labels: {} }),
    ).rejects.toThrow(/certificateAuthority/);
    expect(() => eksNodeConfig({ mode: 'eks', cluster: withoutCa } as never)).toThrow(/certificateAuthority/);
    await refused({ certificateAuthority: 'bm90IGEgY2VydA==' }, /certificateAuthority/);
    await refused({ certificateAuthority: `${ca}\n  injected: true` }, /certificateAuthority/);
    await refused({ apiServerEndpoint: 'http://x.eks.amazonaws.com' }, /apiServerEndpoint/);
    await refused({ apiServerEndpoint: 'https://x.example/path' }, /apiServerEndpoint/);
    await refused({ name: 'bad name' }, /cluster.name/);
    await refused({ cidr: '10.0.0.0/33' }, /cidr/);
    await refused({ extra: 1 }, /not a setting/);
    // kubeadm settings do not mix with eks.
    await expect(
      resolveHostConfig({ 'k8s-join': { mode: 'eks', cluster, tokenRef: 'secret://a/b' } as never }, { labels: {} }),
    ).rejects.toThrow(/tokenRef/);
    await expect(
      resolveHostConfig({ 'k8s-join': { mode: 'kops', cluster } as never }, { labels: {} }),
    ).rejects.toThrow(/mode/);
  });

  it('renders from policy.kubernetes.eks', async () => {
    expect(
      poolHostConfig({ kubernetes: { eks: cluster, labels: { tier: 'gpu' }, gpu: false } }),
    ).toEqual({ 'k8s-join': { mode: 'eks', cluster, nodeLabels: { tier: 'gpu' }, gpu: false } });
    await expect(validatePoolHostPolicy({ kubernetes: { eks: cluster } })).resolves.toBeUndefined();
    // eks and the kubeadm settings are exclusive.
    await expect(
      validatePoolHostPolicy({
        kubernetes: { eks: cluster, apiServer: 'https://k', caCertSha256: 'ab'.repeat(32), joinTokenRef: 'secret://a/b' },
      }),
    ).rejects.toThrow(/eks/);
    await expect(validatePoolHostPolicy({ kubernetes: { eks: { ...cluster, certificateAuthority: '' } } })).rejects.toThrow(
      /certificateAuthority/,
    );
  });
});
