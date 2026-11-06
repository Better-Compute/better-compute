import { describe, expect, it } from 'vitest';
import { controlPlaneTemplate, lintTemplate, type CfnResource, type CfnTemplate } from '@better-compute/aws';

// A12 `control-plane` stack: ECS Fargate api/worker/gateway services (plus the one-off migrate
// task), an ALB with WAF for the API, an NLB in TCP passthrough for the gateway's mTLS, least
// privilege task roles, the deployment secret, the KMS key, the S3 buckets (downloads behind
// CloudFront, blobs, snapshots, Object Lock audit), the EventBridge bus, logs and alarms.

const template = controlPlaneTemplate();
const resource = (id: string): CfnResource => {
  const found = template.Resources[id];
  if (!found) throw new Error(`no resource ${id}`);
  return found;
};
const props = (id: string) => resource(id).Properties!;
const ofType = (from: CfnTemplate, type: string) => Object.entries(from.Resources).filter(([, entry]) => entry.Type === type);

type Container = {
  Name: string;
  Command: string[];
  Environment: { Name: string; Value: unknown }[];
  Secrets: { Name: string; ValueFrom: unknown }[];
  ReadonlyRootFilesystem: boolean;
  LinuxParameters: { Capabilities: { Drop: string[] }; InitProcessEnabled: boolean };
  LogConfiguration: { LogDriver: string; Options: Record<string, unknown> };
  PortMappings?: { ContainerPort: number }[];
};
const container = (task: string) => (props(task).ContainerDefinitions as Container[])[0]!;
type Statement = { Effect: string; Action: string | string[]; Resource?: unknown; Principal?: unknown; Condition?: unknown };
const statementsOf = (role: string): Statement[] => {
  const policies = (props(role).Policies ?? []) as { PolicyDocument: { Statement: Statement[] } }[];
  const managed = ((props(role).ManagedPolicyArns ?? []) as unknown[])
    .filter((entry): entry is { Ref: string } => typeof entry === 'object' && entry !== null && 'Ref' in entry)
    .map((entry) => (props(entry.Ref).PolicyDocument as { Statement: Statement[] }).Statement)
    .flat();
  return [...policies.flatMap((policy) => policy.PolicyDocument.Statement), ...managed];
};
const actionsOf = (role: string) => statementsOf(role).flatMap((statement) => [statement.Action].flat());

