// Renders @better-compute/provider-kubernetes's bcd DaemonSet manifests as one Kubernetes List (JSON), for
// CI's server-side dry run on a kind cluster (.github/workflows/daemon.yml, job `container`): the objects the
// `kubernetes manifest` command prints, with placeholder pins, token and an image reference given on the
// command line.
//
//   node --import ./tests/fixtures/bcx-loader.mjs scripts/k8s-render-manifests.mjs <image> <out.json>
import { writeFileSync } from 'node:fs';

const [image, out] = process.argv.slice(2);
if (!image || !out) {
  console.error('usage: k8s-render-manifests.mjs <image> <out.json>');
  process.exit(2);
}
const kubernetes = await import('@better-compute/provider-kubernetes');
const pin = (byte) => `sha256/${Buffer.alloc(32, byte).toString('base64')}`;
// The provider takes digest-pinned images only; a dry run never pulls, so a placeholder digest will do.
const pinned = image.includes('@sha256:') ? image : `${image}@sha256:${'0'.repeat(64)}`;
const objects = kubernetes.bcdDaemonSetManifests({
  image: pinned,
  gatewayUrl: 'https://gw.ci.example.com:8443',
  siteId: 'site_ci',
  pins: { servingCaPin: pin(1), joinSigningPin: pin(2), joinEncryptionPin: pin(3) },
  controlPlaneUrl: 'https://compute.ci.example.com/api/compute',
  joinTokenSecret: { name: 'bcd-join', key: 'token' },
  gatewayServerName: 'gw.ci.example.com',
});
writeFileSync(out, `${JSON.stringify({ apiVersion: 'v1', kind: 'List', items: objects }, null, 2)}\n`);
console.log(`${objects.length} object(s): ${objects.map((object) => object.kind).join(', ')}`);
