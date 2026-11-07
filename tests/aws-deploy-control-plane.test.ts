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
const deploymentSecret = { 'Fn::If': ['HasExistingDeploymentSecret', { Ref: 'ExistingDeploymentSecretArn' }, { Ref: 'DeploymentSecret' }] };
const pkiBundle = { 'Fn::If': ['HasExistingPkiBundleSecret', { Ref: 'ExistingPkiBundleSecretArn' }, { Ref: 'PkiBundleSecret' }] };
const platformKeys = [
  { 'Fn::GetAtt': ['PlatformKey', 'Arn'] },
  { 'Fn::If': ['HasExistingPlatformKey', { Ref: 'ExistingPlatformKeyArn' }, { Ref: 'AWS::NoValue' }] },
];
/** The created-bucket branch of a resource that may name a retained bucket instead. */
const created = (resource: unknown): unknown => {
  const choice = (resource as { 'Fn::If'?: [string, unknown, unknown] })['Fn::If'];
  return choice && /^HasExisting\w+Bucket$/.test(choice[0]) ? choice[2] : resource;
};

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
        { Name: 'BETTER_COMPUTE_SECRET', ValueFrom: deploymentSecret },
        { Name: 'BC_PKI_BUNDLE', ValueFrom: pkiBundle },
      ]);
      for (const variable of entry.Environment) expect(variable.Name).not.toMatch(/SECRET|PASSWORD|TOKEN|KEY$/);
    }
    expect(resource('DeploymentSecret').DeletionPolicy).toBe('Retain');
  });

  it('never changes how the two secrets are generated', () => {
    // DO NOT CHANGE these values. CloudFormation regenerates a GenerateSecretString secret whenever the
    // property changes on a stack update: BETTER_COMPUTE_SECRET would rotate silently (everything sealed
    // with it, the PKI bundle included, becomes unreadable), and the operator's sealed PKI bundle would
    // be overwritten with a random placeholder.
    expect(props('DeploymentSecret').GenerateSecretString).toEqual({ PasswordLength: 64, ExcludePunctuation: true, IncludeSpace: false });
    expect(props('PkiBundleSecret').GenerateSecretString).toEqual({ PasswordLength: 32, ExcludePunctuation: true });
    expect(props('DeploymentSecret').Name).toBe('bc-deploy/better-compute/secret');
    expect(props('PkiBundleSecret').Name).toBe('bc-deploy/better-compute/pki-bundle');
  });

  it('adopts a retained deployment secret instead of generating one, for a restore or redeploy', () => {
    const parameters = template.Parameters!;
    expect(parameters.ExistingDeploymentSecretArn!.Default).toBe('');
    expect(parameters.ExistingPlatformKeyArn!.Default).toBe('');
    const secretPattern = new RegExp(parameters.ExistingDeploymentSecretArn!.AllowedPattern!);
    expect(secretPattern.test('')).toBe(true);
    expect(secretPattern.test('arn:aws:secretsmanager:us-east-1:123456789012:secret:bc-deploy/better-compute/secret-AbCdEf')).toBe(true);
    expect(secretPattern.test('bc-deploy/better-compute/secret')).toBe(false);
    const keyPattern = new RegExp(parameters.ExistingPlatformKeyArn!.AllowedPattern!);
    expect(keyPattern.test('')).toBe(true);
    expect(keyPattern.test('arn:aws:kms:us-east-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab')).toBe(true);
    expect(keyPattern.test('alias/old')).toBe(false);
    expect(template.Conditions!.HasExistingDeploymentSecret).toEqual({ 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'ExistingDeploymentSecretArn' }, ''] }] });
    expect(template.Conditions!.CreateDeploymentSecret).toEqual({ 'Fn::Equals': [{ Ref: 'ExistingDeploymentSecretArn' }, ''] });
    expect(resource('DeploymentSecret').Condition).toBe('CreateDeploymentSecret');
    // Every use of the generated secret goes through the same choice: it does not exist when one is adopted.
    const text = JSON.stringify(template);
    const bare = text.split(JSON.stringify({ Ref: 'DeploymentSecret' })).length - 1;
    const chosen = text.split(JSON.stringify(deploymentSecret)).length - 1;
    expect(bare).toBeGreaterThan(0);
    expect(bare).toBe(chosen);
    expect(template.Outputs!.DeploymentSecretArn!.Value).toEqual(deploymentSecret);
    // ECS injects it, so the execution role may read it and decrypt with the key that sealed it.
    const inject = (props('ExecutionRole').Policies as { PolicyDocument: { Statement: Statement[] } }[])[0]!.PolicyDocument.Statement;
    expect(inject.find((statement) => statement.Action === 'secretsmanager:GetSecretValue')!.Resource).toEqual([deploymentSecret, pkiBundle]);
    expect(inject.find((statement) => statement.Action === 'kms:Decrypt')!.Resource).toEqual(platformKeys);
    expect(lintTemplate(template)).toEqual([]);
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
      // `serve --roles controllers,scheduler,sinks,iam` installs the IAM handlers, which close a revoked
      // agent's or delegation's tunnels through every gateway's internal control API.
      expect.objectContaining({
        FromPort: { Ref: 'GatewayInternalPort' },
        ToPort: { Ref: 'GatewayInternalPort' },
        SourceSecurityGroupId: { Ref: 'WorkerSecurityGroup' },
      }),
    ]);
    expect(ingress('WorkerSecurityGroup')).toBeUndefined();
  });

  it('gives task roles scoped statements only: no wildcard resources or service-wide actions', () => {
    for (const role of ['ApiTaskRole', 'WorkerTaskRole', 'GatewayTaskRole', 'MigrateTaskRole', 'ExecutionRole']) {
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
    // The gateway hosts the secret broker in process (serve --roles gateway calls gatewayServices.secret), so it
    // reads tenant secrets; it only decrypts with the platform key and never encrypts.
    expect(gateway).toEqual(expect.arrayContaining(['secretsmanager:GetSecretValue', 'kms:Decrypt']));
    for (const action of ['kms:Encrypt', 'kms:GenerateDataKey']) expect(gateway).not.toContain(action);
    for (const role of ['ApiTaskRole', 'WorkerTaskRole'])
      expect(actionsOf(role), role).toEqual(expect.arrayContaining(['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey']));
    // awsSecretsManagerStore never calls DescribeSecret, so no role is granted it.
    for (const role of ['ApiTaskRole', 'WorkerTaskRole', 'GatewayTaskRole'])
      expect(actionsOf(role), role).not.toContain('secretsmanager:DescribeSecret');
    // Only the worker (sinks role) appends audit batches and publishes events.
    expect(actionsOf('WorkerTaskRole')).toEqual(expect.arrayContaining(['s3:PutObjectRetention', 'events:PutEvents']));
    expect(actionsOf('ApiTaskRole')).not.toContain('s3:PutObjectRetention');
    const connect = statementsOf('GatewayTaskRole').find((statement) => statement.Action === 'rds-db:connect' || [statement.Action].flat().includes('rds-db:connect'))!;
    expect(JSON.stringify(connect.Resource)).toContain(':dbuser:${ResourceId}/${DatabaseUser}');
  });

  it('runs the migrate task with a role that can only connect to the database', () => {
    // An upgrade runs the next image's migrate step before anyone has reviewed that image in production:
    // it gets no secret, bucket, bus or KMS permission, only rds-db:connect as the database user.
    expect(props('MigrateTask').TaskRoleArn).toEqual({ 'Fn::GetAtt': ['MigrateTaskRole', 'Arn'] });
    expect(props('MigrateTaskRole').ManagedPolicyArns).toBeUndefined();
    expect(actionsOf('MigrateTaskRole')).toEqual(['rds-db:connect']);
    const connect = statementsOf('MigrateTaskRole')[0]!;
    expect(JSON.stringify(connect.Resource)).toContain(':dbuser:${ResourceId}/${DatabaseUser}');
    expect((props('MigrateTaskRole').AssumeRolePolicyDocument as { Statement: Statement[] }).Statement[0]).toMatchObject({
      Principal: { Service: 'ecs-tasks.amazonaws.com' },
      Condition: { StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } } },
    });
    for (const task of ['ApiTask', 'WorkerTask', 'GatewayTask'])
      expect(props(task).TaskRoleArn, task).not.toEqual({ 'Fn::GetAtt': ['MigrateTaskRole', 'Arn'] });
  });

  it('lets every role that reads a bucket list it, so a missing key is 404 rather than 403', () => {
    // Without s3:ListBucket, S3 answers GetObject/HeadObject on a missing key with 403 AccessDenied,
    // and s3BlobStore.get only treats 404 as absent: a download never published would be a 5xx.
    const objectPath = /^\$\{(\w+)\.Arn\}\/\*$/;
    const readBuckets = (role: string) =>
      new Set(
        statementsOf(role)
          .filter((statement) => [statement.Action].flat().includes('s3:GetObject'))
          .flatMap((statement) => [statement.Resource].flat())
          .map((resource) => objectPath.exec((created(resource) as { 'Fn::Sub'?: string })['Fn::Sub'] ?? '')?.[1])
          .filter((bucket): bucket is string => bucket !== undefined),
      );
    const listedBuckets = (role: string) =>
      new Set(
        statementsOf(role)
          .filter((statement) => [statement.Action].flat().includes('s3:ListBucket'))
          .flatMap((statement) => [statement.Resource].flat())
          .map((resource) => /^\$\{(\w+)\.Arn\}$/.exec((created(resource) as { 'Fn::Sub'?: string })['Fn::Sub'] ?? '')?.[1]),
      );
    expect([...readBuckets('ApiTaskRole')].sort()).toEqual(['BlobsBucket', 'DownloadsBucket', 'SnapshotsBucket']);
    expect([...readBuckets('WorkerTaskRole')].sort()).toEqual(['BlobsBucket', 'SnapshotsBucket']);
    expect([...readBuckets('GatewayTaskRole')]).toEqual(['SnapshotsBucket']);
    for (const role of ['ApiTaskRole', 'WorkerTaskRole', 'GatewayTaskRole'])
      for (const bucket of readBuckets(role)) expect(listedBuckets(role).has(bucket), `${role} lists ${bucket}`).toBe(true);
    // Listing stays on the bucket ARN itself; nobody lists the audit archive.
    for (const role of ['ApiTaskRole', 'WorkerTaskRole', 'GatewayTaskRole']) expect(listedBuckets(role).has('AuditBucket'), role).toBe(false);
    expect(listedBuckets('GatewayTaskRole').has('BlobsBucket')).toBe(false);
  });

  it('restores under the same name by adopting the retained PKI bundle, buckets, key and log groups', () => {
    // A restored database stores snapshot URLs as s3://<old bucket>/…, tenant secrets under better-compute/<name>/
    // and objects encrypted with the old platform key: a restore must point at all of them, not create new ones.
    const parameters = template.Parameters!;
    for (const parameter of ['ExistingPkiBundleSecretArn', 'ExistingBlobsBucket', 'ExistingSnapshotsBucket', 'ExistingAuditBucket'])
      expect(parameters[parameter]!.Default, parameter).toBe('');
    expect(parameters.AdoptLogGroups).toMatchObject({ Default: 'false', AllowedValues: ['false', 'true'] });
    const bucketPattern = new RegExp(parameters.ExistingSnapshotsBucket!.AllowedPattern!);
    expect(bucketPattern.test('better-compute-control-plan-snapshotsbucket-1a2b3c4d5e6f')).toBe(true);
    expect(bucketPattern.test('arn:aws:s3:::x')).toBe(false);

    // The PKI bundle: the retained secret, injected as BC_PKI_BUNDLE, readable by the execution role.
    expect(resource('PkiBundleSecret').Condition).toBe('CreatePkiBundleSecret');
    expect(template.Outputs!.PkiBundleSecretArn!.Value).toEqual(pkiBundle);
    const text = JSON.stringify(template);
    expect(text.split(JSON.stringify({ Ref: 'PkiBundleSecret' })).length - 1).toBe(text.split(JSON.stringify(pkiBundle)).length - 1);

    // The buckets: not created, their names in the environment and outputs, IAM on their ARNs.
    for (const [id, variable, output] of [
      ['BlobsBucket', 'BC_BLOBS_BUCKET', 'BlobsBucketName'],
      ['SnapshotsBucket', 'BC_SNAPSHOTS_BUCKET', 'SnapshotsBucketName'],
      ['AuditBucket', 'BC_AUDIT_BUCKET', 'AuditBucketName'],
    ] as const) {
      const chosen = { 'Fn::If': [`HasExisting${id}`, { Ref: `Existing${id}` }, { Ref: id }] };
      expect(resource(id).Condition, id).toBe(`Create${id}`);
      expect(template.Conditions![`Create${id}`], id).toEqual({ 'Fn::Equals': [{ Ref: `Existing${id}` }, ''] });
      for (const task of ['ApiTask', 'WorkerTask', 'GatewayTask', 'MigrateTask']) expect(container(task).Environment, task).toContainEqual({ Name: variable, Value: chosen });
      expect(template.Outputs![output]!.Value, output).toEqual(chosen);
      // A retained bucket lost its policy with the old stack: the new one still refuses plain HTTP on it.
      const policy = props(`${id}Policy`);
      expect(policy.Bucket, id).toEqual(chosen);
      expect(JSON.stringify(policy.PolicyDocument), id).toContain('arn:${AWS::Partition}:s3:::${Existing' + id + '}/*');
      expect(resource(`${id}Policy`).Condition, id).toBeUndefined();
    }
    const snapshotReads = statementsOf('GatewayTaskRole').find((statement) => [statement.Action].flat().includes('s3:GetObject'))!;
    expect(snapshotReads.Resource).toEqual({
      'Fn::If': ['HasExistingSnapshotsBucket', { 'Fn::Sub': 'arn:${AWS::Partition}:s3:::${ExistingSnapshotsBucket}/*' }, { 'Fn::Sub': '${SnapshotsBucket.Arn}/*' }],
    });
    const audit = statementsOf('WorkerTaskRole').find((statement) => [statement.Action].flat().includes('s3:PutObjectRetention'))!;
    expect(JSON.stringify(audit.Resource)).toContain('${ExistingAuditBucket}/*');

    // The old platform key: every role decrypts with it (old objects and tenant secrets), api and worker write with it.
    for (const role of ['ApiTaskRole', 'WorkerTaskRole', 'GatewayTaskRole'])
      expect(statementsOf(role).find((statement) => statement.Action === 'kms:Decrypt')!.Resource, role).toEqual(platformKeys);
    for (const role of ['ApiTaskRole', 'WorkerTaskRole'])
      expect(statementsOf(role).find((statement) => [statement.Action].flat().includes('kms:GenerateDataKey'))!.Resource, role).toEqual(platformKeys);

    // The log groups, retained under fixed names: adopted by name instead of created again.
    expect(template.Conditions!.CreateLogGroups).toEqual({ 'Fn::Equals': [{ Ref: 'AdoptLogGroups' }, 'false'] });
    for (const role of ['api', 'worker', 'gateway', 'migrate']) {
      const id = `${role[0]!.toUpperCase()}${role.slice(1)}`;
      expect(resource(`${id}LogGroup`).Condition).toBe('CreateLogGroups');
      expect(container(`${id}Task`).LogConfiguration.Options['awslogs-group']).toEqual({
        'Fn::If': ['CreateLogGroups', { Ref: `${id}LogGroup` }, `/better-compute/better-compute/${role}`],
      });
    }
    expect(lintTemplate(template)).toEqual([]);
  });

  it('sends ALB and S3 server access logs to an operator-prepared bucket, when one is named', () => {
    const parameter = template.Parameters!.AccessLogsBucket!;
    expect(parameter.Default).toBe('');
    const pattern = new RegExp(parameter.AllowedPattern!);
    expect(pattern.test('')).toBe(true);
    expect(pattern.test('bc-prod-access-logs')).toBe(true);
    expect(pattern.test('Not_A_Bucket')).toBe(false);
    expect(template.Conditions!.HasAccessLogs).toEqual({ 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'AccessLogsBucket' }, ''] }] });

    const attributes = props('ApiLoadBalancer').LoadBalancerAttributes as unknown[];
    expect(attributes).toContainEqual({ Key: 'access_logs.s3.enabled', Value: { 'Fn::If': ['HasAccessLogs', 'true', 'false'] } });
    expect(attributes).toContainEqual({
      'Fn::If': ['HasAccessLogs', { Key: 'access_logs.s3.bucket', Value: { Ref: 'AccessLogsBucket' } }, { Ref: 'AWS::NoValue' }],
    });
    expect(attributes).toContainEqual({
      'Fn::If': ['HasAccessLogs', { Key: 'access_logs.s3.prefix', Value: 'alb/better-compute-api' }, { Ref: 'AWS::NoValue' }],
    });
    for (const [id, part] of [
      ['DownloadsBucket', 'downloads'],
      ['BlobsBucket', 'blobs'],
      ['SnapshotsBucket', 'snapshots'],
      ['AuditBucket', 'audit'],
    ] as const)
      expect(props(id).LoggingConfiguration, id).toEqual({
        'Fn::If': ['HasAccessLogs', { DestinationBucketName: { Ref: 'AccessLogsBucket' }, LogFilePrefix: `s3/better-compute-${part}/` }, { Ref: 'AWS::NoValue' }],
      });
    expect(lintTemplate(template)).toEqual([]);
  });

  it('scopes tenant secrets to this deployment, so two deployments in one account cannot read each other', () => {
    const secretResources = (from: CfnTemplate, role: string) => {
      const props = from.Resources[role]!.Properties!;
      const inline = ((props.Policies ?? []) as { PolicyDocument: { Statement: Statement[] } }[]).flatMap((policy) => policy.PolicyDocument.Statement);
      const managed = ((props.ManagedPolicyArns ?? []) as unknown[])
        .filter((entry): entry is { Ref: string } => typeof entry === 'object' && entry !== null && 'Ref' in entry)
        .flatMap((entry) => (from.Resources[entry.Ref]!.Properties!.PolicyDocument as { Statement: Statement[] }).Statement);
      return [...inline, ...managed]
        .filter((statement) => [statement.Action].flat().some((action) => action.startsWith('secretsmanager:')))
        .map((statement) => JSON.stringify(statement.Resource));
    };
    const staging = controlPlaneTemplate({ name: 'bc-staging' });
    for (const role of ['ApiTaskRole', 'WorkerTaskRole', 'GatewayTaskRole']) {
      const resources = secretResources(staging, role).filter((text) => !text.includes('"Ref"'));
      expect(resources.length, role).toBeGreaterThan(0);
      for (const text of resources) expect(text, role).toContain(':secret:better-compute/bc-staging/*');
    }
    // The tasks know their deployment, for awsSecretsManagerStore({ prefix: `better-compute/${BC_DEPLOYMENT}` }).
    for (const task of ['ApiTask', 'WorkerTask', 'GatewayTask', 'MigrateTask']) {
      const containers = staging.Resources[task]!.Properties!.ContainerDefinitions as Container[];
      expect(containers[0]!.Environment, task).toContainEqual({ Name: 'BC_DEPLOYMENT', Value: 'bc-staging' });
    }
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
      const policy = ofType(template, 'AWS::S3::BucketPolicy').find(([, entry]) => JSON.stringify(created(entry.Properties!.Bucket)) === JSON.stringify({ Ref: id }));
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
