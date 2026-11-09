import { ComputeError, isComputeError, type Clock } from '@better-compute/core';
import { queryClient } from './client.js';
import { endpointFor, parseArn } from './endpoints.js';
import { mapAwsError, parseAwsError } from './errors.js';
import { serializeAwsQuery } from './query.js';
import { parseXml, type XmlElement } from './xml.js';

/** AWS credentials as they are signed with. Never logged, never put in an error. */
export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  /** Epoch ms after which the credentials no longer work (temporary credentials only). */
  readonly expiresAt?: number;
}

/** What a credential source may use while it resolves: the caller's signal and business time. */
export interface CredentialContext {
  signal: AbortSignal;
  clock: Clock;
}

/**
 * Where credentials come from. `invalidate` drops cached credentials: after `ExpiredToken`, and
 * after a refused key (`AuthFailure`), so a secret rotated in place is read again.
 */
export interface CredentialSource {
  readonly kind: string;
  credentials(context: CredentialContext): Promise<AwsCredentials>;
  invalidate?(): void;
}

type Env = Readonly<Record<string, string | undefined>>;

const stsVersion = '2011-06-15';
const sessionNamePattern = /^[\w+=,.@-]{2,64}$/;

function unauthenticated(message: string, reason: string, kind: string): ComputeError {
  return new ComputeError('UNAUTHENTICATED', message, undefined, {
    provider: 'aws',
    source: kind,
    reason,
  });
}

/** Builds credentials from an untrusted record, naming a missing field and never a value. */
function fromRecord(
  record: Record<string, unknown>,
  names: { id: string; secret: string; token: string; expiration?: string },
  fail: (field: string) => ComputeError,
): AwsCredentials {
  const id = record[names.id];
  const secret = record[names.secret];
  const token = record[names.token];
  if (typeof id !== 'string' || id === '') throw fail(names.id);
  if (typeof secret !== 'string' || secret === '') throw fail(names.secret);
  if (token !== undefined && token !== null && typeof token !== 'string') throw fail(names.token);
  const expiration = names.expiration ? record[names.expiration] : undefined;
  const expiresAt = typeof expiration === 'string' ? Date.parse(expiration) : undefined;
  return {
    accessKeyId: id,
    secretAccessKey: secret,
    ...(typeof token === 'string' && token !== '' ? { sessionToken: token } : {}),
    ...(expiresAt !== undefined && Number.isFinite(expiresAt) ? { expiresAt } : {}),
  };
}

/**
 * Credentials from a secret: `load()` returns JSON `{ "accessKeyId", "secretAccessKey",
 * "sessionToken"? }` (e.g. from `SecretResolver.resolve`). A malformed secret is `INVALID_CONFIG`
 * naming the field, never its value.
 */
export function staticCredentials(load: () => Promise<string>): CredentialSource {
  return {
    kind: 'static',
    async credentials() {
      const text = await load();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ComputeError(
          'INVALID_CONFIG',
          'the AWS credentials secret is not JSON',
          undefined,
          {
            provider: 'aws',
            reason: 'credentials',
          },
        );
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new ComputeError('INVALID_CONFIG', 'the AWS credentials secret is not a JSON object');
      return fromRecord(
        parsed as Record<string, unknown>,
        { id: 'accessKeyId', secret: 'secretAccessKey', token: 'sessionToken' },
        (field) =>
          new ComputeError(
            'INVALID_CONFIG',
            `the AWS credentials secret has no valid ${field}`,
            undefined,
            {
              provider: 'aws',
              reason: 'credentials',
              field,
            },
          ),
      );
    },
  };
}

/** `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`. */
export function envCredentials(env: Env = process.env): CredentialSource {
  return {
    kind: 'env',
    async credentials() {
      return fromRecord(
        env as Record<string, unknown>,
        { id: 'AWS_ACCESS_KEY_ID', secret: 'AWS_SECRET_ACCESS_KEY', token: 'AWS_SESSION_TOKEN' },
        (field) =>
          unauthenticated(`environment variable ${field} is not set`, 'env-missing', 'env'),
      );
    },
  };
}

