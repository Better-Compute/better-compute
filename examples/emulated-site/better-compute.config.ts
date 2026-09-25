// The bare-metal walkthrough on an emulated site (requires Linux + KVM; see README.md): QEMU virtual
// machines stand in for servers, sushy-tools gives them a Redfish BMC, and a `bcd site` agent next to them
// runs DHCP proxy, iPXE and the image cache. Pools pick the `emulated-redfish` hardware profile
// (`policy.hardwareProfile`), so commission, deploy, release and retire drive the emulated BMCs.
import { defineConfig } from '@better-compute/server';
import { exampleHost, exampleOptions } from '../shared/compose.ts';

export const hardwareProfiles = {
  'emulated-redfish': {
    description: 'QEMU/KVM machines behind sushy-tools (Redfish), PXE-booted by the site agent',
    drivers: { power: 'redfish', management: 'redfish', boot: 'ipxe', deploy: 'image-stream' },
  },
};

export default defineConfig(({ env, cwd } = {}) =>
  exampleOptions({
    ...(env ? { env } : {}),
    ...(cwd ? { cwd } : {}),
    metal: { hardwareProfiles },
  }),
);

export const host = exampleHost;
