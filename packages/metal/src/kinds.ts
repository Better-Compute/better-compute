// Bare-metal driver kinds (PLAN.md §5.4, §11.3), merged into @better-compute/core's `DriverKinds`,
// so `defineDriver({ implements: { power: … } })` type-checks wherever this package is imported.
// Several kinds implemented by one driver make an Ironic hardware type (redfish: power, management,
// virtual-media, inspect). Drivers run on a site agent, a ramdisk or the control plane.
import type {
  DriverConcern,
  DuplexStream,
  Phase,
  PowerAction,
  PowerState,
  Progress,
  ResolvedImage,
  SecretRef,
  WipeMode,
} from '@better-compute/core';
import type { NodeInventory } from '@better-compute/protocol';

/** A file the site agent serves or a ramdisk fetches, pinned by digest. */
export interface BootArtifact {
  url: string;
  /** Hex SHA-256. */
  sha256: string;
}

/** CPU architecture of a machine being booted (linux/amd64 and linux/arm64, §6). */
export type BootArch = 'x86_64' | 'arm64';

/** A boot source the BMC can select: network (PXE, UEFI HTTP), local disk, or virtual CD. */
export type BootDevice = 'pxe' | 'http' | 'disk' | 'cd';
/** How `management.setBootDevice` applies the device. */
export interface BootDeviceOptions {
  /** Keep the setting across boots (otherwise one-time, the next boot only). */
  persistent: boolean;
  uefi: boolean;
}

/** What `boot.prepareRamdisk` sets up: a proxy-DHCP entry and an HTTPS iPXE script (§3.5). */
export interface RamdiskSpec {
  /** The platform-signed ramdisk kernel and initramfs. */
  kernel: BootArtifact;
  initrd: BootArtifact;
  /** Extra kernel command-line arguments. */
  cmdline?: readonly string[];
  /** PXE MACs the entry answers, lower-case colon form. */
  macs: readonly string[];
  /** SMBIOS product UUID, when known; the discovery credential is bound to it. */
  productUuid?: string;
  arch: BootArch;
  uefi: boolean;
  /** The workflow the boot belongs to; the discovery credential is bound to it. */
  workflowId: string;
  /** The single-use `discovery` join token, as a secret reference; never a value. */
  joinToken: SecretRef;
  /** When the entry lapses (epoch milliseconds). */
  notAfter: number;
}

/** What `boot.prepareInstance` sets up once the image is written: the machine boots its own disk. */
export interface InstanceBoot {
  macs: readonly string[];
  arch: BootArch;
  uefi: boolean;
  workflowId: string;
}

/** The disk an image is written to, by stable id (§10.1). */
export interface DiskSelector {
  wwn?: string;
  serial?: string;
}

/** What `deploy.deploy` writes: an image streamed from the site cache, its sha256 checked inline. */
export interface DeploySpec {
  image: ResolvedImage;
  /** Absent: the driver's default root disk. */
  rootDisk?: DiskSelector;
  /**
   * Rendered user data (cloud-init, ignition). It embeds a single-use `provisioned` join token, so
   * it travels as a secret reference.
   */
  userData?: SecretRef;
  uefi: boolean;
}

/** Power control through the BMC (Redfish `ResetType`, IPMI chassis control). */
export interface PowerDriver {
  getPower(): Promise<PowerState>;
  setPower(action: PowerAction): Promise<void>;
}

/** Boot-device selection through the BMC. */
export interface ManagementDriver {
  setBootDevice(device: BootDevice, options: BootDeviceOptions): Promise<void>;
  /**
   * Sets the BMC account's password (Redfish AccountService, or the vendor's way), then proves it by
   * logging in with it. Vendor rules (length, character classes, lockouts) are the driver's to meet
   * or reject. Runs on the site agent (`bmc.rotate`), which fetches `newPassword` as a JWE.
   */
  rotateCredential?(newPassword: string, options?: { username?: string }): Promise<{ verified: boolean }>;
}

