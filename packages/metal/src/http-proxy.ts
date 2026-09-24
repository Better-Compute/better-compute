import { isIP } from 'node:net';
import { ComputeError, isSecretRef, type SecretRef, type StepContext } from '@better-compute/core';
import { StepNotReady, awaitCommand, siteAgentFor, stepNotReady } from '@better-compute/provision';
import { httpProxyResult } from './results.js';
import { readMetalNode } from './store.js';

// One HTTP(S) request from the site agent to a machine's own address (`site.httpProxy`, PLAN.md
// §5.6 walkthrough 3): how control-plane steps reach agentless machines (the Talos API) while the
// control plane never talks to machines directly (P5). The site agent is a trusted proxy on the
// provisioning network, so this is an SSRF primitive; the control plane asks only for what the
// agent would allow anyway, and refuses everything else before a command exists:
// - the host is an IP literal among the machine's recorded addresses (no names: no DNS rebinding);
// - https, unless that address lies in one of the pool's `policy.provisioningCidrs`;
// - no credentials in the URL, no Host or hop-by-hop headers; secret headers go by reference;
// - no redirects (a 3xx is an error), and a truncated (over 1 MiB) response is an error.

export const maxProxyResponseBytes = 1 << 20;
const methods = ['GET', 'POST', 'PUT', 'DELETE'] as const;
const forbiddenHeaders = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
]);
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;

export interface HttpViaSiteRequest {
  url: string;
  method?: (typeof methods)[number];
  headers?: Readonly<Record<string, string>>;
  /** Header values that are secret references; the agent fetches them and never logs them. */
  secretHeaders?: Readonly<Record<string, SecretRef>>;
  body?: Uint8Array | string;
  /** Hex SHA-256 of the target certificate's SPKI (Talos serves its own CA). */
  tlsSpkiSha256?: string;
  timeoutMs?: number;
  /** Distinguishes several requests within one step attempt. */
  key?: string;
  /**
   * Polling (waiting for an API to come up): each call returns the newest settled answer and sends
   * the next request, so a step that throws `stepNotReady` on a bad answer sees a fresh one next
   * time. The first call only sends.
   */
  poll?: boolean;
}

export interface HttpViaSiteResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  text(): string;
  json<T = unknown>(): T;
}

/** IPv4 CIDR membership (`10.0.0.0/8`); IPv6 addresses never match. */
export function inCidr(address: string, cidr: string): boolean {
  const [base, bitsText] = cidr.split('/');
  const bits = Number(bitsText);
  if (isIP(address) !== 4 || isIP(base ?? '') !== 4 || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const toInt = (ip: string) => ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(address) & mask) === (toInt(base!) & mask);
}

function refuse(message: string): never {
  throw new ComputeError('INVALID_INPUT', `site.httpProxy refused: ${message}`);
}

/** Checks a request against the target machine; returns the normalized host. */
export function checkProxyTarget(
  request: Pick<HttpViaSiteRequest, 'url' | 'headers' | 'secretHeaders' | 'method'>,
  target: { addresses: readonly string[]; provisioningCidrs: readonly string[] },
): URL {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return refuse('the URL does not parse');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') refuse('only http and https');
  if (url.username || url.password) refuse('no credentials in the URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!isIP(host)) refuse('the host must be one of the machine\'s IP addresses, not a name');
  if (!target.addresses.includes(host)) refuse(`${host} is not an address of the target machine`);
  if (url.protocol === 'http:' && !target.provisioningCidrs.some((cidr) => inCidr(host, cidr)))
    refuse(`plain http only on the provisioning network; ${host} is outside it`);
  if (request.method !== undefined && !methods.includes(request.method)) refuse(`method ${String(request.method)}`);
  for (const name of [...Object.keys(request.headers ?? {}), ...Object.keys(request.secretHeaders ?? {})]) {
    if (!headerName.test(name)) refuse(`header name ${JSON.stringify(name)}`);
    if (forbiddenHeaders.has(name.toLowerCase())) refuse(`header ${name} is set by the agent`);
  }
  for (const [name, value] of Object.entries(request.headers ?? {}))
    if (/[\r\n]/.test(value)) refuse(`header ${name} has a line break`);
  for (const [name, ref] of Object.entries(request.secretHeaders ?? {}))
    if (!isSecretRef(ref)) refuse(`secret header ${name} must be a secret reference`);
  return url;
}