describe('control-plane template', () => {
  it('lints clean', () => {
    expect(lintTemplate(template)).toEqual([]);
    expect(lintTemplate(controlPlaneTemplate({ name: 'bc-stage', zones: 2 }))).toEqual([]);
  });

  it('runs api, worker and gateway as Fargate services with the serve roles, and migrate as a one-off task', () => {
    expect(container('ApiTask').Command).toEqual(['serve', '--roles', 'api', '--port', '3000', '--no-migrate']);
    expect(container('WorkerTask').Command).toEqual(['serve', '--roles', 'controllers,scheduler,sinks,iam', '--no-migrate']);
    expect(container('GatewayTask').Command).toEqual(['serve', '--roles', 'gateway', '--no-migrate']);
    expect(container('MigrateTask').Command).toEqual(['migrate']);
    for (const service of ['ApiService', 'WorkerService', 'GatewayService']) {
      expect(props(service)).toMatchObject({
        LaunchType: 'FARGATE',
        EnableExecuteCommand: false,
        DeploymentConfiguration: { DeploymentCircuitBreaker: { Enable: true, Rollback: true } },
      });
      const network = (props(service).NetworkConfiguration as { AwsvpcConfiguration: Record<string, unknown> }).AwsvpcConfiguration;
      expect(network.AssignPublicIp).toBe('DISABLED');
      expect(network.Subnets).toEqual({ 'Fn::Split': [',', { 'Fn::ImportValue': { 'Fn::Sub': '${NetworkStack}-PrivateSubnetIds' } }] });
      expect(network.SecurityGroups).toContainEqual({ 'Fn::ImportValue': { 'Fn::Sub': '${DataStack}-DatabaseClientSecurityGroupId' } });
    }
    expect(Object.keys(template.Resources).filter((id) => resource(id).Type === 'AWS::ECS::Service').sort()).toEqual(['ApiService', 'GatewayService', 'WorkerService']);
  });

  it('accepts only a digest-pinned image', () => {
    const pattern = new RegExp(template.Parameters!.Image!.AllowedPattern!);
    expect(pattern.test(`123456789012.dkr.ecr.us-east-1.amazonaws.com/better-compute@sha256:${'a'.repeat(64)}`)).toBe(true);
    expect(pattern.test('123456789012.dkr.ecr.us-east-1.amazonaws.com/better-compute:latest')).toBe(false);
    expect(pattern.test(`better-compute:1.0@sha256:${'a'.repeat(63)}`)).toBe(false);
  });

  it('migrates with the next image before the services roll to it', () => {
    // An upgrade sets MigrateImage first (only the migrate task changes), runs it, then sets Image.
    expect((props('MigrateTask').ContainerDefinitions as { Image: unknown }[])[0]!.Image).toEqual({
      'Fn::If': ['HasMigrateImage', { Ref: 'MigrateImage' }, { Ref: 'Image' }],
    });
    for (const task of ['ApiTask', 'WorkerTask', 'GatewayTask'])
      expect((props(task).ContainerDefinitions as { Image: unknown }[])[0]!.Image).toEqual({ Ref: 'Image' });
    const pattern = new RegExp(template.Parameters!.MigrateImage!.AllowedPattern!);
    expect(template.Parameters!.MigrateImage!.Default).toBe('');
    expect(pattern.test('')).toBe(true);
    expect(pattern.test(`r/bc@sha256:${'b'.repeat(64)}`)).toBe(true);
    expect(pattern.test('r/bc:next')).toBe(false);
  });

  it('hardens every container and passes secrets only as ECS secrets', () => {
    for (const task of ['ApiTask', 'WorkerTask', 'GatewayTask', 'MigrateTask']) {
      const definition = props(task);
      expect(definition).toMatchObject({ NetworkMode: 'awsvpc', RequiresCompatibilities: ['FARGATE'] });
      const entry = container(task);
      expect(entry.ReadonlyRootFilesystem).toBe(true);
      expect(entry.LinuxParameters).toMatchObject({ InitProcessEnabled: true, Capabilities: { Drop: ['ALL'] } });
      expect(entry.LogConfiguration.LogDriver).toBe('awslogs');
      expect(entry.Secrets).toEqual([
        { Name: 'BETTER_COMPUTE_SECRET', ValueFrom: { Ref: 'DeploymentSecret' } },
        { Name: 'BC_PKI_BUNDLE', ValueFrom: { Ref: 'PkiBundleSecret' } },
      ]);
      for (const variable of entry.Environment) expect(variable.Name).not.toMatch(/SECRET|PASSWORD|TOKEN|KEY$/);
    }
    expect(props('DeploymentSecret').GenerateSecretString).toMatchObject({ PasswordLength: 64, ExcludePunctuation: true });
    expect(resource('DeploymentSecret').DeletionPolicy).toBe('Retain');
  });

  it('serves the API over HTTPS on the ALB with a TLS 1.3 policy, redirects HTTP, and puts WAF in front', () => {
    expect(props('HttpsListener')).toMatchObject({
      Protocol: 'HTTPS',
      Port: 443,
      SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
      Certificates: [{ CertificateArn: { Ref: 'CertificateArn' } }],
    });
    expect(props('HttpListener').DefaultActions).toEqual([
      { Type: 'redirect', RedirectConfig: { Protocol: 'HTTPS', Port: '443', StatusCode: 'HTTP_301' } },
    ]);
    expect(props('ApiTargetGroup')).toMatchObject({ TargetType: 'ip', Port: 3000, HealthCheckPath: '/readyz' });
    const attributes = props('ApiLoadBalancer').LoadBalancerAttributes as { Key: string; Value: string }[];
    expect(attributes).toContainEqual({ Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' });
    expect(props('WebAclAssociation')).toEqual({ ResourceArn: { Ref: 'ApiLoadBalancer' }, WebACLArn: { 'Fn::GetAtt': ['WebAcl', 'Arn'] } });
    const rules = props('WebAcl').Rules as { Name: string; Statement: Record<string, { Name?: string; RuleActionOverrides?: unknown }> }[];
    expect(rules.map((rule) => rule.Name)).toEqual(['rate-limit', 'aws-ip-reputation', 'aws-common', 'aws-known-bad-inputs']);
    // API bodies can exceed the common rule set's 8 KiB body rule: it counts instead of blocking.
    expect(rules[2]!.Statement.ManagedRuleGroupStatement!.RuleActionOverrides).toEqual([{ Name: 'SizeRestrictions_BODY', ActionToUse: { Count: {} } }]);
  });

  it('passes gateway TCP straight through the NLB so the gateway terminates mTLS itself', () => {
    expect(props('GatewayLoadBalancer')).toMatchObject({ Type: 'network', Scheme: 'internet-facing' });
    expect(props('GatewayListener')).toMatchObject({ Protocol: 'TCP', Port: 443 });
    expect(props('GatewayListener')).not.toHaveProperty('Certificates');
    expect(props('GatewayTargetGroup')).toMatchObject({ Protocol: 'TCP', Port: 8443, TargetType: 'ip' });
    expect(ofType(template, 'AWS::ElasticLoadBalancingV2::Listener').filter(([, entry]) => entry.Properties!.Protocol === 'TLS')).toEqual([]);
  });

  it('opens each task only to the load balancer or caller in front of it', () => {
    const ingress = (id: string) => props(id).SecurityGroupIngress as Record<string, unknown>[] | undefined;
    expect(ingress('ApiSecurityGroup')).toEqual([
      expect.objectContaining({ FromPort: 3000, ToPort: 3000, SourceSecurityGroupId: { Ref: 'LoadBalancerSecurityGroup' } }),
    ]);
    expect(ingress('GatewaySecurityGroup')).toEqual([
      expect.objectContaining({ FromPort: 8443, ToPort: 8443, SourceSecurityGroupId: { Ref: 'GatewayLoadBalancerSecurityGroup' } }),
      expect.objectContaining({ FromPort: { Ref: 'GatewayInternalPort' }, SourceSecurityGroupId: { Ref: 'ApiSecurityGroup' } }),
    ]);
    expect(ingress('WorkerSecurityGroup')).toBeUndefined();
  });

  it('gives task roles scoped statements only: no wildcard resources or service-wide actions', () => {
    for (const role of ['ApiTaskRole', 'WorkerTaskRole', 'GatewayTaskRole', 'ExecutionRole']) {
      const trust = props(role).AssumeRolePolicyDocument as { Statement: Statement[] };
      expect(trust.Statement[0]).toMatchObject({
        Principal: { Service: 'ecs-tasks.amazonaws.com' },
        Condition: { StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } } },
      });
      for (const statement of statementsOf(role)) {
        expect(statement.Resource, role).not.toBe('*');
        expect([statement.Resource].flat(), role).not.toContain('*');
        for (const action of [statement.Action].flat()) expect(action, role).not.toMatch(/:\*$|^\*$/);
      }
    }
    // The gateway reads; it never writes buckets, secrets or the bus.
    const gateway = actionsOf('GatewayTaskRole');
    expect(gateway).toContain('rds-db:connect');
    for (const action of ['s3:PutObject', 's3:DeleteObject', 'secretsmanager:CreateSecret', 'secretsmanager:PutSecretValue', 'events:PutEvents'])
      expect(gateway).not.toContain(action);
    // Only the worker (sinks role) appends audit batches and publishes events.
    expect(actionsOf('WorkerTaskRole')).toEqual(expect.arrayContaining(['s3:PutObjectRetention', 'events:PutEvents']));
    expect(actionsOf('ApiTaskRole')).not.toContain('s3:PutObjectRetention');
    const connect = statementsOf('GatewayTaskRole').find((statement) => statement.Action === 'rds-db:connect' || [statement.Action].flat().includes('rds-db:connect'))!;
    expect(JSON.stringify(connect.Resource)).toContain(':dbuser:${ResourceId}/${DatabaseUser}');
  });

  it('keeps every bucket private, TLS-only and encrypted; audit under Object Lock compliance', () => {
    const buckets = ofType(template, 'AWS::S3::Bucket');
    expect(buckets.map(([id]) => id).sort()).toEqual(['AuditBucket', 'BlobsBucket', 'DownloadsBucket', 'SnapshotsBucket']);
    for (const [id, bucket] of buckets) {
      expect(bucket.Properties!.PublicAccessBlockConfiguration, id).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
      expect(bucket.Properties!.BucketEncryption, id).toBeDefined();
      expect(bucket.Properties!.OwnershipControls, id).toEqual({ Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] });
      const policy = ofType(template, 'AWS::S3::BucketPolicy').find(([, entry]) => JSON.stringify(entry.Properties!.Bucket) === JSON.stringify({ Ref: id }));
      expect(JSON.stringify(policy?.[1].Properties!.PolicyDocument), id).toContain('aws:SecureTransport');
    }
    expect(props('AuditBucket')).toMatchObject({
      ObjectLockEnabled: true,
      ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled', Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Days: { Ref: 'AuditRetentionDays' } } } },
    });
    expect(resource('AuditBucket').DeletionPolicy).toBe('Retain');
    // Downloads are readable by this distribution only, never by the public bucket URL.
    const downloads = JSON.stringify(props('DownloadsBucketPolicy').PolicyDocument);
    expect(downloads).toContain('cloudfront.amazonaws.com');
    expect(downloads).toContain('distribution/${DownloadsDistribution}');
    expect(JSON.stringify(props('DownloadsDistribution'))).toContain('redirect-to-https');
  });

  it('encrypts logs, secrets, buckets and the alarm topic with one rotating key', () => {
    expect(props('PlatformKey').EnableKeyRotation).toBe(true);
    const keyPolicy = JSON.stringify(props('PlatformKey').KeyPolicy);
    expect(keyPolicy).toContain('logs.${AWS::Region}.amazonaws.com');
    expect(keyPolicy).toContain('cloudwatch.amazonaws.com');
    for (const [id, group] of ofType(template, 'AWS::Logs::LogGroup'))
      expect(group.Properties!.KmsKeyId, id).toEqual({ 'Fn::GetAtt': ['PlatformKey', 'Arn'] });
    expect(props('DeploymentSecret').KmsKeyId).toEqual({ Ref: 'PlatformKey' });
    expect(props('AlarmTopic').KmsMasterKeyId).toEqual({ Ref: 'PlatformKey' });
  });

  it('alarms on API errors, unhealthy targets, missing workers and database capacity', () => {
    const alarms = ofType(template, 'AWS::CloudWatch::Alarm');
    expect(alarms.map(([id]) => id).sort()).toEqual(['ApiErrorsAlarm', 'ApiUnhealthyAlarm', 'DatabaseCapacityAlarm', 'GatewayUnhealthyAlarm', 'WorkerTasksAlarm']);
    for (const [, alarm] of alarms) expect(alarm.Properties!.AlarmActions).toEqual([{ Ref: 'AlarmTopic' }]);
    expect(resource('AlarmEmailSubscription').Condition).toBe('HasAlarmEmail');
  });

  it('writes DNS alias records only when a hosted zone is given', () => {
    expect(resource('ApiDnsRecord').Condition).toBe('HasHostedZone');
    expect(resource('GatewayDnsRecord').Condition).toBe('HasHostedZone');
    expect(props('ApiDnsRecord').AliasTarget).toEqual({
      DNSName: { 'Fn::GetAtt': ['ApiLoadBalancer', 'DNSName'] },
      HostedZoneId: { 'Fn::GetAtt': ['ApiLoadBalancer', 'CanonicalHostedZoneID'] },
    });
  });

  it('outputs what the operator runs the migrate task and DNS with', () => {
    const outputs = template.Outputs!;
    for (const name of ['ApiUrl', 'ApiLoadBalancerDnsName', 'GatewayLoadBalancerDnsName', 'DownloadsUrl', 'ClusterName', 'MigrateTaskDefinitionArn', 'TaskSubnetIds', 'MigrateSecurityGroupIds', 'PkiBundleSecretArn', 'EventBusName'])
      expect(outputs[name], name).toBeDefined();
  });
});
