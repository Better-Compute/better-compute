import {
  ComputeError,
  field,
  manifest,
  type HostSpec,
  type Json,
  type Manifest,
  type ModuleContext,
  type NodeRecord,
  type NodeSpec,
  type NodeSpecPart,
  type SqlTx,
} from '@better-compute/core';
import { evaluateWhen } from './expand.js';
import type { ImageUseOptions } from './images.js';
import { siteCacheImagesFor } from './site-cache.js';

// Config units (PLAN.md §11.2, §11.3): a profile's `hostConfig` becomes the node's desired state
// after join (NodeSpec `host.config`), so the daemon's converger keeps correcting drift. Each unit
// has a settings manifest; `when:` (the §11.2 label expression) turns a unit on per node, and
// `mig-layout` may take its layout from the pool (`from: 'pool'`).

/** A config unit kind: its settings manifest. */
export interface ConfigUnitDefinition {
  name: string;
  settings: Manifest<Record<string, Json>>;
  description: string;
}

export const builtinConfigUnits: readonly ConfigUnitDefinition[] = Object.freeze([
  {
    name: 'nvidia-driver',
    description: 'The NVIDIA driver branch (and the open kernel modules or not)',
    settings: manifest({ branch: field.string({ pattern: '^[0-9]{3}$' }), open: field.boolean().optional() }) as Manifest<Record<string, Json>>,
  },
  {
    name: 'container-toolkit',
    description: 'The NVIDIA container toolkit, generating CDI specs',
    settings: manifest({ cdi: field.boolean().default(true) }) as Manifest<Record<string, Json>>,
  },
  {
    name: 'mig-layout',
    description: "A MIG layout: a named profile per GPU, or the pool's layout",
    settings: manifest({
      from: field.option(['pool', 'profile']).default('profile'),
      layout: field.string({ maxLength: 64 }).optional(),
    }) as Manifest<Record<string, Json>>,
  },
  {
    name: 'fabric-manager',
    description: 'NVIDIA Fabric Manager for NVSwitch systems',
    settings: manifest({}) as Manifest<Record<string, Json>>,
  },
  {
    name: 'sysctl',
    description: 'Kernel parameters',
    settings: manifest({}) as Manifest<Record<string, Json>>,
  },
]);

const sysctlKey = /^[a-z0-9_]+(?:\.[a-z0-9_-]+)+$/;

/** A unit's settings minus the unit-level `when:` key. */
function settingsOf(raw: Record<string, Json>): { when?: string; settings: Record<string, Json> } {
  const { when, ...settings } = raw;
  return typeof when === 'string' ? { when, settings } : { settings };
}

async function validateUnit(unit: ConfigUnitDefinition, name: string, settings: Record<string, Json>): Promise<Record<string, Json>> {
  if (name === 'sysctl') {
    // Free-form keys, but only sysctl names with scalar values.
    for (const [key, value] of Object.entries(settings))
      if (!sysctlKey.test(key) || !['string', 'number', 'boolean'].includes(typeof value))
        throw new ComputeError('INVALID_INPUT', `hostConfig.sysctl.${key} must be a sysctl name with a scalar value`);
    return settings;
  }
  const result = await unit.settings['~standard'].validate(settings);
  if ('issues' in result && result.issues)
    throw new ComputeError(
      'INVALID_INPUT',
      `hostConfig.${name}: ${result.issues.map((issue) => issue.message).join('; ')}`,
    );
  return (result as { value: Record<string, Json> }).value;
}

export interface ResolveHostConfigContext {
  /** The node's labels, for `when:`. */
  labels: Readonly<Record<string, string>>;
  /** The pool's policy, for `mig-layout: { from: 'pool' }` (`policy.migLayout`). */
  poolPolicy?: Readonly<Record<string, unknown>> | null;
}

/**
 * Resolves a profile's `hostConfig` for one node: units whose `when:` is false are left out, each
 * unit's settings are validated against its manifest (unknown units are `INVALID_INPUT`), and a pool
 * MIG layout is filled in. The result is the NodeSpec `host` section.
 */
