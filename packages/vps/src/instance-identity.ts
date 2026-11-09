import { ComputeError } from '@better-compute/core';
import { fail } from './input.js';

// (U-04) What a tenant calls its instances and sandboxes: a display name, free-form metadata and labels, all
// mutable (`instances.update`, `sandboxes.update`); and the platform's provenance (`issuedBy`), which only root
// callers write. Names and metadata live in better-compute only. Labels follow Compute Engine's rules, since a
// provider pool also writes them on the machine and its boot disk; better-compute's own label keys
// (`better-compute-*`) and the `bc-` prefix of its network tags and resource names are never a tenant's.

/** Key prefixes better-compute keeps for itself, in labels and metadata alike. */
export const reservedKeyPrefixes: readonly string[] = ['better-compute-', 'bc-'];

/** Whether a label or metadata key is better-compute's own (compared lower-cased). */
export function reservedKey(key: string): boolean {
  const lower = key.toLowerCase();
  return reservedKeyPrefixes.some((prefix) => lower.startsWith(prefix));
}

/**
 * At most this many labels per instance: Compute Engine allows 64 per VM, and better-compute writes
 * two of its own (`better-compute-managed`, `better-compute-instance`).
 */
export const maxInstanceLabels = 62;
/** A GCE label key: a lower-case letter, then lower-case letters, digits, `_` and `-`; at most 63. */
export const labelKeyPattern = /^[a-z][a-z0-9_-]{0,62}$/;
/** A GCE label value: lower-case letters, digits, `_` and `-`; at most 63, possibly empty. */
export const labelValuePattern = /^[a-z0-9_-]{0,63}$/;

/** Labels (`instances.create|update`, `sandboxes.create|update`), checked against Compute Engine's label rules. */
export function instanceLabels(value: unknown, field = 'labels'): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return fail(`${field} must be an object of label keys to values`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > maxInstanceLabels)
    return fail(`${field} may hold at most ${maxInstanceLabels} labels`);
  const labels: Record<string, string> = {};
  for (const [labelKey, labelValue] of entries) {
    if (!labelKeyPattern.test(labelKey))
      return fail(
        `${field}: ${JSON.stringify(labelKey)} is not a label key (a lower-case letter, then lower-case letters, digits, _ or -; at most 63)`,
      );
    if (reservedKey(labelKey))
      return fail(
        `${field}: keys starting with ${reservedKeyPrefixes.join(' or ')} are better-compute's own`,
      );
    if (typeof labelValue !== 'string' || !labelValuePattern.test(labelValue))
      return fail(
        `${field}.${labelKey} must be lower-case letters, digits, _ or - (at most 63 characters)`,
      );
    labels[labelKey] = labelValue;
  }
  return labels;
}

/** The longest display name. */
export const maxDisplayNameLength = 128;
const controlCharacters = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** A display name: 1 to 128 characters, no control characters, no leading or trailing whitespace. */
export function displayName(value: unknown, field = 'name'): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxDisplayNameLength ||
    controlCharacters.test(value) ||
    value.trim() !== value
  )
    fail(
      `${field} must be 1-${maxDisplayNameLength} characters without control characters or surrounding whitespace`,
    );
  return value;
}

/** At most this many metadata entries. */
export const maxMetadataEntries = 64;
/** A metadata key: a letter or digit, then letters, digits, `.`, `_`, `/` or `-`; at most 128. */
export const metadataKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
/** The longest metadata value. */
export const maxMetadataValueLength = 1024;
/** The most metadata as JSON. */
export const maxMetadataBytes = 16 * 1024;

