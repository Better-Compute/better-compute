// The IAM catalog compute installs on every IAM host (PLAN.md §12.3): core's normative resource types
// plus the catalogs of the modules and plugins in use, merged and checked against better-iam's limits.
// Browser-safe; no better-iam imports.

import {
  ComputeError,
  computeResourceTypes,
  resourceTypeLimits,
  type AttributeType,
  type ComputeModule,
  type ComputeResourceType,
} from '@better-compute/core';

/** Extra catalog entries: fully qualified actions and resource types keyed by kind (`widget`) or full type. */
export interface CatalogFragment {
  actions?: readonly string[];
  resourceTypes?: Readonly<Record<string, ComputeResourceType>>;
}

/** The merged catalog: what `computeIamPlugin` hands better-iam and what `initialize()` checks methods against. */
export interface ComputeCatalog {
  /** The resource type prefix, `compute-` by default. */
  readonly typePrefix: string;
  /** Resource types keyed by prefixed type name (`compute-pool`). */
  readonly resourceTypes: Readonly<Record<string, ComputeResourceType>>;
  /** Actions that belong to no resource type (a fragment's top-level `actions`). */
  readonly actions: readonly string[];
  /** Whether `action` is declared anywhere in the catalog. */
  has(action: string): boolean;
  /** Every declared action, deduplicated, in catalog order. */
  allActions(): string[];
}

export interface ComputeCatalogOptions {
  /** Default `compute-`. */
  typePrefix?: string;
  /** Modules whose `catalog` is merged in (`metal()`, `vps()`, …). The built-in catalog is always included. */
  modules?: readonly Pick<ComputeModule, 'name' | 'catalog'>[];
  /** Plugins (modules with an `id`); their actions must be `compute:<id>:<verb>`. */
  plugins?: readonly (Pick<ComputeModule, 'name' | 'catalog'> & { id?: string })[];
  extra?: readonly CatalogFragment[];
}

const actionPattern = /^compute:[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)+$/;
const attributeTypes: ReadonlySet<string> = new Set<AttributeType>(['string', 'number', 'boolean']);

function invalid(message: string): ComputeError {
  return new ComputeError('INVALID_CONFIG', message);
}

function qualify(name: string, prefix: string): string {
  return name.startsWith(prefix) ? name : `${prefix}${name}`;
}

function merge(
  target: Record<string, ComputeResourceType>,
  type: string,
  incoming: ComputeResourceType,
  prefix: string,
  source: string,
): void {
  if (type.length > resourceTypeLimits.typeLength)
    throw invalid(
      `${source}: resource type ${type} is longer than ${resourceTypeLimits.typeLength}`,
    );
  const parent = incoming.parent === undefined ? undefined : qualify(incoming.parent, prefix);
  const existing = target[type];
  const merged: ComputeResourceType = existing
    ? { ...existing }
    : { ...(incoming.description ? { description: incoming.description } : {}) };
  if (parent !== undefined) {
    if (merged.parent !== undefined && merged.parent !== parent)
      throw invalid(`${source}: ${type} has parent ${merged.parent}, not ${parent}`);
    merged.parent = parent;
  }
  for (const action of incoming.actions ?? []) {
    if (!actionPattern.test(action)) throw invalid(`${source}: invalid action ${action}`);
    merged.actions = [...new Set([...(merged.actions ?? []), action])];
  }
  for (const [name, kind] of Object.entries(incoming.attributes ?? {})) {
    if (!attributeTypes.has(kind))
      throw invalid(`${source}: attribute ${type}.${name} has invalid type ${String(kind)}`);
    const known = merged.attributes?.[name];
    if (known !== undefined && known !== kind)
      throw invalid(`${source}: attribute ${type}.${name} is ${known}, not ${kind}`);
    merged.attributes = { ...merged.attributes, [name]: kind };
  }
  for (const relation of incoming.relations ?? [])
    merged.relations = [...new Set([...(merged.relations ?? []), relation])];
  if (Object.keys(merged.attributes ?? {}).length > resourceTypeLimits.attributes)
    throw invalid(`${type} has more than ${resourceTypeLimits.attributes} attributes`);
  if ((merged.relations?.length ?? 0) > resourceTypeLimits.relations)
    throw invalid(`${type} has more than ${resourceTypeLimits.relations} relations`);
  target[type] = merged;
}

/**
 * Builds the catalog: core's resource types under `typePrefix`, then every module's, plugin's and extra
 * fragment's entries. Entries for the same type merge (actions, attributes and relations are unioned);
 * a conflicting attribute type or parent, an invalid action, or a limit breach throws `INVALID_CONFIG`.
 */
export function buildComputeCatalog(options: ComputeCatalogOptions = {}): ComputeCatalog {
  const prefix = options.typePrefix ?? 'compute-';
  const resourceTypes = computeResourceTypes(prefix);
  const loose: string[] = [];
  const fragments: { source: string; fragment: CatalogFragment; pluginId?: string }[] = [
    ...(options.modules ?? []).map((module) => ({
      source: `module ${module.name}`,
      fragment: module.catalog ?? {},
    })),
    ...(options.plugins ?? []).map((plugin) => ({
      source: `plugin ${plugin.id ?? plugin.name}`,
      fragment: plugin.catalog ?? {},
      pluginId: plugin.id ?? plugin.name,
    })),
    ...(options.extra ?? []).map((fragment, index) => ({ source: `extra[${index}]`, fragment })),
  ];
  for (const { source, fragment, pluginId } of fragments) {
    const ownedBy = pluginId === undefined ? undefined : `compute:${pluginId}:`;
    const checkOwner = (action: string) => {
      if (ownedBy !== undefined && !action.startsWith(ownedBy))
        throw invalid(`${source}: action ${action} must start with ${ownedBy}`);
    };
    for (const action of fragment.actions ?? []) {
      if (!actionPattern.test(action)) throw invalid(`${source}: invalid action ${action}`);
      checkOwner(action);
      if (!loose.includes(action)) loose.push(action);
    }
    for (const [name, type] of Object.entries(fragment.resourceTypes ?? {})) {
      for (const action of type.actions ?? []) checkOwner(action);
      merge(resourceTypes, qualify(name, prefix), type, prefix, source);
    }
  }
  for (const [type, definition] of Object.entries(resourceTypes))
    if (definition.parent !== undefined && !(definition.parent in resourceTypes))
      throw invalid(`${type} names parent ${definition.parent}, which is not in the catalog`);

  const all = [
    ...new Set([
      ...Object.values(resourceTypes).flatMap((definition) => definition.actions ?? []),
      ...loose,
    ]),
  ];
  const index = new Set(all);
  return Object.freeze({
    typePrefix: prefix,
    resourceTypes: Object.freeze(resourceTypes),
    actions: Object.freeze([...loose]),
    has: (action: string) => index.has(action),
    allActions: () => [...all],
  });
}
