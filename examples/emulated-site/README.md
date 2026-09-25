# Emulated site: bare metal on QEMU/KVM

> **Requires Linux + KVM** (`/dev/kvm`), plus QEMU, libvirt, [sushy-tools](https://docs.openstack.org/sushy-tools/) and a `bcd` build (Go). None of these run in this repository's CI; the smoke test only checks that the configuration loads and passes `doctor`.

The metal walkthrough of PLAN.md §5.6 without hardware. Each piece stands in for a real one:

| Real site                                                | Emulated here                                                  |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| Servers with BMCs                                        | QEMU/KVM virtual machines under libvirt                        |
| Redfish on the BMC                                       | `sushy-emulator` (Redfish over libvirt)                        |
| Site services: DHCP proxy, iPXE, image cache, BMC access | `bcd site` on the libvirt bridge                               |
| Disks wiped and imaged                                   | virtual disks, wiped through the ramdisk agent (`bcd ramdisk`) |

The configuration registers the `emulated-redfish` hardware profile (`power`/`management`: redfish, `boot`: ipxe, `deploy`: image-stream). Pools that name it in `policy.hardwareProfile` drive the emulated BMCs.

## Outline

```sh
# 1. Two VMs that PXE boot first, on a libvirt network the site agent serves.
virt-install --name bm-1 --memory 8192 --vcpus 4 --disk size=40 --pxe --network network=bc-site --noautoconsole
virt-install --name bm-2 --memory 8192 --vcpus 4 --disk size=40 --pxe --network network=bc-site --noautoconsole

# 2. Redfish BMCs for them.
sushy-emulator --libvirt-uri qemu:///system --port 8000

# 3. The control plane with the PKI bundle and a gateway (see examples/postgres for the certificate).
better-compute pki init --trust-domain site.example.test
better-compute serve

# 4. A site, its site agent, and a metal pool on the emulated profile. (siteTokens.create is planned;
#    until it lands, the site agent joins with a join token of role site.)
better-compute api sites.create tenantId=$TENANT kind=shared region=lab-1
better-compute api pools.create tenantId=$TENANT siteId=site_… class=metal-host policy:='{"hardwareProfile":"emulated-redfish"}'

# 5. Enroll the machines by their BMC addresses (sushy-emulator's Systems), then move them through the
#    metal lifecycle: manage (take control), inspect, provide (clean → ready), deploy.
better-compute api metal.enroll …
better-compute api metal.manage …
better-compute api metal.inspect …
better-compute api metal.provide …
better-compute api metal.deploy …
```

Inspect PXE-boots each machine into the ramdisk agent and inventories it. Provide wipes it (an attested wipe) and makes it `ready`. Deploy streams an image, installs `bcd` with a join token and reboots, and the machine then joins like any adopted server. `better-compute api workflows.list` shows each step. The [metal reference](../../apps/docs/content/docs/reference/api/metal.mdx) lists every verb and the IAM action it needs.