/** Network boot on the site agent holding the boot lease: PXE, iPXE, UEFI HTTP. */
export interface BootDriver {
  prepareRamdisk(ramdisk: RamdiskSpec): Promise<void>;
  prepareInstance(instance: InstanceBoot): Promise<void>;
  /** Removes every boot entry the driver made for the node; an absent entry counts as removed. */
  cleanUp(): Promise<void>;
}

/** Writing and erasing disks, from the ramdisk (image-stream, kexec) or a provider's rescue system. */
export interface DeployDriver {
  deploy(spec: DeploySpec): AsyncIterable<Progress>;
  /** Erases the machine on release; `ready` follows only a verified wipe (§11.1). */
  tearDown(options: { wipe: WipeMode }): AsyncIterable<Progress>;
}

/** Hardware inspection, in band (the ramdisk or node agent) or out of band (Redfish). */
export interface InspectDriver {
  inspect(): Promise<NodeInventory>;
}

/** BMC virtual media. */
export interface VirtualMediaDriver {
  /** Mounts the ISO at `iso` (an HTTPS URL, usually the site cache's). */
  insert(iso: string): Promise<void>;
  eject(): Promise<void>;
}

/** DRAFT until v0.3 (tunnels): the serial console (Serial-over-LAN) as a byte stream. */
export interface ConsoleDriver {
  open(): Promise<DuplexStream>;
}

/** DRAFT until v0.5: BIOS/UEFI settings, as the BMC or vendor tool names them. */
export interface BiosDriver {
  getSettings(): Promise<Record<string, string>>;
  applySettings(settings: Readonly<Record<string, string>>): Promise<void>;
}

/** DRAFT until v0.5: one logical volume of a RAID layout. */
export interface RaidVolume {
  level: '0' | '1' | '5' | '6' | '10';
  /** Absent: the largest size the disks allow. */
  sizeGiB?: number;
  /** Member disks by WWN or serial; absent lets the controller choose. */
  disks?: readonly string[];
}
/** DRAFT until v0.5: hardware RAID. */
export interface RaidDriver {
  applyLayout(layout: { volumes: readonly RaidVolume[] }): AsyncIterable<Progress>;
  clear(): AsyncIterable<Progress>;
}

/** DRAFT until v0.5: one updatable firmware component (BMC, BIOS, NIC, GPU VBIOS, …). */
export interface FirmwareComponent {
  id: string;
  name?: string;
  version: string;
}
/** DRAFT until v0.5: firmware inventory and updates. */
export interface FirmwareDriver {
  components(): Promise<FirmwareComponent[]>;
  update(component: string, image: BootArtifact): AsyncIterable<Progress>;
}

declare module '@better-compute/core' {
  interface DriverKinds {
    power: PowerDriver;
    management: ManagementDriver;
    boot: BootDriver;
    deploy: DeployDriver;
    inspect: InspectDriver;
    'virtual-media': VirtualMediaDriver;
    console: ConsoleDriver;
    bios: BiosDriver;
    raid: RaidDriver;
    firmware: FirmwareDriver;
  }
}

/**
 * The driver kinds this package adds and the phase their built-in drivers arrive in. The `console`,
 * `bios`, `raid` and `firmware` operations are drafts until then.
 */
export const metalDriverKinds = Object.freeze({
  power: 'v0.2',
  management: 'v0.2',
  boot: 'v0.2',
  deploy: 'v0.2',
  inspect: 'v0.2',
  'virtual-media': 'v0.2',
  console: 'v0.3',
  bios: 'v0.5',
  raid: 'v0.5',
  firmware: 'v0.5',
} as const satisfies Partial<Record<DriverConcern, Phase>>);
/** A driver kind added by `@better-compute/metal`. */
export type MetalDriverKind = keyof typeof metalDriverKinds;
