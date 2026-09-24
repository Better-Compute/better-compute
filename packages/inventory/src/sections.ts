import { createHash } from 'node:crypto';
import { ComputeError } from '@better-compute/core';
import {
  INVENTORY_SECTIONS,
  ProtocolError,
  decodeInventorySection,
  isInventorySectionName,
  type InventorySectionContent,
  type InventorySectionName,
} from '@better-compute/protocol';

// Section transfer (PLAN.md §10.1). The daemon canonicalizes each section, encodes it and sends
// the SHA-256 of those bytes. The control plane pulls only the sections whose hash changed,
// checks every content against its hash over the received bytes, and never re-encodes to compare,
// so only the daemon's encoding has to be stable.

/** One section as `InventorySection` carries it. */
export interface ReportedSection {
  section: string;
  content: Uint8Array;
  /** 32 bytes as the wire carries it, or 64 hex digits as the store keeps it. */
  sha256: Uint8Array | string;
}

/** A verified, decoded section and its lowercase hex hash. */
export interface VerifiedSection<N extends InventorySectionName = InventorySectionName> {
  name: N;
  sha256: string;
  content: InventorySectionContent<N>;
}

/** Section name → lowercase hex SHA-256, as stored in `inventory_snapshots.section_hashes`. */
export type SectionHashes = Partial<Record<InventorySectionName, string>>;

/** The decoded sections of one node, as far as they are known. */
export type InventorySections = { [N in InventorySectionName]?: InventorySectionContent<N> };

/** A section may hold at most this many bytes (the frame cap keeps real ones far below it). */
export const maxSectionBytes = 1 << 20;

/** Lowercase hex of `bytes`. */
export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');
}

/** Lowercase hex SHA-256 of `bytes`. */
export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const hexHash = /^[0-9a-f]{64}$/;

/** Accepts a hash as 32 bytes or 64 hex digits; returns lowercase hex, or undefined when malformed. */
export function normalizeHash(hash: Uint8Array | string): string | undefined {
  if (typeof hash === 'string') {
    const lower = hash.toLowerCase();
    return hexHash.test(lower) ? lower : undefined;
  }
  return hash instanceof Uint8Array && hash.byteLength === 32 ? toHex(hash) : undefined;
}

/**
 * Checks one reported section against its hash and decodes it. Throws `ComputeError('INVALID_INPUT')`
 * for an unknown section name, a malformed or mismatched hash, an oversized content or bytes that
 * do not decode as that section's message.
 */
export function verifySection(reported: ReportedSection): VerifiedSection {
  const { section, content } = reported;
  if (!isInventorySectionName(section))
    throw new ComputeError('INVALID_INPUT', `Unknown inventory section ${JSON.stringify(section)}`);
  if (!(content instanceof Uint8Array))
    throw new ComputeError('INVALID_INPUT', `Section ${section} has no content bytes`);
  if (content.byteLength > maxSectionBytes)
    throw new ComputeError(
      'INVALID_INPUT',
      `Section ${section} is ${content.byteLength} bytes; the limit is ${maxSectionBytes}`,
    );
  const claimed = normalizeHash(reported.sha256);
  if (claimed === undefined)
    throw new ComputeError('INVALID_INPUT', `Section ${section} carries a malformed sha256`);
  const actual = sha256Hex(content);
  if (actual !== claimed)
    throw new ComputeError(
      'INVALID_INPUT',
      `Section ${section} does not match its sha256 (claimed ${claimed}, computed ${actual})`,
    );
  let decoded: InventorySectionContent<InventorySectionName>;
  try {
    decoded = decodeInventorySection(section, content);
  } catch (error) {
    if (error instanceof ProtocolError)
      throw new ComputeError('INVALID_INPUT', `Section ${section} does not decode: ${error.message}`);
    throw error;
  }
  return { name: section, sha256: actual, content: decoded } as VerifiedSection;
}