/** A fetch bounded by `timeoutMs` and the caller's signal; failures are UNAUTHENTICATED `reason`. */
async function boundedFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  options: { signal: AbortSignal; timeoutMs: number; kind: string; reason: string },
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const onAbort = () => controller.abort();
  options.signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'manual' });
  } catch {
    throw unauthenticated(
      `AWS ${options.kind} credentials are unreachable`,
      options.reason,
      options.kind,
    );
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', onAbort);
  }
}

async function credentialJson(
  response: Response,
  kind: string,
  reason: string,
): Promise<AwsCredentials> {
  // Errors never carry the body: it may hold credentials.
  if (response.status !== 200)
    throw unauthenticated(`AWS ${kind} credentials answered HTTP ${response.status}`, reason, kind);
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw unauthenticated(`AWS ${kind} credentials are not JSON`, reason, kind);
  }
  if (!parsed || typeof parsed !== 'object')
    throw unauthenticated(`AWS ${kind} credentials are not a JSON object`, reason, kind);
  const record = parsed as Record<string, unknown>;
  if (typeof record.Code === 'string' && record.Code !== 'Success')
    throw unauthenticated(`AWS ${kind} credentials are not available`, reason, kind);
  return fromRecord(
    record,
    { id: 'AccessKeyId', secret: 'SecretAccessKey', token: 'Token', expiration: 'Expiration' },
    (field) => unauthenticated(`AWS ${kind} credentials have no ${field}`, reason, kind),
  );
}

/** IMDSv2 only: a token first; a 403/404 on the token is `UNAUTHENTICATED` and there is no v1 fallback. */
export function imdsCredentials(
  options: { fetch?: typeof fetch; endpoint?: string; timeoutMs?: number } = {},
): CredentialSource {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const endpoint = (options.endpoint ?? 'http://169.254.169.254').replace(/\/$/, '');
  const timeoutMs = options.timeoutMs ?? 1000;
  const reason = 'imds-unavailable';
  return {
    kind: 'imds',
    async credentials({ signal }) {
      const bounded = { signal, timeoutMs, kind: 'imds', reason };
      const tokenResponse = await boundedFetch(
        fetchImpl,
        `${endpoint}/latest/api/token`,
        { method: 'PUT', headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '21600' } },
        bounded,
      );
      if (tokenResponse.status !== 200)
        throw unauthenticated(
          `the instance metadata service refused a token (HTTP ${tokenResponse.status})`,
          reason,
          'imds',
        );
      const token = (await tokenResponse.text()).trim();
      if (token === '' || /[\r\n]/.test(token))
        throw unauthenticated('the instance metadata service gave no token', reason, 'imds');
      const headers = { 'x-aws-ec2-metadata-token': token };
      const listed = await boundedFetch(
        fetchImpl,
        `${endpoint}/latest/meta-data/iam/security-credentials/`,
        { headers },
        bounded,
      );
      if (listed.status !== 200)
        throw unauthenticated(
          `the instance has no IAM role (HTTP ${listed.status})`,
          reason,
          'imds',
        );
      const role = (await listed.text()).split('\n')[0]?.trim() ?? '';
      if (!/^[\w+=,.@-]{1,128}$/.test(role))
        throw unauthenticated('the instance has no IAM role', reason, 'imds');
      const response = await boundedFetch(
        fetchImpl,
        `${endpoint}/latest/meta-data/iam/security-credentials/${role}`,
        { headers },
        bounded,
      );
      return credentialJson(response, 'imds', reason);
    },
  };
}

