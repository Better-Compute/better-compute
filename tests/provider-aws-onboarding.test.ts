import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandSpec } from '@better-compute/cli';
import {
  awsOnboardingTemplateCommand,
  awsWorkloadRoleCommand,
  iamPolicy,
  onboardingTemplate,
  trustPolicy,
  workloadRoleTemplate,
  type AwsCommandContext,
} from '@better-compute/provider-aws';
import { createWorkloadIssuer } from '@better-compute/pki';
import { accountSubject, awsRoleSessionTagClaims } from '@better-compute/vps';
import { AwsEmulator } from './support/aws-emulator/index.js';

// AWS A7 onboarding: the CloudFormation a tenant deploys in its own AWS account. Either a role the
// control plane assumes (the platform principal + the platform-assigned ExternalId, AD4), or a
// keyless role its workload identity assumes (the IAM OIDC provider + the account's exact subject);
// both carry the ABAC policy. `aws workload-role` renders the role instances assume (A7 workload
// identity): aud sts.amazonaws.com, sub t:<tenantId>:instance:*.

const ISSUER = 'https://compute.example.test/api/compute/workload';
const PLATFORM = 'arn:aws:iam::111111111111:role/bc-control-plane';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(flags: AwsCommandContext['flags']) {
  const dir = mkdtempSync(join(tmpdir(), 'aws-onboarding-'));
  dirs.push(dir);
  const out: string[] = [];
  const notes: string[] = [];
  const context: AwsCommandContext = {
    flags,
    io: { out: (message) => out.push(message) },
    note: (message) => notes.push(message),
    path: (value) => join(dir, value),
  };
  return { dir, out, notes, context };
}

type Template = ReturnType<typeof onboardingTemplate>;
const roleOf = (template: Template) => template.Resources.Role as any;

describe('aws onboarding-template', () => {
  it('a role trusted by the platform principal with the platform-assigned ExternalId', () => {
    const template = onboardingTemplate({
      providerAccountId: 'pa_tenantA',
      platformPrincipalArn: PLATFORM,
    });
    expect(template.AWSTemplateFormatVersion).toBe('2010-09-09');
    const role = roleOf(template);
    expect(role.Type).toBe('AWS::IAM::Role');
    expect(role.Properties.AssumeRolePolicyDocument).toEqual(
      trustPolicy({ platformPrincipalArn: PLATFORM, externalId: 'better-compute:pa_tenantA' }),
    );
    expect(role.Properties.Policies).toEqual([
      { PolicyName: 'better-compute', PolicyDocument: iamPolicy() },
    ]);
    expect(role.Properties.RoleName).toBe('better-compute');
    expect(template.Outputs.ExternalId!.Value).toBe('better-compute:pa_tenantA');
    expect(template.Outputs.RoleArn!.Value).toEqual({ 'Fn::GetAtt': ['Role', 'Arn'] });
    expect(template.Resources.OidcProvider).toBeUndefined();
  });

  it('the ExternalId prefix is the host option, never the tenant', () => {
    const template = onboardingTemplate({
      providerAccountId: 'pa_tenantA',
      platformPrincipalArn: PLATFORM,
      externalIdPrefix: 'acme',
    });
    expect(
      roleOf(template).Properties.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals[
        'sts:ExternalId'
      ],
    ).toBe('acme:pa_tenantA');
  });

  it('the ABAC policy takes the iam-policy options', () => {
    const template = onboardingTemplate({
      providerAccountId: 'pa_1',
      platformPrincipalArn: PLATFORM,
      region: 'us-east-1',
      discoverTag: 'team=ml',
    });
    expect(roleOf(template).Properties.Policies[0].PolicyDocument).toEqual(
      iamPolicy({ region: 'us-east-1', discoverTag: 'team=ml' }),
    );
  });

  it('keyless: an OIDC provider and a role trusting exactly the account subject', () => {
    const subject = accountSubject('t_acme', 'aws', 'keyless');
    const template = onboardingTemplate({ issuer: ISSUER, tenantId: 't_acme', name: 'keyless' });
    expect(template.Resources.OidcProvider).toEqual({
      Type: 'AWS::IAM::OIDCProvider',
      Properties: { Url: ISSUER, ClientIdList: ['sts.amazonaws.com'] },
    });
    const trust = roleOf(template).Properties.AssumeRolePolicyDocument;
    expect(trust.Statement).toEqual([
      {
        Sid: 'BetterComputeAccount',
        Effect: 'Allow',
        Principal: { Federated: { Ref: 'OidcProvider' } },
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: {
          StringEquals: {
            'compute.example.test/api/compute/workload:aud': 'sts.amazonaws.com',
            'compute.example.test/api/compute/workload:sub': subject,
          },
        },
      },
    ]);
    expect(template.Outputs.Subject!.Value).toBe(subject);
    expect(template.Outputs.ExternalId).toBeUndefined();
  });

  it('keyless with an existing OIDC provider references it', () => {
    const arn = 'arn:aws:iam::222222222222:oidc-provider/compute.example.test/api/compute/workload';
    const template = onboardingTemplate({
      issuer: ISSUER,
      tenantId: 't_acme',
      name: 'keyless',
      oidcProviderArn: arn,
    });
    expect(template.Resources.OidcProvider).toBeUndefined();
    expect(roleOf(template).Properties.AssumeRolePolicyDocument.Statement[0].Principal).toEqual({
      Federated: arn,
    });
  });

  it('refuses mixed or incomplete modes and malformed input', () => {
    const bad: Parameters<typeof onboardingTemplate>[0][] = [
      {},
      { providerAccountId: 'pa_1' },
      { platformPrincipalArn: PLATFORM },
      { issuer: ISSUER, tenantId: 't_acme' },
      { issuer: ISSUER, tenantId: 't_acme', name: 'n', platformPrincipalArn: PLATFORM },
      { issuer: 'http://compute.example.test', tenantId: 't_acme', name: 'n' },
      { issuer: `${ISSUER}?x=1`, tenantId: 't_acme', name: 'n' },
      { issuer: ISSUER, tenantId: 't acme', name: 'n' },
      { issuer: ISSUER, tenantId: 't_acme', name: 'n', oidcProviderArn: 'arn:aws:iam::1:role/x' },
      { providerAccountId: 'pa 1', platformPrincipalArn: PLATFORM },
      { providerAccountId: 'pa_1', platformPrincipalArn: PLATFORM, roleName: 'a b' },
    ];
    for (const options of bad)
      expect(() => onboardingTemplate(options), JSON.stringify(options)).toThrow(
        expect.objectContaining({ code: 'INVALID_INPUT' }),
      );
  });
});

