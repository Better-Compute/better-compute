import { writeFile } from 'node:fs/promises';
import { ComputeError, systemClock, type Clock } from '@better-compute/core';
import {
  ambientCredentials,
  assertRegion,
  jsonClient,
  partitionOf,
  type AwsService,
  type CredentialSource,
  type JsonClient,
} from '@better-compute/aws-core';
import type { AwsCommandContext } from './cli.js';

// A11's governance commands (`aws organization-accounts`, `aws quotas`, `aws quota-request`): they run as the
// operator's own AWS identity (the ambient credential chain), never a provider account's. An application adds them
// to its configuration's `commands`, as the policy commands:
//
//   import { awsOrganizationAccountsCommand, awsQuotasCommand, awsQuotaRequestCommand } from '@better-compute/provider-aws';
//
// Commands that change AWS (`aws quota-request`) print what they would do and change nothing without --yes.

/** Where the governance commands sign and send (tests and VPC endpoints pass these; the CLI uses the defaults). */
export interface AwsCliOptions {
  fetch?: typeof fetch;
  /** Default: the ambient AWS credential chain (environment, profile, container, IMDSv2). */
  credentials?: CredentialSource;
  clock?: Clock;
  endpoints?: Partial<Record<'organizations' | 'servicequotas' | 'ce', string>>;
}

const usage = (message: string) => new ComputeError('INVALID_INPUT', message);
const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);

function regionFlag(context: AwsCommandContext): string {
  const region = text(context.flags.region);
  if (!region) throw usage('--region is required');
  try {
    return assertRegion(region);
  } catch {
    throw usage(`--region ${JSON.stringify(region.slice(0, 32))} is not an AWS region`);
  }
}

/** A JSON 1.1 client of `service` signed by the operator's identity. */
export function awsCliClient(
  service: Extract<AwsService, 'organizations' | 'servicequotas' | 'ce'>,
  targetPrefix: string,
  region: string,
  options: AwsCliOptions,
): JsonClient {
  return jsonClient({
    service,
    region,
    credentials: options.credentials ?? ambientCredentials({ fetch: options.fetch, region }),
    fetch: options.fetch,
    clock: options.clock ?? systemClock,
    jsonVersion: '1.1',
    targetPrefix,
    ...(options.endpoints?.[service] !== undefined ? { endpoint: options.endpoints[service] } : {}),
  });
}

