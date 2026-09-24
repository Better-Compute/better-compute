import type { MessageShape } from '@bufbuild/protobuf';
import {
  BmcSectionSchema,
  CpuSectionSchema,
  DisksSectionSchema,
  GpusSectionSchema,
  MemorySectionSchema,
  NicsSectionSchema,
  OsSectionSchema,
  SystemSectionSchema,
} from './gen/bettercompute/agent/v1/inventory_pb.js';
import { ProtocolError } from './errors.js';
import { decodeMessage } from './frames.js';

/**
 * NodeInventory v1 section names, in NodeInventory field order. `InventorySection.section`,
 * `Hello.inventory_hashes` keys and `Welcome.request_sections` use them. Canonicalizing and hashing
 * a section is `@better-compute/inventory`'s job.
 */
export const INVENTORY_SECTIONS = [
  'system',
  'cpu',
  'memory',
  'disks',
  'nics',
  'gpus',
  'bmc',
  'os',
] as const;
/** A NodeInventory v1 section name. */
export type InventorySectionName = (typeof INVENTORY_SECTIONS)[number];

/** The message type of each section's `InventorySection.content`. */
export const inventorySectionSchemas = {
  system: SystemSectionSchema,
  cpu: CpuSectionSchema,
  memory: MemorySectionSchema,
  disks: DisksSectionSchema,
  nics: NicsSectionSchema,
  gpus: GpusSectionSchema,
  bmc: BmcSectionSchema,
  os: OsSectionSchema,
} as const;
/** The decoded content of one inventory section. */
export type InventorySectionContent<N extends InventorySectionName> = MessageShape<
  (typeof inventorySectionSchemas)[N]
>;

/** Whether `name` is a NodeInventory v1 section (own properties only). */
export const isInventorySectionName = (name: string): name is InventorySectionName =>
  Object.hasOwn(inventorySectionSchemas, name);

/**
 * Decode `InventorySection.content` for its section name. Does not check `sha256`; the caller
 * verifies it over the same bytes. Throws `ProtocolError('UNKNOWN_SECTION' | 'INVALID_FRAME')`.
 */
export function decodeInventorySection<N extends InventorySectionName>(
  section: N,
  content: Uint8Array,
): InventorySectionContent<N>;
export function decodeInventorySection(
  section: string,
  content: Uint8Array,
): InventorySectionContent<InventorySectionName>;
export function decodeInventorySection(
  section: string,
  content: Uint8Array,
): InventorySectionContent<InventorySectionName> {
  if (!isInventorySectionName(section))
    throw new ProtocolError('UNKNOWN_SECTION', `unknown inventory section ${section}`);
  return decodeMessage(inventorySectionSchemas[section], content);
}

/**
 * NodeSpec section names, in field order; the daemon's converger runs them in this order, and
 * `SectionStatus.section` uses them.
 */
export const NODE_SPEC_SECTIONS = [
  'host',
  'devices',
  'instances',
  'access',
  'telemetry',
  'daemon',
  'site',
] as const;
/** A NodeSpec section name. */
export type NodeSpecSectionName = (typeof NODE_SPEC_SECTIONS)[number];
