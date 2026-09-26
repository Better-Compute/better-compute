// Writes the Kubernetes DaemonSet contract between @better-compute/provider-kubernetes and bcd
// (daemon/cmd/bcd/testdata/k8s-daemonset.json): the config.toml its ConfigMap carries and the command lines
// its containers run. bcd's TestKubernetesDaemonSetContract parses them with bcd's real config parser and
// flag sets, so a renamed key or flag fails a test instead of every node of a cluster.
//
//   node --import ./tests/fixtures/bcx-loader.mjs scripts/daemon-k8s-contract.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const kubernetes = await import('@better-compute/provider-kubernetes');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const options = {
  image: `registry.example.com/better-compute/bcd:0.6.0@sha256:${'ab'.repeat(32)}`,
  gatewayUrl: 'https://gw.eu-central.example.com:8443',
  siteId: 'site_k8s_contract',
  pins: {
    servingCaPin: `sha256/${Buffer.alloc(32, 1).toString('base64')}`,
    joinSigningPin: `sha256/${Buffer.alloc(32, 2).toString('base64')}`,
    joinEncryptionPin: `sha256/${Buffer.alloc(32, 3).toString('base64')}`,
  },
  controlPlaneUrl: 'https://compute.example.com/api/compute',
  joinTokenSecret: { name: 'bcd-join', key: 'token' },
  gatewayServerName: 'gw.eu-central.example.com',
  gpuApi: 'dra',
};
const objects = kubernetes.bcdDaemonSetManifests(options);
const configMap = objects.find((object) => object.kind === 'ConfigMap');
const daemonSet = objects.find((object) => object.kind === 'DaemonSet');
const pod = daemonSet.spec.template.spec;
const out = {
  options,
  config: configMap.data['config.toml'],
  join: pod.initContainers[0].command,
  node: pod.containers[0].command,
  probe: pod.containers[0].livenessProbe.exec.command,
};
const file = join(root, 'daemon/cmd/bcd/testdata/k8s-daemonset.json');
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${file}`);