describe('aws workload-role', () => {
  it("trusts the issuer for the tenant's instances, with the STS audience and its own role tag", () => {
    const template = workloadRoleTemplate({ tenantId: 't_acme', issuer: ISSUER });
    const role = template.Resources.Role as any;
    expect(role.Properties.RoleName).toBe('bc-workload');
    expect(role.Properties.AssumeRolePolicyDocument.Statement).toEqual([
      {
        Sid: 'BetterComputeWorkloads',
        Effect: 'Allow',
        Principal: { Federated: { Ref: 'OidcProvider' } },
        // The broker tags an STS token with the one role it was minted for (bc-role), so a token
        // for one workload role never assumes another.
        Action: ['sts:AssumeRoleWithWebIdentity', 'sts:TagSession'],
        Condition: {
          StringEquals: {
            'compute.example.test/api/compute/workload:aud': 'sts.amazonaws.com',
            'aws:RequestTag/bc-role': {
              'Fn::Sub': 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/bc-workload',
            },
          },
          StringLike: { 'compute.example.test/api/compute/workload:sub': 't:t_acme:instance:*' },
        },
      },
    ]);
    expect(role.Properties.ManagedPolicyArns).toBeUndefined();
    expect(template.Outputs.RoleTag!.Value).toEqual({
      'Fn::Sub': 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/bc-workload',
    });
    expect(template.Outputs.Subject!.Value).toBe('t:t_acme:instance:*');
  });

  it('attaches managed policies and reuses an OIDC provider', () => {
    const provider = 'arn:aws:iam::222222222222:oidc-provider/compute.example.test/api/compute/workload';
    const template = workloadRoleTemplate({
      tenantId: 't_acme',
      issuer: ISSUER,
      roleName: 'ml-readers',
      policyArns: ['arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess'],
      oidcProviderArn: provider,
    });
    const role = template.Resources.Role as any;
    expect(role.Properties.RoleName).toBe('ml-readers');
    expect(role.Properties.ManagedPolicyArns).toEqual([
      'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess',
    ]);
    expect(template.Resources.OidcProvider).toBeUndefined();
    expect(role.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Federated).toBe(provider);
    expect(
      role.Properties.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals[
        'aws:RequestTag/bc-role'
      ],
    ).toEqual({ 'Fn::Sub': 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/ml-readers' });
  });

  it('refuses a role name a session tag cannot carry (a comma)', () => {
    expect(() =>
      workloadRoleTemplate({ tenantId: 't_acme', issuer: ISSUER, roleName: 'ml,readers' }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('refuses a tenant id that would widen the subject pattern', () => {
    for (const tenantId of ['*', 't_*', 't?', 't:x', ''])
      expect(() => workloadRoleTemplate({ tenantId, issuer: ISSUER })).toThrow(
        expect.objectContaining({ code: 'INVALID_INPUT' }),
      );
    expect(() =>
      workloadRoleTemplate({ tenantId: 't', issuer: ISSUER, policyArns: ['arn:aws:s3:::b'] }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
});

/** CloudFormation's Fn::Sub over the pseudo parameters a workload role trust uses. */
function resolveSub(value: unknown, account: string): any {
  if (Array.isArray(value)) return value.map((item) => resolveSub(item, account));
  if (typeof value !== 'object' || value === null) return value;
  const sub = (value as { 'Fn::Sub'?: unknown })['Fn::Sub'];
  if (typeof sub === 'string')
    return sub.replaceAll('${AWS::Partition}', 'aws').replaceAll('${AWS::AccountId}', account);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, resolveSub(item, account)]),
  );
}

describe('workload roles bound to their tag (A7, against the STS emulator)', () => {
  it('a token the broker minted for one workload role never assumes another', async () => {
    const emu = new AwsEmulator();
    const issuer = createWorkloadIssuer({
      issuer: ISSUER,
      defaultAudience: 'sts.amazonaws.com',
      clock: emu.clock,
    });
    const account = '222222222222';
    const R1 = `arn:aws:iam::${account}:role/ml-readers`;
    const R2 = `arn:aws:iam::${account}:role/admins`;
    for (const arn of [R1, R2]) {
      const template = workloadRoleTemplate({
        tenantId: 't_acme',
        issuer: ISSUER,
        roleName: arn.split('/').pop()!,
      });
      const statement = resolveSub(
        (template.Resources.Role as any).Properties.AssumeRolePolicyDocument.Statement[0],
        account,
      );
      emu.sts.webRoles.set(arn, {
        issuer: ISSUER,
        jwks: async () => issuer.jwks(),
        actions: statement.Action,
        condition: statement.Condition,
      });
    }
    const assume = async (roleArn: string, token: string) =>
      (
        await emu.fetch('https://sts.us-east-1.amazonaws.com/', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            Action: 'AssumeRoleWithWebIdentity',
            Version: '2011-06-15',
            RoleArn: roleArn,
            RoleSessionName: 'bc',
            WebIdentityToken: token,
          }).toString(),
        })
      ).status;
    const mint = (arn?: string) =>
      issuer.issue({
        tenantId: 't_acme',
        instanceId: 'inst_1',
        ...(arn ? { claims: awsRoleSessionTagClaims(arn)! } : {}),
      }).token;
    expect(await assume(R1, mint(R1))).toBe(200);
    expect(await assume(R2, mint(R2))).toBe(200);
    // R1's token on R2 (another workload role of the same tenant) and an untagged token: refused.
    expect(await assume(R2, mint(R1))).toBe(403);
    expect(await assume(R1, mint())).toBe(403);
    // IAM refuses a tagged token when the trust does not allow sts:TagSession.
    emu.sts.webRoles.get(R1)!.actions = 'sts:AssumeRoleWithWebIdentity';
    expect(await assume(R1, mint(R1))).toBe(403);
  });
});

describe('aws identity commands', () => {
  it('print CloudFormation JSON and honor --out', async () => {
    const printed = harness({ account: 'pa_1', 'platform-principal': PLATFORM });
    await awsOnboardingTemplateCommand().run(printed.context);
    expect(JSON.parse(printed.out.join('\n'))).toEqual(
      onboardingTemplate({ providerAccountId: 'pa_1', platformPrincipalArn: PLATFORM }),
    );

    const keyless = harness({ issuer: ISSUER, tenant: 't_acme', name: 'keyless', region: 'us-east-1' });
    await awsOnboardingTemplateCommand().run(keyless.context);
    expect(JSON.parse(keyless.out.join('\n'))).toEqual(
      onboardingTemplate({ issuer: ISSUER, tenantId: 't_acme', name: 'keyless', region: 'us-east-1' }),
    );

    const written = harness({
      tenant: 't_acme',
      issuer: ISSUER,
      'policy-arn': 'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess',
      out: 'role.json',
    });
    await awsWorkloadRoleCommand().run(written.context);
    expect(written.out).toEqual([]);
    expect(JSON.parse(readFileSync(join(written.dir, 'role.json'), 'utf8'))).toEqual(
      workloadRoleTemplate({
        tenantId: 't_acme',
        issuer: ISSUER,
        policyArns: ['arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess'],
      }),
    );
    expect(written.notes[0]).toContain('role.json');
    await expect(awsWorkloadRoleCommand().run(written.context)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(awsWorkloadRoleCommand().run(harness({}).context)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('have the CLI shape', () => {
    for (const command of [awsOnboardingTemplateCommand(), awsWorkloadRoleCommand()]) {
      const spec = command as unknown as CommandSpec<any>;
      expect(spec.name).toMatch(/^aws [a-z-]+$/);
      expect(spec.group).toBe('Providers');
      expect(spec.summary).toMatch(/^[A-Z][a-z]+ /);
      expect(typeof spec.run).toBe('function');
      for (const [name, flag] of Object.entries(spec.flags ?? {})) {
        expect(['url', 'format', 'config', 'query']).not.toContain(name);
        expect(flag.type).toBe('string');
        expect(typeof flag.description).toBe('string');
      }
    }
    expect(awsWorkloadRoleCommand().flags.tenant.required).toBe(true);
    expect(awsWorkloadRoleCommand().flags.issuer.required).toBe(true);
  });
});
