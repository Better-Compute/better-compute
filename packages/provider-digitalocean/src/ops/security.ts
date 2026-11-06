import { isComputeError, type ProviderContext, type ProviderFinding } from '@better-compute/core';
import { clientFor } from '../client/build.js';
import { readDeadline } from '../client/deadline.js';
import type { DoConfig, DoProviderOptions } from '../config.js';

// Security posture findings (DigitalOcean P9): the latest scan of DO's Security API, read-only (scope
// `security:read`, the `observe` budget), as data for the admin panel's attention list. The provider never starts a
// scan, suppresses a finding or changes a setting. The response shapes are the provider's reading of the API
// (unverified against a live account) and are parsed tolerantly: a finding without a rule id is left out, and a
// severity it does not know is `unknown`, never promoted.

export type DoFindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'unknown';

export interface DoSecurityFinding {
  /** DO's rule id: one finding per rule per scan. */
  rule: string;
  title: string;
  severity: DoFindingSeverity;
  foundAt?: number;
  affectedResources?: number;
  detail?: string;
  /** `<title>: <description>` per mitigation step, in order. */
  mitigation?: string[];
}

export interface DoSecurityReport {
  /** Absent when the account has never been scanned. */
  scan?: { id: string; status: string; createdAt?: number };
  /** Most severe first. */
  findings: DoSecurityFinding[];
}

const severities: readonly DoFindingSeverity[] = ['critical', 'high', 'medium', 'low', 'unknown'];
const readTimeoutMs = 30_000;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
const time = (value: unknown): number | undefined => {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
};

function findingOf(raw: Record<string, unknown>): DoSecurityFinding | undefined {
  const rule = text(raw.rule_uuid) ?? text(raw.rule_id);
  if (!rule) return undefined;
  const severity = (text(raw.severity)?.toLowerCase() ?? 'unknown') as DoFindingSeverity;
  const count = raw.affected_resources_count;
  const mitigation = Array.isArray(raw.mitigation_steps)
    ? (raw.mitigation_steps as Record<string, unknown>[])
        .map((step) => [text(step.title), text(step.description)].filter(Boolean).join(': '))
        .filter((step) => step !== '')
    : [];
  const finding: DoSecurityFinding = {
    rule,
    title: text(raw.name) ?? rule,
    severity: severities.includes(severity) ? severity : 'unknown',
  };
  const foundAt = time(raw.found_at);
  if (foundAt !== undefined) finding.foundAt = foundAt;
  if (typeof count === 'number' && Number.isInteger(count) && count >= 0)
    finding.affectedResources = count;
  const detail = text(raw.details) ?? text(raw.description);
  if (detail) finding.detail = detail;
  if (mitigation.length) finding.mitigation = mitigation;
  return finding;
}

/** The latest scan's findings, read with the account's own token. `ACCESS_DENIED` without `security:read`. */
export async function readSecurityFindings(
  config: DoConfig,
  context: ProviderContext & { signal?: AbortSignal },
  options: DoProviderOptions = {},
): Promise<DoSecurityReport> {
  const client = clientFor(config, context, options);
  const deadline = readDeadline(context, readTimeoutMs);
  let body: { scan?: Record<string, unknown> };
  try {
    body = await client.request('GET', '/security/scans/latest', {
      signal: deadline.signal,
      budget: 'observe',
    });
  } catch (error) {
    // No scan has run on this account yet.
    if (isComputeError(error, 'NOT_FOUND')) return { findings: [] };
    throw error;
  } finally {
    deadline.done();
  }
  const scan = body.scan;
  const id = text(scan?.id);
  if (!scan || !id) return { findings: [] };
  const findings = (
    Array.isArray(scan.findings) ? (scan.findings as Record<string, unknown>[]) : []
  )
    .map(findingOf)
    .filter((finding): finding is DoSecurityFinding => finding !== undefined)
    .sort((a, b) => severities.indexOf(a.severity) - severities.indexOf(b.severity));
  const createdAt = time(scan.created_at);
  return {
    scan: {
      id,
      status: (text(scan.status) ?? 'unknown').toLowerCase(),
      ...(createdAt !== undefined ? { createdAt } : {}),
    },
    findings,
  };
}

/** An admin panel attention item (`apps/admin` `AttentionItem`), as this package produces it. */
export interface DoAttentionItem {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  source: string;
  href: string;
  at: number;
  subject: string;
  group: string;
  action: { label: string; href: string };
}

const attentionSeverity: Record<DoFindingSeverity, DoAttentionItem['severity']> = {
  critical: 'critical',
  high: 'warning',
  medium: 'warning',
  low: 'info',
  unknown: 'info',
};

/**
 * The findings of one account as attention items, grouped by rule: a finding's time, else the scan's, else `now`.
 */
export function securityAttention(
  report: DoSecurityReport,
  account: { accountId: string; accountName: string; href: string; now?: number },
): DoAttentionItem[] {
  const fallback = report.scan?.createdAt ?? account.now ?? 0;
  return report.findings.map((finding) => {
    const detail = detailOf(finding);
    return {
      id: `do-security:${account.accountId}:${finding.rule}`,
      severity: attentionSeverity[finding.severity],
      title: `${finding.title} on ${account.accountName}`,
      detail,
      source: 'providers',
      href: account.href,
      at: finding.foundAt ?? fallback,
      subject: `provider-account/${account.accountId}`,
      group: finding.title,
      action: { label: 'Open the account', href: account.href },
    };
  });
}

/** The words of a finding's detail: the resources affected, then DO's own detail. */
function detailOf(finding: DoSecurityFinding): string {
  const count =
    finding.affectedResources === undefined
      ? undefined
      : `${finding.affectedResources} ${finding.affectedResources === 1 ? 'resource' : 'resources'} affected.`;
  return (
    [count, finding.detail].filter(Boolean).join(' ') ||
    'Found by the latest DigitalOcean security scan.'
  );
}

/** The report as provider findings (`providerAccounts.findings`): one per rule, a finding's time else the scan's. */
export function securityFindings(report: DoSecurityReport): ProviderFinding[] {
  const scanned = report.scan?.createdAt;
  return report.findings.map((finding) => {
    const at = finding.foundAt ?? scanned;
    return {
      id: `security:${finding.rule}`,
      kind: 'security',
      severity: attentionSeverity[finding.severity],
      title: finding.title,
      detail: detailOf(finding),
      ...(at !== undefined ? { at } : {}),
      group: finding.title,
    };
  });
}

/**
 * `ProviderInput.findings` (P9): the latest security scan's findings. A token without `security:read` answers one
 * finding saying so, never an empty list that reads as a clean account; other errors propagate.
 */
export async function readFindings(
  config: DoConfig,
  context: ProviderContext & { signal?: AbortSignal },
  options: DoProviderOptions = {},
): Promise<ProviderFinding[]> {
  let report: DoSecurityReport;
  try {
    report = await readSecurityFindings(config, context, options);
  } catch (error) {
    if (!isComputeError(error, 'ACCESS_DENIED')) throw error;
    return [
      {
        id: 'security:unreadable',
        kind: 'security',
        severity: 'info',
        title: 'Security findings are not readable',
        detail:
          "The token lacks security:read, so the account's DigitalOcean security scan cannot be read.",
      },
    ];
  }
  return securityFindings(report);
}
