import type { AwsEmulator } from './index.js';

export interface ImdsOptions {
  role?: string;
  /** IMDSv1 only: the token PUT is refused. */
  v1Only?: boolean;
  credentials?: { AccessKeyId: string; SecretAccessKey: string; Token: string };
}

/** IMDSv2 at 169.254.169.254: a token, then the role list, then the role's credentials JSON. */
export class ImdsEmulator {
  readonly token = 'imds-session-token-0123456789';
  tokenRequests = 0;

  constructor(
    private readonly emu: AwsEmulator,
    readonly options: ImdsOptions = {},
  ) {
    const role = options.role ?? 'bc-control-plane';
    emu.register(/^169\.254\.169\.254$/, {
      service: 'imds',
      protocol: 'plain',
      unsigned: () => true,
      handle: (request) => {
        const path = request.url.pathname;
        if (path === '/latest/api/token' && request.method === 'PUT') {
          this.tokenRequests += 1;
          if (options.v1Only) return new Response('', { status: 403 });
          if (request.headers.get('x-aws-ec2-metadata-token-ttl-seconds') !== '21600')
            return new Response('', { status: 400 });
          return new Response(this.token, { status: 200 });
        }
        // v1 answers without a token; v2 requires it.
        if (!options.v1Only && request.headers.get('x-aws-ec2-metadata-token') !== this.token)
          return new Response('', { status: 401 });
        if (path === '/latest/meta-data/iam/security-credentials/')
          return new Response(`${role}\n`, { status: 200 });
        if (path === `/latest/meta-data/iam/security-credentials/${role}`)
          return Response.json({
            Code: 'Success',
            Type: 'AWS-HMAC',
            ...(options.credentials ?? {
              AccessKeyId: 'ASIAIMDS000000000001',
              SecretAccessKey: 'imds-secret',
              Token: 'imds-role-session-token',
            }),
            Expiration: new Date(this.emu.now() + 6 * 3_600_000).toISOString(),
          });
        return new Response('', { status: 404 });
      },
    });
  }
}

/** The ECS / EKS Pod Identity credential endpoints; `authorization` must equal `token`. */
export class ContainerCredentialsEmulator {
  requests = 0;

  constructor(
    private readonly emu: AwsEmulator,
    readonly token = 'pod-identity-token',
  ) {
    emu.register(/^(169\.254\.170\.(2|23)|127\.0\.0\.1(:\d+)?)$/, {
      service: 'container',
      protocol: 'plain',
      unsigned: () => true,
      handle: (request) => {
        this.requests += 1;
        if (request.headers.get('authorization') !== this.token && request.url.hostname !== '169.254.170.2')
          return new Response('{"message":"denied"}', { status: 401 });
        return Response.json({
          AccessKeyId: 'ASIACONTAINER0000001',
          SecretAccessKey: 'container-secret',
          Token: 'container-session-token',
          Expiration: new Date(this.emu.now() + 3_600_000).toISOString(),
        });
      },
    });
  }
}