/** Metadata (`instances.create|update`, `sandboxes.create|update`): string values only, never sent to a provider. */
export function instanceMetadata(value: unknown, field = 'metadata'): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return fail(`${field} must be an object of keys to string values`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > maxMetadataEntries)
    return fail(`${field} may hold at most ${maxMetadataEntries} entries`);
  const metadata: Record<string, string> = {};
  for (const [entryKey, entryValue] of entries) {
    if (!metadataKeyPattern.test(entryKey))
      return fail(
        `${field}: ${JSON.stringify(entryKey)} is not a metadata key (a letter or digit, then letters, digits, . _ / or -; at most 128)`,
      );
    if (reservedKey(entryKey))
      return fail(
        `${field}: keys starting with ${reservedKeyPrefixes.join(' or ')} are better-compute's own`,
      );
    if (typeof entryValue !== 'string' || entryValue.length > maxMetadataValueLength)
      return fail(
        `${field}.${entryKey} must be a string of at most ${maxMetadataValueLength} characters`,
      );
    metadata[entryKey] = entryValue;
  }
  if (Buffer.byteLength(JSON.stringify(metadata)) > maxMetadataBytes)
    return fail(`${field} may hold at most ${maxMetadataBytes / 1024} KiB as JSON`);
  return metadata;
}

/** Who issued an instance, as the platform names it (`legionedge:admin`, `ops@example.com`). */
export const issuedByPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/;

export function issuedBy(value: unknown, field = 'issuedBy'): string {
  if (typeof value !== 'string' || !issuedByPattern.test(value))
    fail(
      `${field} must be 1-128 letters, digits, . _ : @ / + or -, starting with a letter or digit`,
    );
  return value;
}

/** `details.reason` when a caller other than the platform sets `issuedBy`. */
export const issuedByPlatformOnly = 'issued-by-platform-only';

/**
 * `issuedBy` is the platform's provenance: only a root caller sets or changes it. Anyone else is ACCESS_DENIED
 * before any decision.
 */
export function assertPlatformProvenance(platform: boolean): void {
  if (!platform)
    throw new ComputeError(
      'ACCESS_DENIED',
      'Only the platform (a root caller) records who issued an instance',
      undefined,
      { reason: issuedByPlatformOnly, field: 'issuedBy' },
    );
}

// --- Label selectors ------------------------------------------------------------------------------

/** One requirement of a label selector. */
export type LabelRequirement =
  | { key: string; op: 'eq' | 'ne'; value: string }
  | { key: string; op: 'exists' | 'absent' }
  | { key: string; op: 'in' | 'notin'; values: string[] };

/** The longest label selector, and the most requirements in one. */
export const maxLabelSelectorLength = 1024;
export const maxLabelRequirements = 20;

/** Splits on commas outside parentheses. */
function requirementsOf(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < selector.length; index++) {
    const char = selector[index];
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === ',' && depth === 0) {
      parts.push(selector.slice(start, index));
      start = index + 1;
    }
    if (depth < 0 || depth > 1) fail('labelSelector has unbalanced parentheses');
  }
  if (depth !== 0) fail('labelSelector has unbalanced parentheses');
  parts.push(selector.slice(start));
  return parts.map((part) => part.trim());
}

function selectorKey(key: string): string {
  if (!labelKeyPattern.test(key)) fail(`labelSelector: ${JSON.stringify(key)} is not a label key`);
  return key;
}

function selectorValue(value: string): string {
  if (!labelValuePattern.test(value))
    fail(`labelSelector: ${JSON.stringify(value)} is not a label value`);
  return value;
}

/**
 * Parses a label selector, as Kubernetes writes them: comma-separated requirements that must all hold, each
 * `key=value` (or `==`), `key!=value` (also true without the key), `key` (has it), `!key` (lacks it),
 * `key in (a,b)` or `key notin (a,b)` (also true without the key). INVALID_INPUT otherwise.
 */