/**
 * Poll mode: the newest request of this step attempt under `<prefix>-<n>`. An open one is
 * awaited (not ready yet); a settled one is the answer, and the next request goes out now, so the
 * next call reads a fresh answer. Returns the key whose answer to use.
 */
async function pollKey(context: StepContext, agent: string, prefix: string, send: (key: string) => Promise<unknown>): Promise<string> {
  const base = `${context.idempotencyKey}#${context.attempt}:${prefix}-`;
  const { rows } = await context.sql.query<{ idempotency_key: string; state: string }>(
    `SELECT idempotency_key, state FROM commands WHERE node_id = $1 AND starts_with(idempotency_key, $2) ORDER BY seq DESC LIMIT 1`,
    [agent, base],
  );
  const last = rows[0];
  if (!last) return `${prefix}-1`;
  const n = Number(last.idempotency_key.slice(base.length));
  if (!['pending', 'dispatched', 'acked', 'running'].includes(last.state))
    // Queue the next poll; it is not ready yet, by construction.
    await send(`${prefix}-${n + 1}`).catch((error: unknown) => {
      if (!(error instanceof StepNotReady)) throw error;
    });
  return `${prefix}-${n}`;
}

/**
 * Sends one request through the site agent of the step's node and waits for the answer (the step
 * re-runs until it arrives, like every relaying step). Throws `INVALID_INPUT` for a request the
 * checks refuse, and `DRIVER_ERROR` for a redirect or a truncated response.
 */
export async function httpViaSite(context: StepContext, request: HttpViaSiteRequest): Promise<HttpViaSiteResponse> {
  const nodeId = context.node?.id;
  if (!nodeId) throw new ComputeError('INVALID_STATE', 'site.httpProxy needs the step to run for a node');
  const node = await readMetalNode(context.sql, nodeId);
  const cidrs = node.pool_policy?.provisioningCidrs;
  const url = checkProxyTarget(request, {
    addresses: node.addresses,
    provisioningCidrs: Array.isArray(cidrs) ? cidrs.filter((c): c is string => typeof c === 'string') : [],
  });
  const agent = await siteAgentFor(context.sql, nodeId);
  if (!agent) throw stepNotReady(5_000);
  const body = request.body === undefined ? undefined : typeof request.body === 'string' ? new TextEncoder().encode(request.body) : request.body;
  const timeoutMs = Math.min(Math.max(request.timeoutMs ?? 30_000, 1_000), 60_000);
  const payload = {
    targetNodeId: nodeId,
    url: url.toString(),
    method: request.method ?? 'GET',
    headers: Object.entries(request.headers ?? {}).map(([name, value]) => ({ name, value })),
    ...(body ? { body: Buffer.from(body).toString('base64') } : {}),
    ...(request.tlsSpkiSha256 ? { tlsSpkiSha256: Buffer.from(request.tlsSpkiSha256, 'hex').toString('base64') } : {}),
    timeoutMs,
    secretHeaders: Object.entries(request.secretHeaders ?? {}).map(([name, value]) => ({ name, value })),
  };
  const send = (key: string | undefined) =>
    awaitCommand(context, { nodeId: agent, kind: 'site.httpProxy', ...(key ? { key } : {}), timeoutMs: timeoutMs + 30_000, payload });
  const key = request.poll ? await pollKey(context, agent, request.key ?? 'poll', send) : request.key;
  const outcome = await send(key);
  const response = httpProxyResult(outcome);
  if (response.status >= 300 && response.status < 400)
    throw new ComputeError('DRIVER_ERROR', `site.httpProxy does not follow redirects (${response.status} from ${url.host})`);
  if (response.truncated || response.body.byteLength > maxProxyResponseBytes)
    throw new ComputeError('DRIVER_ERROR', `site.httpProxy: the response from ${url.host} exceeds ${maxProxyResponseBytes} bytes`);
  const headers = Object.fromEntries(response.headers.map((header) => [header.name.toLowerCase(), header.value]));
  const bytes = response.body;
  return {
    status: response.status,
    headers,
    body: bytes,
    text: () => new TextDecoder().decode(bytes),
    json: <T>() => JSON.parse(new TextDecoder().decode(bytes)) as T,
  };
}
