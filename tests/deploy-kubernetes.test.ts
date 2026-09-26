import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// bcd as a Kubernetes DaemonSet (deploy/kubernetes): the properties the join and the host rely on,
// checked on the manifests' text (no YAML parser in the workspace).

const read = (file: string) => readFileSync(new URL(`../deploy/kubernetes/${file}`, import.meta.url), 'utf8');

describe('deploy/kubernetes', () => {
  const daemonset = read('daemonset.yaml');

  it('hands the join token over owner-readable only, and survives its deletion', () => {
    // bcd join refuses a token file group or others can read (cmd/bcd/tokenfile.go).
    expect(daemonset).toMatch(/secretName: bcd-join\n\s+#[^\n]*\n\s+defaultMode: 0400\n\s+optional: true/);
    expect(daemonset).toContain('--token-file=/var/run/bcd-join/token');
    expect(daemonset).toMatch(/name: join-token, mountPath: \/var\/run\/bcd-join, readOnly: true/);
    // The token is minted as hosted, so the trust comes from the pool, never from the node.
    expect(daemonset).toContain('--hosted kubernetes');
    // Where join finds the well-known document, base path included when compute is mounted in an app.
    expect(daemonset).toContain('<server>/.well-known/better-compute');
    expect(daemonset).toContain('https://app.example.com/api/compute');
  });

  it('keeps the identity on the host and gives the pod no Kubernetes API identity', () => {
    expect(daemonset).toContain('automountServiceAccountToken: false');
    expect(daemonset).toMatch(/name: data, hostPath: \{ path: \/var\/lib\/bcd, type: DirectoryOrCreate \}/);
    expect(read('config.toml.example')).toMatch(/data_dir = "\/var\/lib\/bcd"/);
  });

  it('leaves the host configuration to the cluster', () => {
    const config = read('config.toml.example');
    expect(config).toMatch(/\[host\]\n(?:#[^\n]*\n)*units = false\n/);
    expect(config).not.toMatch(/release_pins/); // image rollouts, never self-update
  });

  it('runs in the privileged namespace with the host paths bcd writes', () => {
    expect(read('namespace.yaml')).toContain('pod-security.kubernetes.io/enforce: privileged');
    for (const path of ['/etc/cdi', '/run/bcd', '/var/lib/kubelet/device-plugins', '/dev', '/sys'])
      expect(daemonset).toContain(`path: ${path}`);
    expect(read('kustomization.yaml')).toMatch(/resources:\n\s+- namespace.yaml\n\s+- daemonset.yaml/);
  });
});
