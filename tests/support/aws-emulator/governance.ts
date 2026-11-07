import type { AwsEmulator, EmulatorRequest } from './index.js';
import { jsonError } from './xml.js';

const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/x-amz-json-1.1' },
  });

export interface OrgAccount {
  Id: string;
  Name: string;
  Email: string;
  Status?: 'ACTIVE' | 'SUSPENDED' | 'PENDING_CLOSURE';
  /** The OU (or root) the account sits in. */
  parent?: string;
}

/**
 * AWS Organizations (`AWSOrganizationsV20161128`, JSON 1.1): DescribeOrganization (its management account is
 * `managementAccountId`), and ListAccounts and ListAccountsForParent, paged by `pageSize`. Read-only, as the CLI
 * that uses it.
 */
export class OrganizationsEmulator {
  readonly accounts: OrgAccount[] = [];
  pageSize = 20;
  /** DescribeOrganization's MasterAccountId; empty answers an organization without one (a malformed answer). */
  managementAccountId = '000000000000';

  constructor(emu: AwsEmulator) {
    emu.register(/^organizations\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/, {
      service: 'organizations',
      protocol: 'json',
      handle: (request) => this.#handle(request),
    });
  }

  #handle(request: EmulatorRequest): Response {
    if (!request.headers.get('x-amz-target')?.startsWith('AWSOrganizationsV20161128.'))
      return jsonError('UnknownOperationException', 'wrong target prefix');
    const body = JSON.parse(request.body || '{}') as { NextToken?: string; ParentId?: string };
    if (request.operation === 'DescribeOrganization')
      return json({
        Organization: {
          Id: 'o-example',
          Arn: `arn:aws:organizations::${this.managementAccountId}:organization/o-example`,
          FeatureSet: 'ALL',
          ...(this.managementAccountId ? { MasterAccountId: this.managementAccountId } : {}),
        },
      });
    let accounts: OrgAccount[];
    if (request.operation === 'ListAccounts') accounts = this.accounts;
    else if (request.operation === 'ListAccountsForParent') {
      if (!body.ParentId) return jsonError('InvalidInputException', 'ParentId is required');
      accounts = this.accounts.filter((account) => account.parent === body.ParentId);
    } else return jsonError('UnknownOperationException', `no operation ${request.operation}`);
    const start = Number(body.NextToken ?? '0');
    const page = accounts.slice(start, start + this.pageSize);
    const next =
      start + this.pageSize < accounts.length ? String(start + this.pageSize) : undefined;
    return json({
      Accounts: page.map(({ parent: _parent, ...account }) => ({
        ...account,
        Arn: `arn:aws:organizations::000000000000:account/o-example/${account.Id}`,
        JoinedMethod: 'CREATED',
      })),
      ...(next ? { NextToken: next } : {}),
    });
  }
}

export interface Quota {
  QuotaCode: string;
  QuotaName: string;
  Value: number;
  Adjustable: boolean;
}

/**
 * Service Quotas (`ServiceQuotasV20190624`, JSON 1.1) for service `ec2`: ListServiceQuotas, GetServiceQuota and
 * RequestServiceQuotaIncrease (recorded in `requests`).
 */
export class ServiceQuotasEmulator {
  readonly quotas: Quota[] = [];
  readonly requests: { QuotaCode: string; DesiredValue: number }[] = [];
  pageSize = 100;

  constructor(emu: AwsEmulator) {
    emu.register(/^servicequotas\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/, {
      service: 'servicequotas',
      protocol: 'json',
      handle: (request) => this.#handle(request),
    });
  }

  #handle(request: EmulatorRequest): Response {
    if (!request.headers.get('x-amz-target')?.startsWith('ServiceQuotasV20190624.'))
      return jsonError('UnknownOperationException', 'wrong target prefix');
    const body = JSON.parse(request.body || '{}') as {
      ServiceCode?: string;
      QuotaCode?: string;
      DesiredValue?: number;
      NextToken?: string;
    };
    if (body.ServiceCode !== 'ec2') return jsonError('NoSuchResourceException', 'service');
    const shape = (quota: Quota) => ({ ...quota, ServiceCode: 'ec2', ServiceName: 'Amazon EC2' });
    switch (request.operation) {
      case 'ListServiceQuotas': {
        const start = Number(body.NextToken ?? '0');
        const page = this.quotas.slice(start, start + this.pageSize);
        const next =
          start + this.pageSize < this.quotas.length ? String(start + this.pageSize) : undefined;
        return json({ Quotas: page.map(shape), ...(next ? { NextToken: next } : {}) });
      }
      case 'GetServiceQuota': {
        const quota = this.quotas.find((entry) => entry.QuotaCode === body.QuotaCode);
        if (!quota) return jsonError('NoSuchResourceException', 'no such quota');
        return json({ Quota: shape(quota) });
      }
      case 'RequestServiceQuotaIncrease': {
        const quota = this.quotas.find((entry) => entry.QuotaCode === body.QuotaCode);
        if (!quota) return jsonError('NoSuchResourceException', 'no such quota');
        if (!quota.Adjustable) return jsonError('QuotaExceededException', 'not adjustable');
        this.requests.push({ QuotaCode: quota.QuotaCode, DesiredValue: body.DesiredValue! });
        return json({
          RequestedQuota: {
            Id: `req-${this.requests.length}`,
            QuotaCode: quota.QuotaCode,
            DesiredValue: body.DesiredValue,
            Status: 'PENDING',
          },
        });
      }
      default:
        return jsonError('UnknownOperationException', `no operation ${request.operation}`);
    }
  }
}