/** Prints `value` as JSON, or writes it to a new `--out` file. */
export async function emitJson(context: AwsCommandContext, value: unknown): Promise<void> {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  const out = text(context.flags.out);
  if (!out) {
    context.io.out(json.trimEnd());
    return;
  }
  const file = context.path(out);
  try {
    await writeFile(file, json, { flag: 'wx', mode: 0o644 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw usage(`--out ${out} exists; give a new file`);
    throw error;
  }
  context.note(`wrote ${file}`);
}

const outFlag = {
  type: 'string' as const,
  value: 'PATH',
  description: 'Write the result to this new file instead of the output',
};
const regionSpec = {
  type: 'string' as const,
  value: 'REGION',
  required: true,
  description: 'The AWS region (its partition picks the endpoints)',
};

/** Follows `NextToken` pages of a JSON operation, refusing a loop. */
async function* pages<T>(
  client: JsonClient,
  operation: string,
  body: Record<string, unknown>,
  items: (page: Record<string, unknown>) => readonly T[],
  signal: AbortSignal,
): AsyncGenerator<T> {
  const seen = new Set<string>();
  let token: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const response = await client.call<Record<string, unknown>>(
      operation,
      { ...body, ...(token ? { NextToken: token } : {}) },
      { signal },
    );
    yield* items(response);
    const next =
      typeof response.NextToken === 'string' && response.NextToken !== ''
        ? response.NextToken
        : undefined;
    if (!next) return;
    if (seen.has(next))
      throw new ComputeError('PROVIDER_ERROR', `AWS ${operation} returned a page token twice`);
    seen.add(next);
    token = next;
  }
  throw new ComputeError('PROVIDER_ERROR', `AWS ${operation} pagination did not end`);
}

// --- aws organization-accounts ---------------------------------------------------------------------------------

/** One FleetConfig `providerAccounts` entry for a member account (A11): config only, never a secret. */
export interface OrganizationProviderAccount {
  name: string;
  provider: 'aws';
  config: { region: string; zones: string[]; assumeRoleArn: string };
}

/**
 * The FleetConfig entries for organization member accounts: one `aws` provider account per ACTIVE account, each
 * assuming `role` in it (better-compute sends the platform-assigned ExternalId). Pure; no I/O.
 */
export function organizationProviderAccounts(input: {
  accounts: readonly { id: string; status?: string }[];
  role: string;
  region: string;
  zones: readonly string[];
  prefix?: string;
  exclude?: readonly string[];
}): OrganizationProviderAccount[] {
  if (!/^[\w+=,.@-]{1,64}(?:\/[\w+=,.@-]{1,64})*$/.test(input.role))
    throw usage('--role is an IAM role name (or path/name)');
  let region: string;
  try {
    region = assertRegion(input.region);
  } catch {
    throw usage('--region is not an AWS region');
  }
  const zonePattern = new RegExp(
    `^${region.replace(/-/g, '\\-')}(?:[a-z]|-[a-z]{2,10}-\\d{1,2}[a-z])$`,
  );
  if (input.zones.length === 0 || !input.zones.every((zone) => zonePattern.test(zone)))
    throw usage(`--zones are zones of ${region} (us-east-1a,us-east-1b)`);
  const prefix = input.prefix ?? 'aws';
  if (!/^[a-z0-9][a-z0-9-]{0,20}$/.test(prefix)) throw usage('--prefix is a short lower-case name');
  const partition = partitionOf(region).partition;
  const excluded = new Set(input.exclude ?? []);
  return input.accounts
    .filter((account) => /^\d{12}$/.test(account.id) && !excluded.has(account.id))
    .filter((account) => account.status === undefined || account.status === 'ACTIVE')
    .map((account) => ({
      name: `${prefix}-${account.id}-${region}`,
      provider: 'aws' as const,
      config: {
        region,
        zones: [...input.zones],
        assumeRoleArn: `arn:${partition}:iam::${account.id}:role/${input.role}`,
      },
    }));
}

/** `better-compute aws organization-accounts --role <name> --region <r> --zones <a,b>`: renders, never mutates. */
export function awsOrganizationAccountsCommand(options: AwsCliOptions = {}) {
  return {
    name: 'aws organization-accounts' as const,
    group: 'Providers' as const,
    summary: 'Print FleetConfig provider accounts for the member accounts of an AWS organization',
    description:
      "aws organization-accounts lists the organization's accounts (organizations:ListAccounts, or ListAccountsForParent with --parent) as the operator's own AWS identity, run in the management or a delegated administrator account, and prints a FleetConfig document with one aws provider account per ACTIVE account: --region and --zones, and assumeRoleArn naming --role in that account. It only reads and renders; fleet apply creates the accounts. Zone names differ between AWS accounts (us-east-1a is not the same zone everywhere): check each account's before applying.",
    target: 'none' as const,
    output: 'text' as const,
    flags: {
      role: {
        type: 'string' as const,
        value: 'NAME',
        required: true,
        description: 'The IAM role better-compute assumes in each member account',
      },
      region: regionSpec,
      zones: {
        type: 'string' as const,
        value: 'ZONES',
        required: true,
        description: 'Comma-separated zone names for every account (us-east-1a,us-east-1b)',
      },
      parent: {
        type: 'string' as const,
        value: 'OU',
        description: 'Only the accounts directly in this organizational unit (ou-…) or root (r-…)',
      },
      exclude: {
        type: 'string' as const,
        value: 'IDS',
        description: 'Comma-separated account ids to leave out (the management account, say)',
      },
      prefix: {
        type: 'string' as const,
        value: 'NAME',
        description: 'Provider account names are <prefix>-<account>-<region> (default aws)',
      },
      out: outFlag,
    },
    async run(context: AwsCommandContext): Promise<void> {
      const role = text(context.flags.role);
      if (!role) throw usage('--role is required');
      const region = regionFlag(context);
      const zones = (text(context.flags.zones) ?? '')
        .split(',')
        .map((zone) => zone.trim())
        .filter(Boolean);
      const parent = text(context.flags.parent);
      if (
        parent !== undefined &&
        !/^(?:ou-[0-9a-z]{4,32}-[0-9a-z]{8,32}|r-[0-9a-z]{4,32})$/.test(parent)
      )
        throw usage('--parent is an organizational unit (ou-…) or root (r-…) id');
      const exclude = (text(context.flags.exclude) ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
      // Validate everything before calling AWS.
      organizationProviderAccounts({
        accounts: [],
        role,
        region,
        zones,
        exclude,
        ...(text(context.flags.prefix) ? { prefix: text(context.flags.prefix)! } : {}),
      });
      const client = awsCliClient('organizations', 'AWSOrganizationsV20161128', region, options);
      const signal = AbortSignal.timeout(60_000);
      const accounts: { id: string; status?: string }[] = [];
      for await (const account of pages(
        client,
        parent ? 'ListAccountsForParent' : 'ListAccounts',
        parent ? { ParentId: parent } : {},
        (page) =>
          Array.isArray(page.Accounts) ? (page.Accounts as Record<string, unknown>[]) : [],
        signal,
      ))
        if (typeof account.Id === 'string')
          accounts.push({
            id: account.Id,
            // `State` is the newer field; `Status` the one older APIs return.
            ...(typeof account.State === 'string'
              ? { status: account.State }
              : typeof account.Status === 'string'
                ? { status: account.Status }
                : {}),
          });
      const providerAccounts = organizationProviderAccounts({
        accounts,
        role,
        region,
        zones,
        exclude,
        ...(text(context.flags.prefix) ? { prefix: text(context.flags.prefix)! } : {}),
      });
      context.note(
        `${providerAccounts.length} of ${accounts.length} accounts; zone names differ between AWS accounts: check each account's zones before applying`,
      );
      await emitJson(context, { version: 1, providerAccounts });
    },
  };
}

// --- aws quotas / aws quota-request ----------------------------------------------------------------------------

/** The EC2 quotas better-compute capacity runs into: running instances and Spot requests, in vCPUs. */
const instanceQuota = /^(?:Running On-Demand .* instances|All .* Spot Instance Requests)$/;

interface QuotaShape {
  QuotaCode?: unknown;
  QuotaName?: unknown;
  Value?: unknown;
  Adjustable?: unknown;
}

const quotaRow = (quota: QuotaShape) => ({
  quotaCode: String(quota.QuotaCode ?? ''),
  name: String(quota.QuotaName ?? ''),
  value: typeof quota.Value === 'number' ? quota.Value : Number(quota.Value ?? 0),
  adjustable: quota.Adjustable === true,
});

/** `better-compute aws quotas --region <r>`: the account's EC2 instance quotas (vCPUs), read only. */
export function awsQuotasCommand(options: AwsCliOptions = {}) {
  return {
    name: 'aws quotas' as const,
    group: 'Providers' as const,
    summary: 'Print the EC2 instance vCPU quotas of an AWS account and region',
    description:
      "aws quotas reads the region's EC2 quotas (servicequotas:ListServiceQuotas) as the operator's own AWS identity and prints the running On-Demand and Spot instance quotas, in vCPUs, that capacity on an aws provider account runs into: quotaCode, name, value and whether it is adjustable. aws quota-request asks for more.",
    target: 'none' as const,
    output: 'text' as const,
    flags: { region: regionSpec, out: outFlag },
    async run(context: AwsCommandContext): Promise<void> {
      const region = regionFlag(context);
      const client = awsCliClient('servicequotas', 'ServiceQuotasV20190624', region, options);
      const rows = [];
      for await (const quota of pages(
        client,
        'ListServiceQuotas',
        { ServiceCode: 'ec2', MaxResults: 100 },
        (page) => (Array.isArray(page.Quotas) ? (page.Quotas as QuotaShape[]) : []),
        AbortSignal.timeout(60_000),
      ))
        if (instanceQuota.test(String(quota.QuotaName ?? ''))) rows.push(quotaRow(quota));
      await emitJson(context, rows);
    },
  };
}

/**
 * `better-compute aws quota-request --region <r> --quota-code L-… --value <n> [--yes]`: asks AWS to raise an EC2
 * quota. Without --yes it prints the request and sends nothing.
 */
export function awsQuotaRequestCommand(options: AwsCliOptions = {}) {
  return {
    name: 'aws quota-request' as const,
    group: 'Providers' as const,
    summary: 'Ask AWS to raise an EC2 quota (servicequotas:RequestServiceQuotaIncrease)',
    description:
      "aws quota-request reads the quota's current value (servicequotas:GetServiceQuota) and, only with --yes, asks AWS to raise it to --value (servicequotas:RequestServiceQuotaIncrease) as the operator's own AWS identity. Without --yes it prints the request it would send and changes nothing. A value that is not above the current one is refused. AWS may open a support case and take days; aws quotas shows the value once granted.",
    target: 'none' as const,
    output: 'text' as const,
    flags: {
      region: regionSpec,
      'quota-code': {
        type: 'string' as const,
        value: 'CODE',
        required: true,
        description: 'The EC2 quota code (L-1216C47A; aws quotas lists them)',
      },
      value: {
        type: 'integer' as const,
        value: 'N',
        required: true,
        min: 1,
        description: 'The quota value to ask for (vCPUs for instance quotas)',
      },
      yes: {
        type: 'boolean' as const,
        description: 'Send the request (otherwise it is only printed)',
      },
      out: outFlag,
    },
    async run(context: AwsCommandContext): Promise<void> {
      const region = regionFlag(context);
      const quotaCode = text(context.flags['quota-code']);
      if (!quotaCode || !/^L-[0-9A-F]{8}$/.test(quotaCode))
        throw usage('--quota-code is an EC2 quota code (L-1216C47A)');
      const desired = Number(context.flags.value);
      if (!Number.isInteger(desired) || desired < 1 || desired > 10_000_000)
        throw usage('--value is a whole number from 1');
      const client = awsCliClient('servicequotas', 'ServiceQuotasV20190624', region, options);
      const signal = AbortSignal.timeout(60_000);
      const { Quota: quota } = await client.call<{ Quota?: QuotaShape }>(
        'GetServiceQuota',
        { ServiceCode: 'ec2', QuotaCode: quotaCode },
        { signal },
      );
      const current = quotaRow(quota ?? {});
      if (desired <= current.value)
        throw usage(`--value ${desired} is not above the current ${current.value} of ${quotaCode}`);
      if (!current.adjustable) throw usage(`${quotaCode} is not adjustable`);
      const plan = { quotaCode, name: current.name, region, current: current.value, desired };
      if (context.flags.yes !== true) {
        context.note('nothing was sent: run again with --yes to ask AWS for this quota');
        await emitJson(context, { ...plan, submitted: false });
        return;
      }
      const { RequestedQuota: requested } = await client.call<{
        RequestedQuota?: { Id?: unknown; Status?: unknown; CaseId?: unknown };
      }>(
        'RequestServiceQuotaIncrease',
        { ServiceCode: 'ec2', QuotaCode: quotaCode, DesiredValue: desired },
        { signal },
      );
      await emitJson(context, {
        ...plan,
        submitted: true,
        ...(typeof requested?.Id === 'string' ? { requestId: requested.Id } : {}),
        ...(typeof requested?.Status === 'string' ? { status: requested.Status } : {}),
        ...(typeof requested?.CaseId === 'string' ? { caseId: requested.CaseId } : {}),
      });
    },
  };
}
