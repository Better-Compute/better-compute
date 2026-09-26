import {
  ComputeError,
  isSecretRef,
  type ComputeModule,
  type Finding,
  type ModuleContext,
  type NodeRecord,
  type NodeRole,
  type NodeSpecPart,
  type SqlExecutor,
  type TelemetrySpec,
} from '@better-compute/core';

// bcd's own telemetry (PLAN.md P8): every node exports OTLP metrics (bcd.gpu.*, bcd.host.*) straight to
// a collector, never over the Session or into Postgres. This module tells each node where, through
// NodeSpec.telemetry: the platform's default from its options, a pool's `policy.telemetry` winning
// field by field.

export interface NodeTelemetryOptions extends TelemetrySpec {
  /** The node roles that export (default: all, site agents included). */
  roles?: readonly NodeRole[];
}

const attributeKey = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

/** Why a telemetry spec cannot be sent to nodes, or undefined when it can. */
export function telemetryProblem(spec: unknown): string | undefined {
  if (spec === undefined) return undefined;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return 'must be an object';
  const { otlpEndpoint, intervalSeconds, headersRef, resourceAttributes, ...rest } = spec as Record<
    string,
    unknown
  >;
  const unknown = Object.keys(rest).filter((key) => key !== 'roles');
  if (unknown.length)
    return `${unknown[0]} is not a setting (otlpEndpoint, intervalSeconds, headersRef, resourceAttributes)`;
  if (otlpEndpoint !== undefined) {
    let url: URL | undefined;
    try {
      url = typeof otlpEndpoint === 'string' ? new URL(otlpEndpoint) : undefined;
    } catch {
      url = undefined;
    }
    const local = url && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      !url ||
      url.username ||
      url.password ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && local))
    )
      return 'otlpEndpoint must be an https:// URL (http:// only for localhost)';
  }
  if (
    intervalSeconds !== undefined &&
    (typeof intervalSeconds !== 'number' ||
      !Number.isFinite(intervalSeconds) ||
      intervalSeconds < 5 ||
      intervalSeconds > 3600)
  )
    return 'intervalSeconds must be between 5 and 3600';
  if (headersRef !== undefined && !isSecretRef(headersRef))
    return 'headersRef must be a secret:// (or vault://, env://) reference';
  if (resourceAttributes !== undefined) {
    if (
      !resourceAttributes ||
      typeof resourceAttributes !== 'object' ||
      Array.isArray(resourceAttributes)
    )
      return 'resourceAttributes must be an object';
    const entries = Object.entries(resourceAttributes as Record<string, unknown>);
    if (entries.length > 32) return 'resourceAttributes has more than 32 entries';
    for (const [key, value] of entries) {
      if (!attributeKey.test(key) || key.startsWith('bcd.') || key.startsWith('service.'))
        return `resourceAttributes.${key}: not an attribute name bcd leaves to the operator (bcd.* and service.* are bcd's)`;
      if (
        typeof value !== 'string' ||
        value.length > 256 ||
        /[\r\n=]/.test(key) ||
        /[\r\n]/.test(value)
      )
        return `resourceAttributes.${key} must be a single-line string of at most 256 characters`;
    }
  }
  return undefined;
}

function pick(spec: TelemetrySpec): TelemetrySpec {
  const out: TelemetrySpec = {};
  if (spec.otlpEndpoint !== undefined) out.otlpEndpoint = spec.otlpEndpoint;
  if (spec.intervalSeconds !== undefined) out.intervalSeconds = spec.intervalSeconds;
  if (spec.headersRef !== undefined) out.headersRef = spec.headersRef;
  if (spec.resourceAttributes !== undefined)
    out.resourceAttributes = { ...spec.resourceAttributes };
  return out;
}

/** The pool's `policy.telemetry`, or undefined when it has none or it is invalid (a doctor finding). */
async function poolTelemetry(sql: SqlExecutor, poolId: string): Promise<TelemetrySpec | undefined> {
  const { rows } = await sql.query<{ telemetry: unknown }>(
    `SELECT policy->'telemetry' AS telemetry FROM pools WHERE id = $1`,
    [poolId],
  );
  const telemetry = rows[0]?.telemetry ?? undefined;
  if (telemetry === undefined || telemetry === null || telemetryProblem(telemetry))
    return undefined;
  return pick(telemetry as TelemetrySpec);
}

/**
 * NodeSpec.telemetry for every node: `options` (the platform's collector), and per pool
 * `policy.telemetry` field by field over it. A node gets one telemetry part, or none when no endpoint
 * results. Options are validated here; an invalid pool policy is skipped (see
 * `nodeTelemetryFindings`) rather than breaking its nodes' specs.
 */
export function nodeTelemetryModule(
  options: NodeTelemetryOptions = {},
): ComputeModule<'node-telemetry'> {
  const { roles, ...defaults } = options;
  const exporting = roles ? new Set<NodeRole>(roles) : undefined;
  const problem = telemetryProblem(defaults);
  if (problem) throw new ComputeError('INVALID_INPUT', `nodeTelemetryModule: ${problem}`);
  const base = pick(defaults);
  return {
    name: 'node-telemetry',
    async nodeSpec(context: ModuleContext, node: NodeRecord): Promise<NodeSpecPart> {
      if (exporting && !exporting.has(node.role)) return {};
      const pool = node.poolId ? await poolTelemetry(context.sql, node.poolId) : undefined;
      const telemetry: TelemetrySpec = { ...base, ...pool };
      if (base.resourceAttributes || pool?.resourceAttributes)
        telemetry.resourceAttributes = { ...base.resourceAttributes, ...pool?.resourceAttributes };
      return telemetry.otlpEndpoint ? { telemetry } : {};
    },
  };
}

/** `doctor`: pools whose `policy.telemetry` cannot be sent to their nodes (their nodes use the defaults). */
export async function nodeTelemetryFindings(sql: Pick<SqlExecutor, 'query'>): Promise<Finding[]> {
  const { rows } = await sql.query<{ id: string; telemetry: unknown }>(
    `SELECT id, policy->'telemetry' AS telemetry FROM pools WHERE policy ? 'telemetry' ORDER BY id`,
  );
  const bad = rows.flatMap((row) => {
    const problem = telemetryProblem(row.telemetry);
    return problem ? [`${row.id}: ${problem}`] : [];
  });
  if (!bad.length) return [];
  return [
    {
      check: 'pool-telemetry-invalid',
      severity: 'warning',
      message: `${bad.length} pools have a policy.telemetry their nodes cannot use (${bad.slice(0, 3).join('; ')}${bad.length > 3 ? '; …' : ''})`,
      fix: 'Fix the pools’ policy.telemetry with pools.update; until then their nodes export to the default collector (or none)',
      count: bad.length,
    },
  ];
}