/** Hosts the container full URI may name: loopback, ECS (169.254.170.2) and EKS Pod Identity (.23). */
function allowedContainerHost(url: URL): boolean {
  const host = url.hostname;
  if (host === '169.254.170.2' || host === '169.254.170.23' || host === '[::1]') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * ECS/EKS container credentials: `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` against 169.254.170.2, or
 * `AWS_CONTAINER_CREDENTIALS_FULL_URI` restricted to loopback, 169.254.170.2 and 169.254.170.23
 * (anything else is `INVALID_CONFIG`: SSRF). The authorization token comes from
 * `AWS_CONTAINER_AUTHORIZATION_TOKEN` or the file at `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE`.
 */
export function containerCredentials(
  options: { fetch?: typeof fetch; env?: Env; readFile?: (path: string) => Promise<string> } = {},
): CredentialSource {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? defaultReadFile;
  const reason = 'container-unavailable';
  return {
    kind: 'container',
    async credentials({ signal }) {
      const relative = env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
      const full = env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
      let url: URL;
      if (relative) {
        if (!relative.startsWith('/'))
          throw new ComputeError(
            'INVALID_CONFIG',
            'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI must start with /',
          );
        url = new URL(`http://169.254.170.2${relative}`);
        if (url.host !== '169.254.170.2')
          throw new ComputeError(
            'INVALID_CONFIG',
            'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI changes the host',
          );
      } else if (full) {
        try {
          url = new URL(full);
        } catch {
          throw new ComputeError(
            'INVALID_CONFIG',
            'AWS_CONTAINER_CREDENTIALS_FULL_URI is not a URL',
          );
        }
        if (
          (url.protocol !== 'http:' && url.protocol !== 'https:') ||
          url.username ||
          url.password ||
          !allowedContainerHost(url)
        )
          throw new ComputeError(
            'INVALID_CONFIG',
            'AWS_CONTAINER_CREDENTIALS_FULL_URI must name loopback, 169.254.170.2 or 169.254.170.23',
            undefined,
            { provider: 'aws', reason: 'container-uri' },
          );
      } else
        throw unauthenticated(
          'no container credentials endpoint is configured',
          'container-missing',
          'container',
        );
      let authorization = env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
      const tokenFile = env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE;
      if (tokenFile) {
        try {
          authorization = (await readFile(tokenFile)).trim();
        } catch {
          throw unauthenticated(
            'the container authorization token file is unreadable',
            reason,
            'container',
          );
        }
      }
      if (authorization !== undefined && /[\r\n]/.test(authorization))
        throw new ComputeError(
          'INVALID_CONFIG',
          'the container authorization token has a line break',
        );
      const response = await boundedFetch(
        fetchImpl,
        url.toString(),
        { headers: authorization ? { authorization } : {} },
        { signal, timeoutMs: 2000, kind: 'container', reason },
      );
      return credentialJson(response, 'container', reason);
    },
  };
}

async function defaultReadFile(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(path, 'utf8');
}

function checkSessionName(name: string): void {
  if (!sessionNamePattern.test(name))
    throw new ComputeError(
      'INVALID_CONFIG',
      'an AWS role session name must match [\\w+=,.@-]{2,64}',
    );
}

function checkRoleArn(roleArn: string): void {
  const arn = parseArn(roleArn);
  if (arn.service !== 'iam' || !arn.resource.startsWith('role/') || !/^\d{12}$/.test(arn.account))
    throw new ComputeError('INVALID_CONFIG', 'not an IAM role ARN', undefined, {
      provider: 'aws',
      reason: 'role-arn',
    });
}

function stsCredentials(result: XmlElement | undefined, kind: string): AwsCredentials {
  const credentials = result?.child('Credentials');
  if (!credentials) throw unauthenticated('STS returned no credentials', 'sts', kind);
  const expiration = credentials.textOf('Expiration');
  return fromRecord(
    {
      AccessKeyId: credentials.textOf('AccessKeyId'),
      SecretAccessKey: credentials.textOf('SecretAccessKey'),
      SessionToken: credentials.textOf('SessionToken'),
      Expiration: expiration,
    },
    {
      id: 'AccessKeyId',
      secret: 'SecretAccessKey',
      token: 'SessionToken',
      expiration: 'Expiration',
    },
    (field) => unauthenticated(`STS returned credentials without ${field}`, 'sts', kind),
  );
}

/** One awsQuery STS call, signed with `signer` or unsigned (AssumeRoleWithWebIdentity). */
async function stsCall(
  action: string,
  params: Record<string, string | number | undefined>,
  options: {
    region: string;
    fetch?: typeof fetch;
    endpoint?: string;
    signal: AbortSignal;
    clock: Clock;
    signer?: CredentialSource;
  },
): Promise<XmlElement> {
  if (options.signer) {
    const sts = queryClient({
      service: 'sts',
      version: stsVersion,
      region: options.region,
      credentials: options.signer,
      fetch: options.fetch,
      clock: options.clock,
      ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
    });
    return sts.call(action, params, { signal: options.signal });
  }
  const url = endpointFor('sts', options.region, {
    ...(options.endpoint !== undefined ? { override: options.endpoint } : {}),
  });
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  const onAbort = () => controller.abort();
  options.signal.addEventListener('abort', onAbort, { once: true });
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: serializeAwsQuery(action, stsVersion, params),
      signal: controller.signal,
      redirect: 'manual',
    });
  } catch {
    throw new ComputeError('UNAVAILABLE', `AWS sts ${action}: network failure`, undefined, {
      provider: 'aws',
      service: 'sts',
      reason: 'network',
    });
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', onAbort);
  }
  const text = await response.text();
  if (response.status !== 200)
    throw mapAwsError({
      ...parseAwsError('query', response.status, response.headers, text),
      service: 'sts',
    });
  const doc = parseXml(text);
  return doc.child(`${action}Result`) ?? doc;
}

