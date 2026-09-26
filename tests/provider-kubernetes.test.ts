import { describe, expect, it } from 'vitest';
import { bcdConfigToml, bcdDaemonSetManifests, renderKubernetesManifests, type BcdDaemonSetOptions } from '@better-compute/provider-kubernetes';

// Kubernetes as a capacity source (PLAN.md §3.8): bcd as a DaemonSet adopts a cluster's nodes. The manifests
// keep the join token in the init container only, run bcd without a service account token, keep its identity
// on the host, and leave the host's drivers to the cluster. bcd's own parser checks the config.toml and the
// command lines (daemon/cmd/bcd TestKubernetesDaemonSetContract, fed by scripts/daemon-k8s-contract.mjs).

const pin = (n: number) => `sha256/${Buffer.alloc(32, n).toString('base64')}`;
const jwk = JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'x'.repeat(43), y: 'y'.repeat(43) });
const options: BcdDaemonSetOptions = {
  image: `registry.example.com/bcd:0.6.0@sha256:${'ab'.repeat(32)}`,
  gatewayUrl: 'https://gw.example.com:8443',
  siteId: 'site_k8s',
  pins: { servingCaPin: pin(1), joinSigningPin: pin(2), joinEncryptionPin: pin(3) },
  joinEncryptionJwk: jwk,
  joinTokenSecret: { name: 'bcd-join' },
};

const podOf = (objects: ReturnType<typeof bcdDaemonSetManifests>) =>
  (objects.find((object) => object.kind === 'DaemonSet') as any).spec.template.spec;