/**
 * Normalizes the `inventory_hashes` map a Hello or heartbeat carries: section names this build
 * knows, hashes as lowercase hex. Unknown names (a newer daemon) are dropped; a malformed hash for
 * a known name throws `INVALID_INPUT`.
 */
export function normalizeSectionHashes(
  reported: Readonly<Record<string, Uint8Array | string>>,
): SectionHashes {
  const hashes: SectionHashes = {};
  for (const name of INVENTORY_SECTIONS) {
    if (!Object.hasOwn(reported, name)) continue;
    const hash = normalizeHash(reported[name]!);
    if (hash === undefined)
      throw new ComputeError('INVALID_INPUT', `inventory hash for ${name} is malformed`);
    hashes[name] = hash;
  }
  return hashes;
}

/**
 * The sections to pull (`Welcome.request_sections`): every section whose reported hash differs
 * from the stored one, in section order. A section the node stopped reporting is not requested;
 * `mergeSections` drops it.
 */
export function sectionsToRequest(
  stored: SectionHashes,
  reported: SectionHashes,
): InventorySectionName[] {
  return INVENTORY_SECTIONS.filter(
    (name) => reported[name] !== undefined && reported[name] !== stored[name],
  );
}

/**
 * The digest of a whole snapshot (`inventory_snapshots.sha256`): SHA-256 over `name=hex\n` for
 * every present section in section order. Equal digests mean equal section hashes.
 */
export function inventoryDigest(hashes: SectionHashes): string {
  let text = '';
  for (const name of INVENTORY_SECTIONS) {
    const hash = hashes[name];
    if (hash !== undefined) text += `${name}=${hash}\n`;
  }
  return sha256Hex(text);
}

/** The result of folding pulled sections into what was stored. */
export interface MergedInventory {
  hashes: SectionHashes;
  sections: InventorySections;
  digest: string;
  /** Sections whose content changed, in section order. */
  changed: InventorySectionName[];
  /** Sections the node no longer reports. */
  removed: InventorySectionName[];
}

/**
 * Folds verified sections into the previous snapshot. `reported` is the node's full hash map: a
 * stored section it no longer lists is removed, and every section it lists must then be either
 * unchanged or among `pulled`. Throws `INVALID_INPUT` when a pulled section's hash is not the
 * reported one, or when a changed section was not pulled.
 */
export function mergeSections(
  previous: { hashes: SectionHashes; sections: InventorySections },
  reported: SectionHashes,
  pulled: readonly VerifiedSection[],
): MergedInventory {
  const byName = new Map<InventorySectionName, VerifiedSection>();
  for (const section of pulled) {
    if (reported[section.name] !== section.sha256)
      throw new ComputeError(
        'INVALID_INPUT',
        `Section ${section.name} was pulled with hash ${section.sha256}, but the node reported ${reported[section.name] ?? 'none'}`,
      );
    byName.set(section.name, section);
  }
  const hashes: SectionHashes = {};
  const sections: InventorySections = {};
  const changed: InventorySectionName[] = [];
  const removed: InventorySectionName[] = [];
  for (const name of INVENTORY_SECTIONS) {
    const hash = reported[name];
    if (hash === undefined) {
      if (previous.hashes[name] !== undefined) removed.push(name);
      continue;
    }
    const fresh = byName.get(name);
    if (fresh) {
      (sections as Record<string, unknown>)[name] = fresh.content;
      if (previous.hashes[name] !== hash) changed.push(name);
    } else if (previous.hashes[name] === hash && previous.sections[name] !== undefined) {
      (sections as Record<string, unknown>)[name] = previous.sections[name];
    } else {
      throw new ComputeError(
        'INVALID_INPUT',
        `Section ${name} changed (hash ${hash}) but its content was not pulled`,
      );
    }
    hashes[name] = hash;
  }
  return { hashes, sections, digest: inventoryDigest(hashes), changed, removed };
}