/** AssumeRoleWithWebIdentity: the token is exchanged without signing. */
export function webIdentityCredentials(options: {
  roleArn: string;
  sessionName: string;
  token: () => Promise<string>;
  region: string;
  fetch?: typeof fetch;
  endpoint?: string;
  durationSeconds?: number;
}): CredentialSource {
  checkRoleArn(options.roleArn);
  checkSessionName(options.sessionName);
  return {
    kind: 'web-identity',
    async credentials({ signal, clock }) {
      const token = (await options.token()).trim();
      if (token === '')
        throw unauthenticated('the web identity token is empty', 'web-identity', 'web-identity');
      const result = await stsCall(
        'AssumeRoleWithWebIdentity',
        {
          RoleArn: options.roleArn,
          RoleSessionName: options.sessionName,
          WebIdentityToken: token,
          DurationSeconds: options.durationSeconds,
        },
        { ...options, signal, clock },
      );
      return stsCredentials(result, 'web-identity');
    },
  };
}

/** AssumeRole from `base`, with the (platform-assigned) external id and session name. */
export function assumeRoleCredentials(
  base: CredentialSource,
  options: {
    roleArn: string;
    sessionName: string;
    region: string;
    externalId?: string;
    durationSeconds?: number;
    sourceIdentity?: string;
    fetch?: typeof fetch;
    endpoint?: string;
  },
): CredentialSource {
  checkRoleArn(options.roleArn);
  checkSessionName(options.sessionName);
  const durationSeconds = options.durationSeconds ?? 3600;
  if (!Number.isInteger(durationSeconds) || durationSeconds < 900 || durationSeconds > 43_200)
    throw new ComputeError('INVALID_CONFIG', 'an AssumeRole duration is 900 to 43200 seconds');
  return {
    kind: 'assume-role',
    async credentials({ signal, clock }) {
      const result = await stsCall(
        'AssumeRole',
        {
          RoleArn: options.roleArn,
          RoleSessionName: options.sessionName,
          DurationSeconds: durationSeconds,
          ExternalId: options.externalId,
          SourceIdentity: options.sourceIdentity,
        },
        { ...options, signal, clock, signer: base },
      );
      return stsCredentials(result, 'assume-role');
    },
    invalidate: () => base.invalidate?.(),
  };
}

/**
 * The host's ambient identity, for platform accounts only (F1): environment, then web identity
 * (`AWS_WEB_IDENTITY_TOKEN_FILE` + `AWS_ROLE_ARN`), then container credentials, then IMDSv2. The
 * first source that works is kept for the life of the chain.
 */
