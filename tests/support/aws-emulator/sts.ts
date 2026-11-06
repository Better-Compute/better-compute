import type { AwsEmulator } from './index.js';
import { el, queryError, queryResponse } from './xml.js';

const ns = 'https://sts.amazonaws.com/doc/2011-06-15/';

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
 * STS: GetCallerIdentity (by access key id), AssumeRole (ExternalId and trust checks; mints ASIA
 * keys valid for DurationSeconds of emulator time) and AssumeRoleWithWebIdentity (unsigned;
 * configured tokens only).
 */
export class StsEmulator {
  readonly identities = new Map<string, StsIdentity>();
  readonly roles = new Map<string, StsRole>();
  /** Web identity token → the role ARN it may assume. */
  readonly webTokens = new Map<string, string>();
  /** Every AssumeRole request's parameters. */
  readonly assumed: { roleArn: string; externalId?: string; sessionName: string; caller: string }[] = [];
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
            const identity = this.#identity(request.accessKeyId, request.headers.get('x-amz-security-token'));
            if (!identity) return queryError('InvalidClientTokenId', 'The security token included in the request is invalid.', 'Sender', 403);
            return queryResponse(
              'GetCallerIdentity',
              ns,
              `${el('UserId', `AIDA${identity.account}`)}${el('Account', identity.account)}${el('Arn', identity.arn)}`,
            );
          }
          case 'AssumeRole': {
            const caller = this.#identity(request.accessKeyId, request.headers.get('x-amz-security-token'));
            if (!caller) return queryError('InvalidClientTokenId', 'The security token included in the request is invalid.', 'Sender', 403);
            const roleArn = p.get('RoleArn') ?? '';
            const externalId = p.get('ExternalId') ?? undefined;
            this.assumed.push({ roleArn, externalId, sessionName: p.get('RoleSessionName') ?? '', caller: caller.account });
            const role = this.roles.get(roleArn);
            const denied = queryError('AccessDenied', `User: ${caller.arn} is not authorized to perform: sts:AssumeRole on resource: ${roleArn}`, 'Sender', 403);
            if (!role) return denied;
            if (role.externalId !== undefined && role.externalId !== externalId) return denied;
            if (role.trustedAccounts && !role.trustedAccounts.includes(caller.account)) return denied;
            const account = role.identityAccount ?? roleArn.split(':')[4]!;
            return this.#mint('AssumeRole', roleArn, account, Number(p.get('DurationSeconds') ?? 3600));
          }
          case 'AssumeRoleWithWebIdentity': {
            const roleArn = p.get('RoleArn') ?? '';
            const token = p.get('WebIdentityToken') ?? '';
            if (request.headers.get('authorization'))
              return queryError('InvalidParameterValue', 'AssumeRoleWithWebIdentity is unsigned', 'Sender');
            if (this.webTokens.get(token) !== roleArn)
              return queryError('InvalidIdentityToken', 'Token is not valid', 'Sender', 400);
            return this.#mint('AssumeRoleWithWebIdentity', roleArn, roleArn.split(':')[4]!, Number(p.get('DurationSeconds') ?? 3600));
          }
          default:
            return queryError('InvalidAction', `unknown action ${request.operation}`);
        }
      },
    });
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
