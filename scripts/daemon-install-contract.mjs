// Writes the install contract between the TypeScript side and bcd (daemon/cmd/bcd/testdata/
// install-contract.json): the exact `bcd` command lines the provisioned OS runs, as provision's
// user-data renderers (cloud-init, Ignition) and the Hetzner Robot bootstrap produce them. bcd's
// TestInstallContract parses each with bcd's real flag sets, so renaming a flag on either side fails
// a test instead of a machine's first boot.
//
//   node --import ./tests/fixtures/bcx-loader.mjs scripts/daemon-install-contract.mjs
// (scripts/daemon-fixtures.mjs runs it too.)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const provision = await import('@better-compute/provision');
const hetzner = await import('@better-compute/provider-hetzner');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Pins as the PKI bundle gives them (`sha256/<base64>` SPKI digests).
const pins = {
  servingCa: `sha256/${Buffer.alloc(32, 1).toString('base64')}`,
  joinSigning: `sha256/${Buffer.alloc(32, 2).toString('base64')}`,
  joinEncryption: `sha256/${Buffer.alloc(32, 3).toString('base64')}`,
};

const variables = {
  nodeId: 'node_01k5w00000000000000000inst',
  hostname: 'gpu-7',
  joinToken: 'bcjt_01k5w0000000000000000000000.contract',
  controlPlaneUrl: 'https://compute.example.com/api/compute',
  bcdUrl: 'https://compute.example.com/api/compute/downloads/bcd/0.5.0/linux-amd64',
  bcdSha256: 'ab'.repeat(32),
  servingCaPin: pins.servingCa,
  joinSigningPin: pins.joinSigning,
  joinEncryptionPin: pins.joinEncryption,
};

const out = {
  variables,
  pins,
  provision: {
    join: provision.bcdJoinArgv({
      ...variables,
      pins: { servingCaPin: pins.servingCa, joinSigningPin: pins.joinSigning, joinEncryptionPin: pins.joinEncryption },
    }),
    node: provision.bcdNodeArgv(),
    cloudInit: provision.renderTemplate(provision.bcdHostCloudInit, variables),
    ignition: provision.renderTemplate(provision.bcdHostIgnition, variables),
  },
  robot: {
    join: hetzner.robotJoinArgv(variables.controlPlaneUrl, pins),
    script: hetzner.bootstrapScript({
      hostname: variables.hostname,
      image: 'Ubuntu-2404-noble-amd64-base.tar.gz',
      bcdUrl: variables.bcdUrl,
      sha256: variables.bcdSha256,
      controlPlaneUrl: variables.controlPlaneUrl,
      pins,
    }),
  },
};

const file = join(root, 'daemon/cmd/bcd/testdata/install-contract.json');
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${file}`);