export function ambientCredentials(
  options: {
    env?: Env;
    fetch?: typeof fetch;
    readFile?: (path: string) => Promise<string>;
    region?: string;
  } = {},
): CredentialSource {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? defaultReadFile;
  const candidates = (): CredentialSource[] => {
    const list: CredentialSource[] = [];
    if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) list.push(envCredentials(env));
    const tokenFile = env.AWS_WEB_IDENTITY_TOKEN_FILE;
    const roleArn = env.AWS_ROLE_ARN;
    const region = options.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
    if (tokenFile && roleArn && region)
      list.push(
        webIdentityCredentials({
          roleArn,
          sessionName: env.AWS_ROLE_SESSION_NAME ?? 'better-compute',
          token: () => readFile(tokenFile),
          region,
          fetch: options.fetch,
        }),
      );
    if (env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_CONTAINER_CREDENTIALS_FULL_URI)
      list.push(containerCredentials({ fetch: options.fetch, env, readFile }));
    list.push(imdsCredentials({ fetch: options.fetch }));
    return list;
  };
  let winner: CredentialSource | undefined;
  return {
    get kind() {
      return winner ? `ambient:${winner.kind}` : 'ambient';
    },
    async credentials(context) {
      if (winner) return winner.credentials(context);
      let last: unknown;
      for (const source of candidates()) {
        try {
          const credentials = await source.credentials(context);
          winner = source;
          return credentials;
        } catch (error) {
          // A misconfiguration (a disallowed container URI) is reported, not skipped.
          if (isComputeError(error, 'INVALID_CONFIG')) throw error;
          last = error;
        }
      }
      throw unauthenticated(
        `no ambient AWS credentials were found${isComputeError(last) ? ` (last: ${String(last.details?.source ?? last.code)})` : ''}`,
        'ambient-missing',
        'ambient',
      );
    },
    invalidate: () => winner?.invalidate?.(),
  };
}

/**
 * Single-flight caching: concurrent callers share one resolution, temporary credentials refresh
 * `refreshBeforeMs` before `expiresAt`, and credentials without an expiry are kept until
 * `invalidate()`.
 */
export function cachedCredentials(
  source: CredentialSource,
  options: { refreshBeforeMs?: number } = {},
): CredentialSource {
  const refreshBeforeMs = options.refreshBeforeMs ?? 300_000;
  let current: AwsCredentials | undefined;
  let inflight: Promise<AwsCredentials> | undefined;
  return {
    get kind() {
      return source.kind;
    },
    async credentials(context) {
      if (
        current &&
        (current.expiresAt === undefined ||
          context.clock.now() < current.expiresAt - refreshBeforeMs)
      )
        return current;
      if (!inflight) {
        inflight = source.credentials(context).then(
          (value) => {
            current = value;
            inflight = undefined;
            return value;
          },
          (error: unknown) => {
            inflight = undefined;
            throw error;
          },
        );
      }
      return inflight;
    },
    invalidate() {
      current = undefined;
      source.invalidate?.();
    },
  };
}

/** `sts:GetCallerIdentity` for the identity behind `credentials`. */
export async function getCallerIdentity(
  credentials: CredentialSource,
  options: {
    region: string;
    fetch?: typeof fetch;
    endpoint?: string;
    signal: AbortSignal;
    clock: Clock;
  },
): Promise<{ account: string; arn: string; userId: string }> {
  const result = await stsCall('GetCallerIdentity', {}, { ...options, signer: credentials });
  const account = result.textOf('Account') ?? '';
  const arn = result.textOf('Arn') ?? '';
  const userId = result.textOf('UserId') ?? '';
  if (!/^\d{12}$/.test(account))
    throw new ComputeError(
      'PROVIDER_ERROR',
      'STS GetCallerIdentity returned no account',
      undefined,
      {
        provider: 'aws',
        service: 'sts',
      },
    );
  return { account, arn, userId };
}