export async function resolveHostConfig(
  hostConfig: Readonly<Record<string, Record<string, Json>>> | undefined,
  context: ResolveHostConfigContext,
  units: readonly ConfigUnitDefinition[] = builtinConfigUnits,
): Promise<HostSpec> {
  const byName = new Map(units.map((unit) => [unit.name, unit]));
  const config: Record<string, Record<string, Json>> = {};
  for (const [name, raw] of Object.entries(hostConfig ?? {})) {
    const unit = byName.get(name);
    if (!unit) throw new ComputeError('INVALID_INPUT', `hostConfig.${name} is not a known config unit`);
    const { when, settings } = settingsOf(raw);
    if (when !== undefined && !evaluateWhen(when, context.labels)) continue;
    const valid = await validateUnit(unit, name, settings);
    if (name === 'mig-layout' && valid.from === 'pool') {
      const layout = context.poolPolicy?.migLayout;
      if (typeof layout !== 'string') throw new ComputeError('INVALID_INPUT', 'hostConfig.mig-layout takes its layout from the pool, which has no policy.migLayout');
      valid.layout = layout;
    }
    config[name] = valid;
  }
  return Object.keys(config).length ? { config } : {};
}

/**
 * The NodeSpec contribution of provision (`ComputeModule.nodeSpec`): the `host` section from the
 * `hostConfig` of the last workflow that succeeded on the node, resolved for it.
 */
export async function hostSpecFor(
  sql: SqlTx,
  nodeId: string,
  units: readonly ConfigUnitDefinition[] = builtinConfigUnits,
): Promise<Partial<NodeSpec>> {
  // A pool layout change reaches a node only once capacity granted it (every atom free, §10.4):
  // until then the node keeps the layout capacity froze it at (provision/0004). Capacity's
  // `carriesPoolLayout` reads the same source (the last succeeded workflow's
  // profile_document->'hostConfig'): change both together.
  const { rows } = await sql.query<{
    host_config: Record<string, Record<string, Json>> | null;
    pool_policy: Record<string, unknown> | null;
    gated_layout: string | null;
  }>(
    `SELECT w.profile_document->'hostConfig' AS host_config, p.policy AS pool_policy,
            provision_gated_mig_layout(n.id) AS gated_layout
       FROM workflows w JOIN nodes n ON n.id = w.node_id LEFT JOIN pools p ON p.id = n.pool_id
      WHERE w.node_id = $1 AND w.state = 'succeeded' AND w.profile_document ? 'hostConfig'
      ORDER BY w.finished_at DESC NULLS LAST, w.id DESC LIMIT 1`,
    [nodeId],
  );
  const row = rows[0];
  if (!row?.host_config) return {};
  const labels = await sql.query<{ key: string; value: string }>('SELECT key, value FROM node_labels WHERE node_id = $1', [nodeId]);
  const poolPolicy = row.gated_layout !== null ? { ...(row.pool_policy ?? {}), migLayout: row.gated_layout } : row.pool_policy;
  const host = await resolveHostConfig(row.host_config, {
    labels: Object.fromEntries(labels.rows.map((label) => [label.key, label.value])),
    poolPolicy,
  }, units);
  return host.config ? { host } : {};
}

/**
 * `ComputeModule.nodeSpec` for provision: the `host` section, and for site agents `site.cacheImages`
 * (the verified images their site's pools pre-warm, §11.5; SiteBoot contributes `site.boot`).
 */
export function provisionNodeSpec(units?: readonly ConfigUnitDefinition[], images?: ImageUseOptions) {
  return async (context: ModuleContext, node: NodeRecord): Promise<NodeSpecPart> => {
    const part: NodeSpecPart = await hostSpecFor(context.sql, node.id, units);
    if (node.role === 'site') part.site = { cacheImages: await siteCacheImagesFor(context.sql, node.id, images) };
    return part;
  };
}