describe('bcd as a Kubernetes DaemonSet', () => {
  it('emits a namespace, the config and the DaemonSet, deterministically', () => {
    const objects = bcdDaemonSetManifests(options);
    expect(objects.map((object) => `${object.kind}/${object.metadata.name}`)).toEqual(['Namespace/bcd-system', 'ConfigMap/bcd-config', 'DaemonSet/bcd']);
    expect(renderKubernetesManifests(bcdDaemonSetManifests(options))).toBe(renderKubernetesManifests(objects));
    const list = JSON.parse(renderKubernetesManifests(objects));
    expect(list).toMatchObject({ apiVersion: 'v1', kind: 'List' });
    expect(bcdDaemonSetManifests({ ...options, createNamespace: false }).map((object) => object.kind)).toEqual(['ConfigMap', 'DaemonSet']);
    // Its namespace runs privileged; the GPU isolation requirements travel with the DaemonSet.
    expect(objects[0]!.metadata.labels).toMatchObject({ 'pod-security.kubernetes.io/enforce': 'privileged' });
    const daemonSet = objects.find((object) => object.kind === 'DaemonSet')!;
    expect(daemonSet.metadata.annotations!['bcd.dev/requires']).toMatch(/devicePlugin\.enabled=false.*accept-nvidia-visible-devices-envvar-when-unprivileged=false/);
    expect((daemonSet as any).spec.template.spec.hostPID).toBe(false);
  });

  it('keeps the token in the join init container only, and gives bcd no API token', () => {
    const pod = podOf(bcdDaemonSetManifests(options));
    const [join] = pod.initContainers;
    const [bcd] = pod.containers;
    expect(join.command).toEqual(['/usr/local/bin/bcd', 'join', '--config', '/etc/bcd/config.toml', '--token-file', '/etc/bcd/token/token']);
    expect(join.volumeMounts.map((m: { name: string }) => m.name)).toContain('join-token');
    expect(join.securityContext).toMatchObject({ privileged: false, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } });
    expect(bcd.command).toEqual(['/usr/local/bin/bcd', 'node', '--config', '/etc/bcd/config.toml']);
    expect(bcd.volumeMounts.map((m: { name: string }) => m.name)).not.toContain('join-token');
    expect(JSON.stringify(bcd.env)).not.toMatch(/TOKEN/);
    // bcd sees the driver's utilities (nvidia-smi) through the NVIDIA runtime; the join container does not.
    expect(pod.runtimeClassName).toBe('nvidia');
    expect(bcd.env).toEqual(expect.arrayContaining([{ name: 'NVIDIA_VISIBLE_DEVICES', value: 'all' }, { name: 'NVIDIA_DRIVER_CAPABILITIES', value: 'utility' }]));
    expect(join.env).toBeUndefined();
    const plain = podOf(bcdDaemonSetManifests({ ...options, nvidiaRuntimeClass: null }));
    expect(plain.runtimeClassName).toBeUndefined();
    expect(JSON.stringify(plain.containers[0].env)).not.toMatch(/NVIDIA/);
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.hostNetwork).toBe(true);
    // The token Secret is referenced by name only, read-only, as `token`. Optional (review 2, LOW 7): once the
    // operator deletes it after rollout, a joined node's pod still starts (bcd join spends nothing there).
    expect(pod.volumes.find((v: { name: string }) => v.name === 'join-token')).toEqual({
      name: 'join-token',
      secret: { secretName: 'bcd-join', defaultMode: 0o400, optional: true, items: [{ key: 'token', path: 'token' }] },
    });
    // Identity survives pod restarts.
    expect(pod.volumes.find((v: { name: string }) => v.name === 'data')).toEqual({ name: 'data', hostPath: { path: '/var/lib/bcd', type: 'DirectoryOrCreate' } });
    // Hosted bcd's kubectl runs as the kubelet (e7d0765): its kubeconfig and client certificates, read-only,
    // and nothing else of /etc/kubernetes (admin.conf and the CA keys on a control-plane node). No service account.
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(bcd.volumeMounts.find((m: { name: string }) => m.name === 'kubelet-kubeconfig')).toEqual({
      name: 'kubelet-kubeconfig',
      mountPath: '/etc/kubernetes/kubelet.conf',
      readOnly: true,
    });
    expect(pod.volumes.find((v: { name: string }) => v.name === 'kubelet-kubeconfig')).toEqual({
      name: 'kubelet-kubeconfig',
      hostPath: { path: '/etc/kubernetes/kubelet.conf', type: 'File' },
    });
    expect(bcd.volumeMounts.find((m: { name: string }) => m.name === 'kubelet-pki-0')).toEqual({ name: 'kubelet-pki-0', mountPath: '/var/lib/kubelet/pki', readOnly: true });
    expect(pod.volumes.some((v: { hostPath?: { path: string } }) => v.hostPath?.path === '/etc/kubernetes')).toBe(false);
    // Exactly these host paths and modes: of the kubelet's state only the sockets bcd talks to, never
    // /var/lib/kubelet itself (every pod's volumes, secrets and tokens).
    const hostMounts = (p: typeof pod) =>
      Object.fromEntries(
        p.containers[0].volumeMounts
          .map((m: { name: string; mountPath: string; readOnly?: boolean }) => {
            const volume = p.volumes.find((v: { name: string }) => v.name === m.name);
            return volume?.hostPath ? [volume.hostPath.path, `${m.readOnly ? 'ro' : 'rw'} ${m.mountPath}`] : undefined;
          })
          .filter(Boolean),
      );
    expect(hostMounts(pod)).toEqual({
      '/var/lib/bcd': 'rw /var/lib/bcd',
      '/dev': 'rw /dev',
      '/sys': 'rw /sys',
      '/var/lib/kubelet/device-plugins': 'rw /var/lib/kubelet/device-plugins',
      '/var/lib/kubelet/pod-resources': 'ro /var/lib/kubelet/pod-resources',
      '/etc/kubernetes/kubelet.conf': 'ro /etc/kubernetes/kubelet.conf',
      '/var/lib/kubelet/pki': 'ro /var/lib/kubelet/pki',
      '/etc/cdi': 'rw /etc/cdi',
      '/var/run/cdi': 'rw /var/run/cdi',
      '/etc/nvidia-container-runtime': 'ro /etc/nvidia-container-runtime',
      '/usr/local/nvidia/toolkit/.config/nvidia-container-runtime': 'ro /usr/local/nvidia/toolkit/.config/nvidia-container-runtime',
    });
    // The DRA driver adds its registration and plugin directories, and nothing else.
    const dra = hostMounts(podOf(bcdDaemonSetManifests({ ...options, gpuApi: 'dra' })));
    expect(Object.keys(dra).filter((path) => !(path in hostMounts(pod)))).toEqual([
      '/var/lib/kubelet/plugins_registry',
      '/var/lib/kubelet/plugins/gpu.bcd.dev',
    ]);
    expect(dra['/var/lib/kubelet/plugins/gpu.bcd.dev']).toBe('rw /var/lib/kubelet/plugins/gpu.bcd.dev');
    expect(pod.tolerations).toEqual([{ operator: 'Exists' }]);
    // The NVIDIA toolkit's configs, read only, for bcd's GPU isolation check.
    for (const path of ['/etc/nvidia-container-runtime', '/usr/local/nvidia/toolkit/.config/nvidia-container-runtime'])
      expect(bcd.volumeMounts.find((m: { mountPath: string }) => m.mountPath === path)).toMatchObject({ readOnly: true });
    expect(pod.priorityClassName).toBe('system-node-critical');
  });

  it('writes a config.toml that leaves the host to the cluster, and rolls pods when it changes', () => {
    const toml = bcdConfigToml(options);
    expect(toml).toContain('gateway_url = "https://gw.example.com:8443"');
    expect(toml).toContain('site = "site_k8s"');
    expect(toml).toContain('[host]\nunits = false');
    expect(toml).not.toMatch(/bcjt_|token =/);
    expect(bcdConfigToml({ ...options, hostUnits: true })).toContain('[host]\nunits = true');
    expect(bcdConfigToml({ ...options, gpuApi: 'dra' })).toContain('[kubernetes]\ngpu_api = "dra"');
    expect(toml).not.toContain('[kubernetes]');
    expect(() => bcdConfigToml({ ...options, gpuApi: 'nvml' as never })).toThrow(/gpuApi/);
    const sha = (o: BcdDaemonSetOptions) =>
      (bcdDaemonSetManifests(o).find((object) => object.kind === 'DaemonSet') as any).spec.template.metadata.annotations['bcd.dev/config-sha256'];
    expect(sha(options)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha({ ...options, siteId: 'site_other' })).not.toBe(sha(options));
    // The JoinService key beside config.toml, public only.
    const config = bcdDaemonSetManifests(options).find((object) => object.kind === 'ConfigMap') as any;
    expect(Object.keys(config.data).sort()).toEqual(['config.toml', 'join-encryption.jwk']);
  });

  it('takes the join key from the control plane instead, with --server', () => {
    const { joinEncryptionJwk: _, ...rest } = options;
    const pod = podOf(bcdDaemonSetManifests({ ...rest, controlPlaneUrl: 'https://compute.example.com/api/compute/' }));
    expect(pod.initContainers[0].command.slice(-2)).toEqual(['--server', 'https://compute.example.com/api/compute']);
    expect(() => bcdDaemonSetManifests(rest)).toThrow(/joinEncryptionJwk or controlPlaneUrl/);
  });

  it('refuses what would be unsafe or unparseable', () => {
    const refused = (patch: Partial<BcdDaemonSetOptions>, pattern: RegExp) => expect(() => bcdDaemonSetManifests({ ...options, ...patch })).toThrow(pattern);
    refused({ image: 'registry.example.com/bcd:latest' }, /pinned by digest/);
    refused({ gatewayUrl: 'http://gw.example.com' }, /gatewayUrl/);
    refused({ gatewayUrl: 'https://user:pw@gw.example.com' }, /gatewayUrl/);
    refused({ siteId: 'site "x"' }, /siteId/);
    refused({ pins: { ...options.pins, joinSigningPin: 'sha256/short' } }, /joinSigningPin/);
    refused({ joinTokenSecret: { name: 'Bad_Name' } }, /joinTokenSecret/);
    refused({ namespace: 'Bad' }, /namespace/);
    refused({ nodeSelector: { 'bad key!': 'x' } }, /nodeSelector/);
    refused({ resources: { limits: { memory: 'lots' } } }, /resources/);
    refused({ joinEncryptionJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'a', y: 'b', d: 'secret' }) }, /public key only/);
    refused({ joinEncryptionJwk: '{"kty":"RSA"}' }, /P-256/);
  });

  it('lets an operator narrow where bcd runs', () => {
    const pod = podOf(
      bcdDaemonSetManifests({
        ...options,
        nodeSelector: { 'nvidia.com/gpu.present': 'true' },
        tolerations: [{ key: 'nvidia.com/gpu', operator: 'Exists', effect: 'NoSchedule' }],
        priorityClassName: null,
        imagePullSecrets: ['registry-creds'],
      }),
    );
    expect(pod.nodeSelector).toEqual({ 'nvidia.com/gpu.present': 'true' });
    expect(pod.tolerations).toEqual([{ key: 'nvidia.com/gpu', operator: 'Exists', effect: 'NoSchedule' }]);
    expect(pod.priorityClassName).toBeUndefined();
    expect(pod.imagePullSecrets).toEqual([{ name: 'registry-creds' }]);
  });

  it("mounts another distribution's kubelet credentials where bcd reads them, and never a whole config tree", () => {
    const k3s = { kubeconfig: '/var/lib/rancher/k3s/agent/kubelet.kubeconfig', certificateDirs: ['/var/lib/rancher/k3s/agent'] };
    const pod = podOf(bcdDaemonSetManifests({ ...options, kubeletCredentials: k3s }));
    const bcd = pod.containers[0];
    expect(pod.volumes.find((v: { name: string }) => v.name === 'kubelet-kubeconfig').hostPath).toEqual({ path: k3s.kubeconfig, type: 'File' });
    // Inside the container at the path bcd's kubectl uses; the certificates at their own paths, as the kubeconfig names them.
    expect(bcd.volumeMounts.find((m: { name: string }) => m.name === 'kubelet-kubeconfig').mountPath).toBe('/etc/kubernetes/kubelet.conf');
    expect(bcd.volumeMounts.find((m: { name: string }) => m.name === 'kubelet-pki-0')).toMatchObject({ mountPath: '/var/lib/rancher/k3s/agent', readOnly: true });
    for (const dir of ['/etc/kubernetes', '/etc/kubernetes/pki', '/var/lib/kubelet', '/var/lib/kubelet/pods', '/'])
      expect(() => bcdDaemonSetManifests({ ...options, kubeletCredentials: { kubeconfig: k3s.kubeconfig, certificateDirs: [dir] } })).toThrow(/certificateDirs/);
    expect(() => bcdDaemonSetManifests({ ...options, kubeletCredentials: { kubeconfig: 'relative/kubelet.conf', certificateDirs: ['/x'] } })).toThrow(/kubeconfig/);
  });
});
