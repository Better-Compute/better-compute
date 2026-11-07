import { staticJwks, verifyJwt } from '@better-compute/pki';
import type { AwsEmulator } from './index.js';
import { el, queryError, queryResponse } from './xml.js';

const ns = 'https://sts.amazonaws.com/doc/2011-06-15/';

/** IAM's StringLike: `*` any run, `?` one character, the rest literal. */
function like(pattern: string, value: string): boolean {
  const source = [...pattern]
    .map((char) =>
      char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.+^${}()|[\]\\/-]/g, '\\$&'),
    )
    .join('');
  return new RegExp(`^${source}$`).test(value);
}

/** The session tags a web identity token passes (`https://aws.amazon.com/tags` principal_tags). */
function sessionTags(claims: Record<string, unknown>): Record<string, unknown> | undefined {
  const tags = claims['https://aws.amazon.com/tags'];
  if (typeof tags !== 'object' || tags === null) return undefined;
  const principal = (tags as { principal_tags?: unknown }).principal_tags;
  return typeof principal === 'object' && principal !== null
    ? (principal as Record<string, unknown>)
    : undefined;
}

/** Whether a web role's trust (its `condition`, else its `trust` rule) accepts the claims. */
function trusts(role: StsWebRole, claims: Record<string, unknown>): boolean {
  const sub = typeof claims.sub === 'string' ? claims.sub : undefined;
  // IAM: a token that passes session tags needs sts:TagSession in the trust as well.
  const tags = sessionTags(claims);
  const actions = role.actions === undefined ? [] : [role.actions].flat();
  if (tags !== undefined && !actions.includes('sts:TagSession')) return false;
  if (role.condition === undefined) return sub !== undefined && role.trust?.(sub) === true;
  const provider = role.issuer.replace(/^https:\/\//, '');
  const operators = Object.entries(role.condition);
  if (operators.length === 0) return false;
  return operators.every(([operator, keys]) => {
    const match =
      operator === 'StringEquals'
        ? (expected: string, value: string) => expected === value
        : operator === 'StringLike'
          ? like
          : undefined;
    if (!match) return false;
    return Object.entries(keys).every(([key, expected]) => {
      const at = key.lastIndexOf(':');
      let claim: unknown;
      // aws:RequestTag/<key>: the session tag the token passes.
      if (key.startsWith('aws:RequestTag/')) claim = tags?.[key.slice('aws:RequestTag/'.length)];
      else if (key.slice(0, at) !== provider) return false;
      else claim = claims[key.slice(at + 1)];
      const values = (Array.isArray(claim) ? claim : [claim]).filter(
        (item): item is string => typeof item === 'string',
      );
      const patterns: readonly string[] = typeof expected === 'string' ? [expected] : expected;
      return values.some((value) => patterns.some((pattern) => match(pattern, value)));
    });
  });
}

export interface StsIdentity {
  secret: string;
  account: string;
  arn: string;
  sessionToken?: string;
}

export interface StsRole {
  /** AssumeRole refuses (AccessDenied) unless the caller sends exactly this ExternalId. */
  externalId?: string;
  /** Override: the account GetCallerIdentity reports for the minted credentials (identity-mismatch tests). */
  identityAccount?: string;
  /** Accounts whose identities may assume the role (default: any). */
  trustedAccounts?: readonly string[];
}

/**
 * A role trusting an IAM OIDC provider (AssumeRoleWithWebIdentity, A7): STS verifies the token's
 * signature against the provider's JWKS, its `iss` (the provider URL), `aud` (a client id of the
 * provider, `sts.amazonaws.com`) and `exp`, then the trust's `<issuer>:sub` condition.
 */
export interface StsWebRole {
  issuer: string;
  jwks: () => Promise<unknown>;
  /** The provider's client id the trust pins (default `sts.amazonaws.com`). */
  audience?: string;
  /** The trust policy's condition over `sub` (a hand-written rule). */
  trust?: (sub: string) => boolean;
  /**
   * The trust statement's `Condition` as a rendered template has it (`<issuer host/path>:sub` and
   * `:aud` keys under StringEquals or StringLike), evaluated against the token's claims as IAM does;
   * it replaces `trust`. Every key must hold; a key for another provider, or another operator, never
   * matches.
   */
  condition?: Record<string, Record<string, string | readonly string[]>>;
  /**
   * The trust statement's `Action`. A token passing session tags is refused unless it includes
   * `sts:TagSession`, as IAM does (default: only AssumeRoleWithWebIdentity). Condition keys
   * `aws:RequestTag/<key>` match the token's `https://aws.amazon.com/tags` principal_tags.
   */
  actions?: string | readonly string[];
  /** Override: the account GetCallerIdentity reports for the minted credentials. */
  identityAccount?: string;
}

/**
 * STS: GetCallerIdentity (by access key id), AssumeRole (ExternalId and trust checks; mints ASIA
 * keys valid for DurationSeconds of emulator time) and AssumeRoleWithWebIdentity (unsigned;
 * configured tokens, or a JWT verified against a `webRoles` OIDC trust).
 */
export class StsEmulator {
  readonly identities = new Map<string, StsIdentity>();
  readonly roles = new Map<string, StsRole>();
  /** Web identity token → the role ARN it may assume. */
  readonly webTokens = new Map<string, string>();
  /** Roles that trust an OIDC provider (checked when a token is not in `webTokens`). */
  readonly webRoles = new Map<string, StsWebRole>();
  /** Every AssumeRoleWithWebIdentity against `webRoles`: `sub` once the token verified. */
  readonly webExchanges: {
    roleArn: string;
    sessionName: string;
    sub?: string;
    accepted: boolean;
  }[] = [];
  /** Every AssumeRole request's parameters. */
  readonly assumed: {
    roleArn: string;
    externalId?: string;
    sessionName: string;
    caller: string;
  }[] = [];
  #minted = 0;

  constructor(private readonly emu: AwsEmulator) {
    emu.register(/^sts\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/, {
      service: 'sts',
      protocol: 'query',
      unsigned: (operation) => operation === 'AssumeRoleWithWebIdentity',
      handle: (request) => {
        const p = request.params;
        switch (request.operation) {
          case 'GetCallerIdentity': {
            const identity = this.#identity(
              request.accessKeyId,
              request.headers.get('x-amz-security-token'),
            );
            if (!identity)
              return queryError(
                'InvalidClientTokenId',
                'The security token included in the request is invalid.',
                'Sender',
                403,
              );
            return queryResponse(
              'GetCallerIdentity',
              ns,
              `${el('UserId', `AIDA${identity.account}`)}${el('Account', identity.account)}${el('Arn', identity.arn)}`,
            );
          }
          case 'AssumeRole': {
            const caller = this.#identity(
              request.accessKeyId,
              request.headers.get('x-amz-security-token'),
            );
            if (!caller)
              return queryError(
                'InvalidClientTokenId',
                'The security token included in the request is invalid.',
                'Sender',
                403,
              );
            const roleArn = p.get('RoleArn') ?? '';
            const externalId = p.get('ExternalId') ?? undefined;
            this.assumed.push({
              roleArn,
              externalId,
              sessionName: p.get('RoleSessionName') ?? '',
              caller: caller.account,
            });
            const role = this.roles.get(roleArn);
            const denied = queryError(
              'AccessDenied',
              `User: ${caller.arn} is not authorized to perform: sts:AssumeRole on resource: ${roleArn}`,
              'Sender',
              403,
            );
            if (!role) return denied;
            if (role.externalId !== undefined && role.externalId !== externalId) return denied;
            if (role.trustedAccounts && !role.trustedAccounts.includes(caller.account))
              return denied;
            const account = role.identityAccount ?? roleArn.split(':')[4]!;
            return this.#mint(
              'AssumeRole',
              roleArn,
              account,
              Number(p.get('DurationSeconds') ?? 3600),
            );
          }
          case 'AssumeRoleWithWebIdentity': {
            const roleArn = p.get('RoleArn') ?? '';
            const token = p.get('WebIdentityToken') ?? '';
            if (request.headers.get('authorization'))
              return queryError(
                'InvalidParameterValue',
                'AssumeRoleWithWebIdentity is unsigned',
                'Sender',
              );
            const webRole = this.webRoles.get(roleArn);
            if (webRole && !this.webTokens.has(token))
              return this.#federate(roleArn, p.get('RoleSessionName') ?? '', token, webRole, p);
            if (this.webTokens.get(token) !== roleArn)
              return queryError('InvalidIdentityToken', 'Token is not valid', 'Sender', 400);
            return this.#mint(
              'AssumeRoleWithWebIdentity',
              roleArn,
              roleArn.split(':')[4]!,
              Number(p.get('DurationSeconds') ?? 3600),
            );
          }
          default:
            return queryError('InvalidAction', `unknown action ${request.operation}`);
        }
      },
    });
  }

  async #federate(
    roleArn: string,
    sessionName: string,
    token: string,
    role: StsWebRole,
    p: URLSearchParams,
  ): Promise<Response> {
    const record = (accepted: boolean, sub?: string) =>
      this.webExchanges.push({ roleArn, sessionName, accepted, ...(sub ? { sub } : {}) });
    let claims: Record<string, unknown>;
    try {
      claims = await verifyJwt(token, staticJwks(await role.jwks()));
    } catch {
      record(false);
      return queryError('InvalidIdentityToken', 'The token signature is not valid', 'Sender', 400);
    }
    const sub = typeof claims.sub === 'string' ? claims.sub : undefined;
    if (claims.iss !== role.issuer) {
      record(false, sub);
      return queryError(
        'InvalidIdentityToken',
        'No OpenIDConnect provider found in your account for the issuer',
        'Sender',
        400,
      );
    }
    if (claims.aud !== (role.audience ?? 'sts.amazonaws.com')) {
      record(false, sub);
      return queryError('InvalidIdentityToken', 'Incorrect token audience', 'Sender', 400);
    }
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= this.emu.now()) {
      record(false, sub);
      return queryError('ExpiredTokenException', 'Token is expired', 'Sender', 400);
    }
    if (sub === undefined || !trusts(role, claims)) {
      record(false, sub);
      return queryError(
        'AccessDenied',
        'Not authorized to perform sts:AssumeRoleWithWebIdentity',
        'Sender',
        403,
      );
    }
    record(true, sub);
    return this.#mint(
      'AssumeRoleWithWebIdentity',
      roleArn,
      role.identityAccount ?? roleArn.split(':')[4]!,
      Number(p.get('DurationSeconds') ?? 3600),
    );
  }

  #identity(keyId: string | undefined, token: string | null): StsIdentity | undefined {
    const identity = keyId ? this.identities.get(keyId) : undefined;
    if (!identity) return undefined;
    if (identity.sessionToken !== undefined && identity.sessionToken !== token) return undefined;
    return identity;
  }

  #mint(action: string, roleArn: string, account: string, duration: number) {
    const n = String(++this.#minted).padStart(16, '0');
    const accessKeyId = `ASIA${n}`;
    const secret = `minted-secret-${n}`;
    const sessionToken = `minted-session-token-${n}`;
    const roleName = roleArn.split('/').pop();
    const arn = `arn:aws:sts::${account}:assumed-role/${roleName}/session`;
    this.identities.set(accessKeyId, { secret, account, arn, sessionToken });
    const expiration = new Date(this.emu.now() + duration * 1000).toISOString();
    return queryResponse(
      action,
      ns,
      `<Credentials>${el('AccessKeyId', accessKeyId)}${el('SecretAccessKey', secret)}${el('SessionToken', sessionToken)}${el('Expiration', expiration)}</Credentials>${el('AssumedRoleUser', '')}`,
    );
  }
}