export function parseLabelSelector(value: unknown): LabelRequirement[] {
  if (typeof value !== 'string' || value.length > maxLabelSelectorLength)
    fail(`labelSelector must be a string of at most ${maxLabelSelectorLength} characters`);
  if (value.trim() === '') return [];
  const parts = requirementsOf(value);
  if (parts.length > maxLabelRequirements)
    fail(`labelSelector may hold at most ${maxLabelRequirements} requirements`);
  return parts.map((part): LabelRequirement => {
    if (part === '') fail('labelSelector has an empty requirement');
    const set = /^([a-z][a-z0-9_-]*)\s+(in|notin)\s*\(([^()]*)\)$/.exec(part);
    if (set) {
      if (set[3]!.trim() === '') fail('labelSelector: a set holds 1 to 32 values');
      const values = set[3]!.split(',').map((entry) => selectorValue(entry.trim()));
      if (values.length === 0 || values.length > 32)
        fail('labelSelector: a set holds 1 to 32 values');
      return {
        key: selectorKey(set[1]!),
        op: set[2] as 'in' | 'notin',
        values: [...new Set(values)],
      };
    }
    const compare = /^([^=!\s]+)\s*(==|=|!=)\s*([^=!\s]*)$/.exec(part);
    if (compare)
      return {
        key: selectorKey(compare[1]!),
        op: compare[2] === '!=' ? 'ne' : 'eq',
        value: selectorValue(compare[3]!),
      };
    const absent = /^!\s*(\S+)$/.exec(part);
    if (absent) return { key: selectorKey(absent[1]!), op: 'absent' };
    return { key: selectorKey(part), op: 'exists' };
  });
}

/**
 * The SQL condition of a parsed selector over a `jsonb` labels column (NULL: no labels), pushing its values into
 * `params`; `TRUE` for none.
 */
export function labelSelectorSql(
  requirements: readonly LabelRequirement[],
  column: string,
  params: unknown[],
): string {
  const param = (value: unknown, cast: string) => {
    params.push(value);
    return `$${params.length}::${cast}`;
  };
  const clauses = requirements.map((requirement) => {
    const key = param(requirement.key, 'text');
    switch (requirement.op) {
      case 'eq':
        // Containment, so the labels' GIN index (vps/0046) can answer it.
        return `${column} @> jsonb_build_object(${key}, ${param(requirement.value, 'text')})`;
      case 'ne':
        return `(${column} ->> ${key}) IS DISTINCT FROM ${param(requirement.value, 'text')}`;
      case 'exists':
        return `(${column} -> ${key}) IS NOT NULL`;
      case 'absent':
        return `(${column} -> ${key}) IS NULL`;
      case 'in':
        return `(${column} ->> ${key}) = ANY(${param(requirement.values, 'text[]')})`;
      case 'notin':
        return `coalesce(NOT ((${column} ->> ${key}) = ANY(${param(requirement.values, 'text[]')})), true)`;
    }
  });
  return clauses.length === 0 ? 'TRUE' : clauses.join(' AND ');
}

// --- JSON Schema fragments (the generated reference and tool schemas) --------------------------------

export const identitySchemas = {
  labels: {
    type: 'object',
    maxProperties: maxInstanceLabels,
    propertyNames: { pattern: labelKeyPattern.source },
    additionalProperties: { type: 'string', pattern: labelValuePattern.source, maxLength: 63 },
    description:
      'Labels: GCE label rules, at most 62; keys starting with better-compute- or bc- are reserved. In provider pools also written on the machine and its boot disk',
  },
  name: {
    type: 'string',
    maxLength: maxDisplayNameLength,
    description:
      'A display name: 1-128 characters, no control characters or surrounding whitespace',
  },
  metadata: {
    type: 'object',
    maxProperties: maxMetadataEntries,
    propertyNames: { pattern: metadataKeyPattern.source },
    additionalProperties: { type: 'string', maxLength: maxMetadataValueLength },
    description:
      'Free-form string metadata kept by better-compute only (at most 64 entries, 16 KiB); keys starting with better-compute- or bc- are reserved',
  },
  issuedBy: {
    type: 'string',
    pattern: issuedByPattern.source,
    maxLength: 128,
    description: 'Who issued the instance (root callers only): the platform’s provenance',
  },
  labelSelector: {
    type: 'string',
    maxLength: maxLabelSelectorLength,
    description:
      'Label requirements that must all hold, comma-separated: key=value, key!=value, key, !key, key in (a,b), key notin (a,b)',
  },
} as const;
