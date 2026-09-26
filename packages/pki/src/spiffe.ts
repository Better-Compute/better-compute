import { ComputeError } from '@better-compute/core';

/**
 * SPIFFE IDs (https://github.com/spiffe/spiffe/blob/main/standards/SPIFFE-ID.md). Agents get
 * `spiffe://<td>/site/<siteId>/node/<nodeId>`; `nodeId` comes from this SAN only, never from a
 * message field (PLAN.md §13).
 */

const trustDomainPattern = /^[a-z0-9._-]{1,255}$/;
const segmentPattern = /^[A-Za-z0-9._-]+$/;
const maxLength = 2048;

export interface SpiffeId {
  trustDomain: string;
  /** Path segments, without empty, `.` or `..` segments. */
  segments: string[];
}

export interface NodeSpiffeId {
  trustDomain: string;
  siteId: string;
  nodeId: string;
}

function invalid(message: string): ComputeError {
  return new ComputeError('INVALID_INPUT', message);
}

export function isTrustDomain(value: unknown): value is string {
  return typeof value === 'string' && trustDomainPattern.test(value);
}

function checkSegment(segment: string): void {
  if (!segmentPattern.test(segment) || segment === '.' || segment === '..')
    throw invalid(`Invalid SPIFFE path segment ${JSON.stringify(segment)}`);
}

/** Parses a SPIFFE ID; throws `INVALID_INPUT` for anything the standard does not allow. */
export function parseSpiffeId(uri: string): SpiffeId {
  if (typeof uri !== 'string' || uri.length > maxLength || !uri.startsWith('spiffe://'))
    throw invalid('Not a SPIFFE ID');
  const rest = uri.slice('spiffe://'.length);
  const slash = rest.indexOf('/');
  const trustDomain = slash === -1 ? rest : rest.slice(0, slash);
  if (!isTrustDomain(trustDomain)) throw invalid('Invalid SPIFFE trust domain');
  if (slash === -1) return { trustDomain, segments: [] };
  const segments = rest.slice(slash + 1).split('/');
  for (const segment of segments) checkSegment(segment);
  return { trustDomain, segments };
}

export function formatSpiffeId(id: SpiffeId): string {
  if (!isTrustDomain(id.trustDomain)) throw invalid('Invalid SPIFFE trust domain');
  for (const segment of id.segments) checkSegment(segment);
  const uri = `spiffe://${id.trustDomain}${id.segments.map((segment) => `/${segment}`).join('')}`;
  if (uri.length > maxLength) throw invalid('SPIFFE ID too long');
  return uri;
}

/** `spiffe://<td>/site/<siteId>/node/<nodeId>`. */
export function nodeSpiffeId(id: NodeSpiffeId): string {
  return formatSpiffeId({
    trustDomain: id.trustDomain,
    segments: ['site', id.siteId, 'node', id.nodeId],
  });
}

/** The trust domain, site and node of an agent SPIFFE ID; undefined for any other shape. */
export function parseNodeSpiffeId(uri: string): NodeSpiffeId | undefined {
  let parsed: SpiffeId;
  try {
    parsed = parseSpiffeId(uri);
  } catch {
    return undefined;
  }
  const [site, siteId, node, nodeId, ...extra] = parsed.segments;
  if (site !== 'site' || node !== 'node' || !siteId || !nodeId || extra.length) return undefined;
  return { trustDomain: parsed.trustDomain, siteId, nodeId };
}

/**
 * `urn:bc:` URI SANs: what compute proved about a node's key, beside its SPIFFE ID (`urn:bc:tpm-ak:`,
 * the TPM attestation key that certified it). Never an identity: renewals carry them forward.
 */
export const nodeKeyStatementPrefix = 'urn:bc:';
const statementPattern = /^urn:bc:[a-z0-9-]+:[\x21-\x7e]{1,512}$/;

export function isNodeKeyStatement(uri: string): boolean {
  return statementPattern.test(uri);
}

/**
 * The agent identity in a node certificate's URI SANs: exactly one SPIFFE ID, every other URI a
 * `urn:bc:` statement. Undefined for any other set.
 */
export function nodeSpiffeIdOf(uriSans: readonly string[]): NodeSpiffeId | undefined {
  const identities = uriSans.filter((uri) => !isNodeKeyStatement(uri));
  return identities.length === 1 ? parseNodeSpiffeId(identities[0]!) : undefined;
}
