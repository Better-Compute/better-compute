// The `control-plane` stack: the three better-compute process roles as ECS Fargate services from
// one digest-pinned image (`serve --roles …`), plus a one-off `migrate` task; an internet-facing
// ALB (ACM certificate, WAF) for the API and console, and an NLB in TCP passthrough for the
// gateway, which terminates the daemons' mutual TLS itself; least-privilege task roles; the
// deployment secret and the sealed PKI bundle in Secrets Manager; one rotating KMS key; S3 buckets
// for downloads (behind CloudFront), blobs, snapshots and the Object Lock audit archive; an
// EventBridge bus; encrypted log groups; and alarms on an SNS topic.
import {
  assertTemplate,
  cfnEquals,
  cfnGetAtt,
  cfnIf,
  cfnNoValue,
  cfnImport,
  cfnJoin,
  cfnRef,
  cfnSplit,
  cfnSub,
  deploymentTags,
  type CfnParameter,
  type CfnResource,
  type CfnTemplate,
} from './cfn.js';
import { stackNamePattern } from './data.js';
import { resolveDeploymentOptions, type AwsDeploymentOptions } from './options.js';
import { accountKeyPolicy, arn, denyInsecureTransport, policyDocument, serviceTrust, type PolicyStatement } from './policy.js';

/** The `serve` roles of each service: the split-roles shape of the deployment guide. */
export const controlPlaneCommands = {
  api: ['serve', '--roles', 'api', '--port', '3000', '--no-migrate'],
  worker: ['serve', '--roles', 'controllers,scheduler,sinks,iam', '--no-migrate'],
  gateway: ['serve', '--roles', 'gateway', '--no-migrate'],
  migrate: ['migrate'],
} as const;

type Role = keyof typeof controlPlaneCommands;

/** The CloudFormation pattern for a digest-pinned image reference. */
export const pinnedImagePattern = '^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$';

/** AWS managed CloudFront policies (ids are global constants). */
const cachingOptimized = '658327ea-f89d-4fab-a63d-7e88639e58f6';
const securityHeaders = '67f7725c-6f97-4210-82d7-5512b31e9d03';

/** The buckets a stack deletion keeps, which a restore adopts instead of creating. */
const retainedBuckets = ['BlobsBucket', 'SnapshotsBucket', 'AuditBucket'] as const;
type RetainedBucket = (typeof retainedBuckets)[number];

const apiPort = 3000;
const gatewayPort = 8443;

export function controlPlaneTemplate(options: AwsDeploymentOptions = {}): CfnTemplate {
  const resolved = resolveDeploymentOptions(options);
  const { name } = resolved;
  /** The tasks' `awsSecretsManagerStore` prefix (`better-compute/${BC_DEPLOYMENT}`); IAM confines secrets to it. */
  const secretNamePrefix = `better-compute/${name}`;
  const tags = (part: string) => deploymentTags(name, part);
  const keyArn = cfnGetAtt('PlatformKey', 'Arn');
  const privateSubnets = cfnSplit(',', cfnImport('PrivateSubnetIds'));
  const publicSubnets = cfnSplit(',', cfnImport('PublicSubnetIds'));
  const vpcId = cfnImport('VpcId');
  const databaseClients = cfnImport('DatabaseClientSecurityGroupId', 'DataStack');
  // A restore adopts the earlier stack's retained buckets (Existing<Bucket>): the restored database holds
  // s3://<old bucket>/… snapshot URLs and blob keys, so new buckets would orphan every stored object.
  const isRetained = (bucket: string): bucket is RetainedBucket => (retainedBuckets as readonly string[]).includes(bucket);
  const bucketArn = (bucket: string, path = '') =>
    isRetained(bucket)
      ? cfnIf(`HasExisting${bucket}`, arn(`s3:::\${Existing${bucket}}${path}`), cfnSub(`\${${bucket}.Arn}${path}`))
      : cfnSub(`\${${bucket}.Arn}${path}`);
  const bucketName = (bucket: string) =>
    isRetained(bucket) ? cfnIf(`HasExisting${bucket}`, cfnRef(`Existing${bucket}`), cfnRef(bucket)) : cfnRef(bucket);

  /** BETTER_COMPUTE_SECRET: the retained secret of an earlier stack when one is named, otherwise the generated one. */
  const deploymentSecret = cfnIf('HasExistingDeploymentSecret', cfnRef('ExistingDeploymentSecretArn'), cfnRef('DeploymentSecret'));
  /** The sealed PKI bundle: likewise the retained secret of an earlier stack when one is named. */
  const pkiBundle = cfnIf('HasExistingPkiBundleSecret', cfnRef('ExistingPkiBundleSecretArn'), cfnRef('PkiBundleSecret'));
  /** The platform key, plus the earlier stack's retained one on a restore (it encrypts every retained secret and object). */
  const platformKeys = [keyArn, cfnIf('HasExistingPlatformKey', cfnRef('ExistingPlatformKeyArn'), cfnNoValue)];
  const secretArnPattern = '^$|^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$';
  const existingBucket = (bucket: string): CfnParameter => ({
    Type: 'String',
    Description: `Restores: the earlier stack's retained ${bucket} bucket (its ${title(bucket)}BucketName), used instead of creating one (empty: create)`,
    Default: '',
    AllowedPattern: '^$|^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$',
    ConstraintDescription: 'empty, or an S3 bucket name',
  });

  const parameters: Record<string, CfnParameter> = {
    NetworkStack: { Type: 'String', Description: 'The network stack name', AllowedPattern: stackNamePattern },
    DataStack: { Type: 'String', Description: 'The data stack name', AllowedPattern: stackNamePattern },
    Image: {
      Type: 'String',
      Description: 'The control-plane image (the better-compute CLI as entrypoint, your configuration inside), pinned by digest',
      AllowedPattern: pinnedImagePattern,
      ConstraintDescription: 'an image reference pinned by digest: <repository>@sha256:<64 hex>',
    },
    MigrateImage: {
      Type: 'String',
      Description: 'Upgrades: the next image, for the migrate task only, run before Image moves to it (empty: Image)',
      Default: '',
      AllowedPattern: `^$|${pinnedImagePattern}`,
      ConstraintDescription: 'empty, or an image reference pinned by digest',
    },
    CpuArchitecture: { Type: 'String', Description: 'The image architecture', Default: 'X86_64', AllowedValues: ['X86_64', 'ARM64'] },
    AccessLogsBucket: {
      Type: 'String',
      Description:
        'A bucket in this account and region, prepared for ALB and S3 server access log delivery (its policy grants the ELB and logging.s3.amazonaws.com principals), or empty for none',
      Default: '',
      AllowedPattern: '^$|^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$',
      ConstraintDescription: 'empty, or an S3 bucket name',
    },
    ApiDomainName: {
      Type: 'String',
      Description: 'The public host of the API and console (baseURL is https://<this>)',
      AllowedPattern: '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$',
    },
    GatewayDomainName: {
      Type: 'String',
      Description: 'The public host daemons dial on 443 (the gateway serving certificate names it)',
      AllowedPattern: '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$',
    },
    CertificateArn: {
      Type: 'String',
      Description: 'The ACM certificate for ApiDomainName (same region as the stack)',
      AllowedPattern: '^arn:aws[a-z-]*:acm:[a-z0-9-]+:[0-9]{12}:certificate/[0-9a-f-]+$',
    },
    HostedZoneId: {
      Type: 'String',
      Description: 'Optional Route 53 hosted zone for alias records of both domain names (empty: none)',
      Default: '',
      AllowedPattern: '^(Z[A-Z0-9]{1,31})?$',
    },
    DatabaseUser: {
      Type: 'String',
      Description: 'The IAM-authenticated PostgreSQL user the processes connect as (GRANT rds_iam)',
      Default: 'bc_app',
      AllowedPattern: '^[a-z][a-z0-9_]{0,62}$',
    },
    ApiCount: { Type: 'Number', Description: 'api tasks (0 until the first migrate)', Default: 3, MinValue: 0, MaxValue: 100 },
    WorkerCount: { Type: 'Number', Description: 'worker tasks', Default: 2, MinValue: 0, MaxValue: 100 },
    GatewayCount: { Type: 'Number', Description: 'gateway tasks', Default: 3, MinValue: 0, MaxValue: 100 },
    TaskCpu: { Type: 'String', Description: 'Fargate CPU units per task', Default: '1024', AllowedValues: ['256', '512', '1024', '2048', '4096', '8192'] },
    TaskMemory: { Type: 'String', Description: 'Fargate memory (MiB) per task, valid for TaskCpu', Default: '2048', AllowedPattern: '^[0-9]{3,6}$' },
    GatewayInternalPort: {
      Type: 'Number',
      Description: "The gateway's internal control API port (host.gateway.internal.listen.port)",
      Default: 8444,
      MinValue: 1024,
      MaxValue: 65535,
    },
    AuditRetentionDays: { Type: 'Number', Description: 'Object Lock compliance retention of audit batches', Default: 400, MinValue: 1, MaxValue: 36500 },
    LogRetentionDays: {
      Type: 'Number',
      Description: 'Days to keep process logs',
      Default: 90,
      AllowedValues: [30, 60, 90, 180, 365, 731, 1827],
    },
    WafRateLimit: { Type: 'Number', Description: 'Requests per 5 minutes per client IP before WAF blocks', Default: 2000, MinValue: 100 },
    DownloadsPriceClass: {
      Type: 'String',
      Description: 'CloudFront price class of the downloads distribution',
      Default: 'PriceClass_100',
      AllowedValues: ['PriceClass_100', 'PriceClass_200', 'PriceClass_All'],
    },
    AlarmEmail: { Type: 'String', Description: 'Optional address subscribed to the alarm topic (empty: none)', Default: '' },
    ExistingDeploymentSecretArn: {
      Type: 'String',
      Description:
        'Restores and redeploys: the retained BETTER_COMPUTE_SECRET of an earlier stack (its DeploymentSecretArn), used instead of generating a new one (empty: generate)',
      Default: '',
      AllowedPattern: secretArnPattern,
      ConstraintDescription: 'empty, or a Secrets Manager secret ARN',
    },
    ExistingPkiBundleSecretArn: {
      Type: 'String',
      Description: "Restores: the earlier stack's retained sealed PKI bundle secret (its PkiBundleSecretArn), used instead of creating one (empty: create)",
      Default: '',
      AllowedPattern: secretArnPattern,
      ConstraintDescription: 'empty, or a Secrets Manager secret ARN',
    },
    ExistingPlatformKeyArn: {
      Type: 'String',
      Description:
        "Restores: the earlier stack's retained PlatformKeyArn, which encrypts its retained secrets, buckets and tenant secrets; every role may decrypt with it (empty: none)",
      Default: '',
      AllowedPattern: '^$|^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:key/[0-9a-f-]+$',
      ConstraintDescription: 'empty, or a KMS key ARN',
    },
    ExistingBlobsBucket: existingBucket('blobs'),
    ExistingSnapshotsBucket: existingBucket('snapshots'),
    ExistingAuditBucket: existingBucket('audit'),
    AdoptLogGroups: {
      Type: 'String',
      Description: "Restores under the same name: 'true' writes to the retained /better-compute/<name>/* log groups instead of creating them",
      Default: 'false',
      AllowedValues: ['false', 'true'],
    },
  };

  const resources: Record<string, CfnResource> = {};

  // --- Key, secrets, bus ---------------------------------------------------------------------------
  resources.PlatformKey = {
    Type: 'AWS::KMS::Key',
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: {
      Description: `${name}: secrets, buckets, logs and alarms`,
      EnableKeyRotation: true,
      KeyPolicy: accountKeyPolicy([
        {
          Sid: 'CloudWatchLogs',
          Effect: 'Allow',
          Principal: { Service: cfnSub('logs.${AWS::Region}.amazonaws.com') },
          Action: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
          Resource: '*',
          Condition: { ArnLike: { 'kms:EncryptionContext:aws:logs:arn': arn('logs:${AWS::Region}:${AWS::AccountId}:log-group:*') } },
        },
        {
          Sid: 'CloudWatchAlarmsToSns',
          Effect: 'Allow',
          Principal: { Service: 'cloudwatch.amazonaws.com' },
          Action: ['kms:Decrypt', 'kms:GenerateDataKey*'],
          Resource: '*',
          Condition: { StringEquals: { 'aws:SourceAccount': cfnRef('AWS::AccountId') } },
        },
      ]),
      Tags: tags('platform'),
    },
  };
  resources.PlatformKeyAlias = {
    Type: 'AWS::KMS::Alias',
    Properties: { AliasName: `alias/${name}-platform`, TargetKeyId: cfnRef('PlatformKey') },
  };
  // DO NOT CHANGE either GenerateSecretString block (tests/aws-deploy-control-plane.test.ts pins them).
  // CloudFormation generates a new value whenever that property changes on an update: BETTER_COMPUTE_SECRET
  // would rotate silently, leaving everything sealed with it unreadable (the PKI bundle too), and the
  // operator's sealed PKI bundle would be replaced by a random placeholder.
  resources.DeploymentSecret = {
    Type: 'AWS::SecretsManager::Secret',
    Condition: 'CreateDeploymentSecret',
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: {
      Name: `bc-deploy/${name}/secret`,
      Description: `${name}: BETTER_COMPUTE_SECRET, the same for every process`,
      KmsKeyId: cfnRef('PlatformKey'),
      GenerateSecretString: { PasswordLength: 64, ExcludePunctuation: true, IncludeSpace: false },
      Tags: tags('secret'),
    },
  };
  resources.PkiBundleSecret = {
    Type: 'AWS::SecretsManager::Secret',
    Condition: 'CreatePkiBundleSecret',
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: {
      Name: `bc-deploy/${name}/pki-bundle`,
      Description: `${name}: the sealed PKI bundle (pki init); put its JSON here before the first gateway starts`,
      KmsKeyId: cfnRef('PlatformKey'),
      // A random placeholder until the operator puts the sealed bundle (PutSecretValue).
      GenerateSecretString: { PasswordLength: 32, ExcludePunctuation: true },
      Tags: tags('pki'),
    },
  };
  resources.EventBus = { Type: 'AWS::Events::EventBus', Properties: { Name: `${name}-events`, Tags: tags('events') } };

  // --- Buckets ---------------------------------------------------------------------------------------
  const kmsEncryption = {
    ServerSideEncryptionConfiguration: [
      { ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: keyArn }, BucketKeyEnabled: true },
    ],
  };
  // The retained buckets are created only when no earlier stack's bucket is adopted (Create<Bucket>).
  const privateBucket = (part: string, extra: Record<string, unknown>, retain: boolean): CfnResource => ({
    Type: 'AWS::S3::Bucket',
    ...(retain
      ? { Condition: `Create${title(part)}Bucket`, DeletionPolicy: 'Retain' as const, UpdateReplacePolicy: 'Retain' as const }
      : {}),
    Properties: {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
      VersioningConfiguration: { Status: 'Enabled' },
      BucketEncryption: kmsEncryption,
      LifecycleConfiguration: {
        Rules: [
          { Id: 'abort-incomplete-uploads', Status: 'Enabled', AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 } },
          ...(part === 'audit' ? [] : [{ Id: 'expire-old-versions', Status: 'Enabled', NoncurrentVersionExpiration: { NoncurrentDays: 30 } }]),
        ],
      },
      // Server access logs, when the operator names a prepared bucket (AccessLogsBucket).
      LoggingConfiguration: cfnIf(
        'HasAccessLogs',
        { DestinationBucketName: cfnRef('AccessLogsBucket'), LogFilePrefix: `s3/${name}-${part}/` },
        cfnNoValue,
      ),
      ...extra,
      Tags: tags(part),
    },
  });
  // Created for an adopted bucket too: the old stack's bucket policy went with it.
  const tlsOnlyPolicy = (bucket: string, extra: readonly PolicyStatement[] = []): CfnResource => ({
    Type: 'AWS::S3::BucketPolicy',
    Properties: {
      Bucket: bucketName(bucket),
      PolicyDocument: policyDocument([denyInsecureTransport([bucketArn(bucket), bucketArn(bucket, '/*')]), ...extra]),
    },
  });
  resources.DownloadsBucket = privateBucket(
    'downloads',
    // SSE-S3: the objects are public bcd binaries served through CloudFront's origin access control.
    { BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] } },
    false,
  );
  resources.DownloadsBucketPolicy = tlsOnlyPolicy('DownloadsBucket', [
    {
      Sid: 'CloudFrontReadsDownloads',
      Effect: 'Allow',
      Principal: { Service: 'cloudfront.amazonaws.com' },
      Action: 's3:GetObject',
      Resource: bucketArn('DownloadsBucket', '/*'),
      Condition: { StringEquals: { 'AWS:SourceArn': arn('cloudfront::${AWS::AccountId}:distribution/${DownloadsDistribution}') } },
    },
  ]);
  resources.BlobsBucket = privateBucket('blobs', {}, true);
  resources.BlobsBucketPolicy = tlsOnlyPolicy('BlobsBucket');
  resources.SnapshotsBucket = privateBucket('snapshots', {}, true);
  resources.SnapshotsBucketPolicy = tlsOnlyPolicy('SnapshotsBucket');
  resources.AuditBucket = privateBucket(
    'audit',
    {
      ObjectLockEnabled: true,
      ObjectLockConfiguration: {
        ObjectLockEnabled: 'Enabled',
        Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Days: cfnRef('AuditRetentionDays') } },
      },
    },
    true,
  );
  resources.AuditBucketPolicy = tlsOnlyPolicy('AuditBucket');
  resources.DownloadsOriginAccessControl = {
    Type: 'AWS::CloudFront::OriginAccessControl',
    Properties: {
      OriginAccessControlConfig: {
        Name: `${name}-downloads`,
        Description: `${name}: CloudFront reads the downloads bucket`,
        OriginAccessControlOriginType: 's3',
        SigningBehavior: 'always',
        SigningProtocol: 'sigv4',
      },
    },
  };
  resources.DownloadsDistribution = {
    Type: 'AWS::CloudFront::Distribution',
    Properties: {
      DistributionConfig: {
        Enabled: true,
        Comment: `${name}: bcd downloads`,
        HttpVersion: 'http2and3',
        IPV6Enabled: true,
        PriceClass: cfnRef('DownloadsPriceClass'),
        Origins: [
          {
            Id: 'downloads',
            DomainName: cfnGetAtt('DownloadsBucket', 'RegionalDomainName'),
            S3OriginConfig: { OriginAccessIdentity: '' },
            OriginAccessControlId: cfnGetAtt('DownloadsOriginAccessControl', 'Id'),
          },
        ],
        DefaultCacheBehavior: {
          TargetOriginId: 'downloads',
          ViewerProtocolPolicy: 'redirect-to-https',
          AllowedMethods: ['GET', 'HEAD'],
          CachedMethods: ['GET', 'HEAD'],
          Compress: true,
          CachePolicyId: cachingOptimized,
          ResponseHeadersPolicyId: securityHeaders,
        },
      },
      Tags: tags('downloads'),
    },
  };

  // --- Logs --------------------------------------------------------------------------------------------
  for (const role of ['api', 'worker', 'gateway', 'migrate'] as const)
    resources[`${title(role)}LogGroup`] = {
      Type: 'AWS::Logs::LogGroup',
      Condition: 'CreateLogGroups',
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: {
        LogGroupName: `/better-compute/${name}/${role}`,
        RetentionInDays: cfnRef('LogRetentionDays'),
        KmsKeyId: keyArn,
        Tags: tags(`${role}-logs`),
      },
    };

  // --- IAM ---------------------------------------------------------------------------------------------
  // Tenant secrets live under this deployment's own prefix: a second deployment in the same
  // account and region (staging beside production) can neither read nor overwrite them.
  const secretPrefix = arn(`secretsmanager:\${AWS::Region}:\${AWS::AccountId}:secret:${secretNamePrefix}/*`);
  const objects = (bucket: string) => bucketArn(bucket, '/*');
  // A reader also needs s3:ListBucket on the bucket itself: without it S3 answers GetObject or
  // HeadObject on a missing key with 403 AccessDenied rather than 404, and s3BlobStore.get treats
  // only 404 as absent. Listing reveals key names only, never object bodies.
  const listBuckets = (sid: string, ...buckets: string[]): PolicyStatement => ({
    Sid: sid,
    Effect: 'Allow',
    Action: 's3:ListBucket',
    Resource: buckets.map((bucket) => bucketArn(bucket)),
  });
  const connect: PolicyStatement = {
    Sid: 'ConnectAsTheDatabaseUser',
    Effect: 'Allow',
    Action: 'rds-db:connect',
    Resource: cfnSub('arn:${AWS::Partition}:rds-db:${AWS::Region}:${AWS::AccountId}:dbuser:${ResourceId}/${DatabaseUser}', {
      ResourceId: cfnImport('ClusterResourceId', 'DataStack'),
    }),
  };
  const base: PolicyStatement[] = [
    connect,
    // Every role resolves: the gateway too, because `serve --roles gateway` runs the secret broker in process
    // (gatewayServices.secret). The broker only releases a ref bound to the asking node's current work, sealed
    // to the node (JWE); the store calls GetSecretValue and nothing else.
    { Sid: 'ResolveSecrets', Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: secretPrefix },
    { Sid: 'DecryptWithPlatformKey', Effect: 'Allow', Action: 'kms:Decrypt', Resource: platformKeys },
    // NodeSpec signs snapshot download URLs wherever it renders.
    { Sid: 'ReadSnapshots', Effect: 'Allow', Action: 's3:GetObject', Resource: objects('SnapshotsBucket') },
    listBuckets('ListSnapshots', 'SnapshotsBucket'),
  ];
  // Writing secrets and KMS-encrypted objects asks KMS for data keys as the caller; only api and worker write.
  // An adopted bucket's default encryption names the old key, so writers may use it too.
  const encrypt: PolicyStatement = { Sid: 'EncryptWithPlatformKey', Effect: 'Allow', Action: ['kms:GenerateDataKey', 'kms:Encrypt'], Resource: platformKeys };
  const writeSecrets: PolicyStatement = {
    Sid: 'WriteSecrets',
    Effect: 'Allow',
    Action: ['secretsmanager:CreateSecret', 'secretsmanager:PutSecretValue', 'secretsmanager:DeleteSecret', 'secretsmanager:TagResource'],
    Resource: secretPrefix,
  };
  const writeObjects = (sid: string, bucket: string): PolicyStatement => ({
    Sid: sid,
    Effect: 'Allow',
    Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload'],
    Resource: objects(bucket),
  });
  const policies: Record<Exclude<Role, 'migrate'>, PolicyStatement[]> = {
    api: [
      encrypt,
      writeSecrets,
      { Sid: 'ServeDownloads', Effect: 'Allow', Action: 's3:GetObject', Resource: objects('DownloadsBucket') },
      writeObjects('Blobs', 'BlobsBucket'),
      writeObjects('Snapshots', 'SnapshotsBucket'),
      listBuckets('ListBuckets', 'DownloadsBucket', 'BlobsBucket'),
      { Sid: 'PublishEvents', Effect: 'Allow', Action: 'events:PutEvents', Resource: cfnGetAtt('EventBus', 'Arn') },
    ],
    worker: [
      encrypt,
      writeSecrets,
      writeObjects('Blobs', 'BlobsBucket'),
      writeObjects('Snapshots', 'SnapshotsBucket'),
      listBuckets('ListBuckets', 'BlobsBucket'),
      { Sid: 'AppendAudit', Effect: 'Allow', Action: ['s3:PutObject', 's3:PutObjectRetention'], Resource: objects('AuditBucket') },
      { Sid: 'PublishEvents', Effect: 'Allow', Action: 'events:PutEvents', Resource: cfnGetAtt('EventBus', 'Arn') },
    ],
    gateway: [],
  };
  resources.BasePolicy = {
    Type: 'AWS::IAM::ManagedPolicy',
    Properties: { Description: `${name}: what every process needs`, PolicyDocument: policyDocument(base) },
  };
  for (const role of ['api', 'worker', 'gateway'] as const)
    resources[`${title(role)}TaskRole`] = {
      Type: 'AWS::IAM::Role',
      Properties: {
        Description: `${name}: the ${role} tasks`,
        AssumeRolePolicyDocument: serviceTrust('ecs-tasks.amazonaws.com'),
        ManagedPolicyArns: [cfnRef('BasePolicy')],
        ...(policies[role].length > 0 ? { Policies: [{ PolicyName: role, PolicyDocument: policyDocument(policies[role]) }] } : {}),
        Tags: tags(role),
      },
    };
  // An upgrade runs the next image's migrate step before that image serves anything: it only connects to the
  // database (BETTER_COMPUTE_SECRET and the PKI bundle are injected by the execution role, not read by the task).
  resources.MigrateTaskRole = {
    Type: 'AWS::IAM::Role',
    Properties: {
      Description: `${name}: the migrate task (database only)`,
      AssumeRolePolicyDocument: serviceTrust('ecs-tasks.amazonaws.com'),
      Policies: [{ PolicyName: 'migrate', PolicyDocument: policyDocument([connect]) }],
      Tags: tags('migrate'),
    },
  };
  resources.ExecutionRole = {
    Type: 'AWS::IAM::Role',
    Properties: {
      Description: `${name}: ECS pulls images, writes logs and injects the two secrets`,
      AssumeRolePolicyDocument: serviceTrust('ecs-tasks.amazonaws.com'),
      ManagedPolicyArns: [arn('iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy')],
      Policies: [
        {
          PolicyName: 'inject-secrets',
          PolicyDocument: policyDocument([
            { Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: [deploymentSecret, pkiBundle] },
            { Effect: 'Allow', Action: 'kms:Decrypt', Resource: platformKeys },
          ]),
        },
      ],
      Tags: tags('execution'),
    },
  };

  // --- Network ----------------------------------------------------------------------------------------
  const group = (part: string, description: string, ingress?: Record<string, unknown>[]): CfnResource => ({
    Type: 'AWS::EC2::SecurityGroup',
    Properties: { GroupDescription: `${name}: ${description}`, VpcId: vpcId, ...(ingress ? { SecurityGroupIngress: ingress } : {}), Tags: tags(part) },
  });
  const anywhere = (port: number, description: string) => ({ IpProtocol: 'tcp', FromPort: port, ToPort: port, CidrIp: '0.0.0.0/0', Description: description });
  resources.LoadBalancerSecurityGroup = group('alb', 'the API load balancer', [anywhere(443, 'HTTPS'), anywhere(80, 'HTTP (redirects)')]);
  resources.GatewayLoadBalancerSecurityGroup = group('nlb', 'the gateway load balancer', [anywhere(443, 'daemons (mTLS passthrough)')]);
  resources.ApiSecurityGroup = group('api', 'api tasks', [
    { IpProtocol: 'tcp', FromPort: apiPort, ToPort: apiPort, SourceSecurityGroupId: cfnRef('LoadBalancerSecurityGroup'), Description: 'from the ALB' },
  ]);
  resources.GatewaySecurityGroup = group('gateway', 'gateway tasks', [
    { IpProtocol: 'tcp', FromPort: gatewayPort, ToPort: gatewayPort, SourceSecurityGroupId: cfnRef('GatewayLoadBalancerSecurityGroup'), Description: 'daemons through the NLB' },
    {
      IpProtocol: 'tcp',
      FromPort: cfnRef('GatewayInternalPort'),
      ToPort: cfnRef('GatewayInternalPort'),
      SourceSecurityGroupId: cfnRef('ApiSecurityGroup'),
      Description: 'the internal control API, from api tasks',
    },
    // The worker's iam role (installIamHandlers) closes a revoked agent's or delegation's tunnels on every gateway.
    {
      IpProtocol: 'tcp',
      FromPort: cfnRef('GatewayInternalPort'),
      ToPort: cfnRef('GatewayInternalPort'),
      SourceSecurityGroupId: cfnRef('WorkerSecurityGroup'),
      Description: 'the internal control API, from worker tasks (iam revocations)',
    },
  ]);
  resources.WorkerSecurityGroup = group('worker', 'worker and migrate tasks (no ingress)');

  // --- API load balancer and WAF ---------------------------------------------------------------------
  resources.ApiLoadBalancer = {
    Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
    Properties: {
      Type: 'application',
      Scheme: 'internet-facing',
      Subnets: publicSubnets,
      SecurityGroups: [cfnRef('LoadBalancerSecurityGroup')],
      LoadBalancerAttributes: [
        { Key: 'deletion_protection.enabled', Value: 'true' },
        { Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' },
        { Key: 'routing.http.desync_mitigation_mode', Value: 'defensive' },
        // Interactive tunnels are long-lived WebSockets.
        { Key: 'idle_timeout.timeout_seconds', Value: '3600' },
        // The NLB has none to give: it is TCP passthrough, and NLB access logs cover TLS listeners only.
        { Key: 'access_logs.s3.enabled', Value: cfnIf('HasAccessLogs', 'true', 'false') },
        cfnIf('HasAccessLogs', { Key: 'access_logs.s3.bucket', Value: cfnRef('AccessLogsBucket') }, cfnNoValue),
        cfnIf('HasAccessLogs', { Key: 'access_logs.s3.prefix', Value: `alb/${name}-api` }, cfnNoValue),
      ],
      Tags: tags('api'),
    },
  };
  resources.ApiTargetGroup = {
    Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
    Properties: {
      TargetType: 'ip',
      Protocol: 'HTTP',
      Port: apiPort,
      VpcId: vpcId,
      HealthCheckPath: '/readyz',
      HealthCheckIntervalSeconds: 15,
      HealthyThresholdCount: 2,
      UnhealthyThresholdCount: 3,
      Matcher: { HttpCode: '200' },
      TargetGroupAttributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '30' }],
      Tags: tags('api'),
    },
  };
  resources.HttpsListener = {
    Type: 'AWS::ElasticLoadBalancingV2::Listener',
    Properties: {
      LoadBalancerArn: cfnRef('ApiLoadBalancer'),
      Protocol: 'HTTPS',
      Port: 443,
      SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
      Certificates: [{ CertificateArn: cfnRef('CertificateArn') }],
      DefaultActions: [{ Type: 'forward', TargetGroupArn: cfnRef('ApiTargetGroup') }],
    },
  };
  resources.HttpListener = {
    Type: 'AWS::ElasticLoadBalancingV2::Listener',
    Properties: {
      LoadBalancerArn: cfnRef('ApiLoadBalancer'),
      Protocol: 'HTTP',
      Port: 80,
      DefaultActions: [{ Type: 'redirect', RedirectConfig: { Protocol: 'HTTPS', Port: '443', StatusCode: 'HTTP_301' } }],
    },
  };
  const visibility = (metric: string) => ({ SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: `${name}-${metric}` });
  const managedRule = (ruleName: string, priority: number, group: string, overrides?: unknown[]) => ({
    Name: ruleName,
    Priority: priority,
    OverrideAction: { None: {} },
    Statement: { ManagedRuleGroupStatement: { VendorName: 'AWS', Name: group, ...(overrides ? { RuleActionOverrides: overrides } : {}) } },
    VisibilityConfig: visibility(ruleName),
  });
  resources.WebAcl = {
    Type: 'AWS::WAFv2::WebACL',
    Properties: {
      Name: `${name}-api`,
      Scope: 'REGIONAL',
      DefaultAction: { Allow: {} },
      VisibilityConfig: visibility('api'),
      Rules: [
        {
          Name: 'rate-limit',
          Priority: 0,
          Action: { Block: {} },
          Statement: { RateBasedStatement: { Limit: cfnRef('WafRateLimit'), AggregateKeyType: 'IP' } },
          VisibilityConfig: visibility('rate-limit'),
        },
        managedRule('aws-ip-reputation', 1, 'AWSManagedRulesAmazonIpReputationList'),
        managedRule('aws-common', 2, 'AWSManagedRulesCommonRuleSet', [{ Name: 'SizeRestrictions_BODY', ActionToUse: { Count: {} } }]),
        managedRule('aws-known-bad-inputs', 3, 'AWSManagedRulesKnownBadInputsRuleSet'),
      ],
      Tags: tags('api'),
    },
  };
  resources.WebAclAssociation = {
    Type: 'AWS::WAFv2::WebACLAssociation',
    Properties: { ResourceArn: cfnRef('ApiLoadBalancer'), WebACLArn: cfnGetAtt('WebAcl', 'Arn') },
  };

  // --- Gateway load balancer (TCP passthrough) ---------------------------------------------------------
  resources.GatewayLoadBalancer = {
    Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
    Properties: {
      Type: 'network',
      Scheme: 'internet-facing',
      Subnets: publicSubnets,
      SecurityGroups: [cfnRef('GatewayLoadBalancerSecurityGroup')],
      LoadBalancerAttributes: [
        { Key: 'deletion_protection.enabled', Value: 'true' },
        { Key: 'load_balancing.cross_zone.enabled', Value: 'true' },
      ],
      Tags: tags('gateway'),
    },
  };
  resources.GatewayTargetGroup = {
    Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
    Properties: {
      TargetType: 'ip',
      Protocol: 'TCP',
      Port: gatewayPort,
      VpcId: vpcId,
      HealthCheckProtocol: 'TCP',
      HealthCheckIntervalSeconds: 10,
      HealthyThresholdCount: 2,
      UnhealthyThresholdCount: 2,
      TargetGroupAttributes: [
        { Key: 'deregistration_delay.timeout_seconds', Value: '60' },
        // Tasks admit the NLB's security group, so the NLB's own address is the source.
        { Key: 'preserve_client_ip.enabled', Value: 'false' },
      ],
      Tags: tags('gateway'),
    },
  };
  resources.GatewayListener = {
    Type: 'AWS::ElasticLoadBalancingV2::Listener',
    Properties: {
      LoadBalancerArn: cfnRef('GatewayLoadBalancer'),
      Protocol: 'TCP',
      Port: 443,
      DefaultActions: [{ Type: 'forward', TargetGroupArn: cfnRef('GatewayTargetGroup') }],
    },
  };

  // --- ECS ---------------------------------------------------------------------------------------------
  resources.Cluster = {
    Type: 'AWS::ECS::Cluster',
    Properties: { ClusterName: name, ClusterSettings: [{ Name: 'containerInsights', Value: 'enabled' }], Tags: tags('cluster') },
  };
  const environment = (role: Role) => [
    { Name: 'BC_ROLE', Value: role },
    { Name: 'BC_DEPLOYMENT', Value: name },
    { Name: 'AWS_REGION', Value: cfnRef('AWS::Region') },
    { Name: 'BC_PUBLIC_URL', Value: cfnSub('https://${ApiDomainName}') },
    { Name: 'BC_GATEWAY_PUBLIC_HOST', Value: cfnRef('GatewayDomainName') },
    { Name: 'BC_GATEWAY_INTERNAL_PORT', Value: cfnSub('${GatewayInternalPort}') },
    { Name: 'BC_DATABASE_HOST', Value: cfnImport('ClusterEndpoint', 'DataStack') },
    { Name: 'BC_DATABASE_PORT', Value: cfnImport('Port', 'DataStack') },
    { Name: 'BC_DATABASE_NAME', Value: cfnImport('DatabaseName', 'DataStack') },
    { Name: 'BC_DATABASE_USER', Value: cfnRef('DatabaseUser') },
    { Name: 'BC_EVENT_BUS', Value: cfnRef('EventBus') },
    { Name: 'BC_DOWNLOADS_BUCKET', Value: cfnRef('DownloadsBucket') },
    { Name: 'BC_BLOBS_BUCKET', Value: bucketName('BlobsBucket') },
    { Name: 'BC_SNAPSHOTS_BUCKET', Value: bucketName('SnapshotsBucket') },
    { Name: 'BC_AUDIT_BUCKET', Value: bucketName('AuditBucket') },
    { Name: 'BC_AUDIT_RETENTION_DAYS', Value: cfnSub('${AuditRetentionDays}') },
    { Name: 'BC_KMS_KEY_ARN', Value: keyArn },
  ];
  const taskRole: Record<Role, string> = { api: 'ApiTaskRole', worker: 'WorkerTaskRole', gateway: 'GatewayTaskRole', migrate: 'MigrateTaskRole' };
  for (const role of ['api', 'worker', 'gateway', 'migrate'] as const) {
    const port = role === 'api' ? apiPort : role === 'gateway' ? gatewayPort : undefined;
    resources[`${title(role)}Task`] = {
      Type: 'AWS::ECS::TaskDefinition',
      Properties: {
        Family: `${name}-${role}`,
        Cpu: cfnRef('TaskCpu'),
        Memory: cfnRef('TaskMemory'),
        NetworkMode: 'awsvpc',
        RequiresCompatibilities: ['FARGATE'],
        RuntimePlatform: { OperatingSystemFamily: 'LINUX', CpuArchitecture: cfnRef('CpuArchitecture') },
        ExecutionRoleArn: cfnGetAtt('ExecutionRole', 'Arn'),
        TaskRoleArn: cfnGetAtt(taskRole[role], 'Arn'),
        ContainerDefinitions: [
          {
            Name: role,
            Image: role === 'migrate' ? cfnIf('HasMigrateImage', cfnRef('MigrateImage'), cfnRef('Image')) : cfnRef('Image'),
            Essential: true,
            Command: [...controlPlaneCommands[role]],
            ...(port !== undefined
              ? {
                  PortMappings: [
                    { ContainerPort: port, Protocol: 'tcp' },
                    ...(role === 'gateway' ? [{ ContainerPort: cfnRef('GatewayInternalPort'), Protocol: 'tcp' }] : []),
                  ],
                }
              : {}),
            Environment: environment(role),
            Secrets: [
              { Name: 'BETTER_COMPUTE_SECRET', ValueFrom: deploymentSecret },
              { Name: 'BC_PKI_BUNDLE', ValueFrom: pkiBundle },
            ],
            ReadonlyRootFilesystem: true,
            LinuxParameters: { InitProcessEnabled: true, Capabilities: { Drop: ['ALL'] } },
            StopTimeout: role === 'migrate' ? 120 : 30,
            LogConfiguration: {
              LogDriver: 'awslogs',
              Options: {
                // Adopted log groups are named, not referenced: they are not this stack's resources.
                'awslogs-group': cfnIf('CreateLogGroups', cfnRef(`${title(role)}LogGroup`), `/better-compute/${name}/${role}`),
                'awslogs-region': cfnRef('AWS::Region'),
                'awslogs-stream-prefix': role,
                mode: 'non-blocking',
                'max-buffer-size': '25m',
              },
            },
          },
        ],
        Tags: tags(role),
      },
    };
  }
  const service = (role: 'api' | 'worker' | 'gateway', count: string, groupId: string, extra: Record<string, unknown>, dependsOn?: string): CfnResource => ({
    Type: 'AWS::ECS::Service',
    ...(dependsOn ? { DependsOn: dependsOn } : {}),
    Properties: {
      ServiceName: role,
      Cluster: cfnRef('Cluster'),
      TaskDefinition: cfnRef(`${title(role)}Task`),
      DesiredCount: cfnRef(count),
      LaunchType: 'FARGATE',
      PlatformVersion: 'LATEST',
      NetworkConfiguration: {
        AwsvpcConfiguration: { AssignPublicIp: 'DISABLED', Subnets: privateSubnets, SecurityGroups: [cfnRef(groupId), databaseClients] },
      },
      DeploymentConfiguration: { MinimumHealthyPercent: 100, MaximumPercent: 200, DeploymentCircuitBreaker: { Enable: true, Rollback: true } },
      EnableExecuteCommand: false,
      EnableECSManagedTags: true,
      PropagateTags: 'SERVICE',
      ...extra,
      Tags: tags(role),
    },
  });
  resources.ApiService = service(
    'api',
    'ApiCount',
    'ApiSecurityGroup',
    { LoadBalancers: [{ ContainerName: 'api', ContainerPort: apiPort, TargetGroupArn: cfnRef('ApiTargetGroup') }], HealthCheckGracePeriodSeconds: 60 },
    'HttpsListener',
  );
  resources.WorkerService = service('worker', 'WorkerCount', 'WorkerSecurityGroup', {});
  resources.GatewayService = service(
    'gateway',
    'GatewayCount',
    'GatewaySecurityGroup',
    { LoadBalancers: [{ ContainerName: 'gateway', ContainerPort: gatewayPort, TargetGroupArn: cfnRef('GatewayTargetGroup') }], HealthCheckGracePeriodSeconds: 60 },
    'GatewayListener',
  );

  // --- DNS ---------------------------------------------------------------------------------------------
  const alias = (domain: string, balancer: string): CfnResource => ({
    Type: 'AWS::Route53::RecordSet',
    Condition: 'HasHostedZone',
    Properties: {
      HostedZoneId: cfnRef('HostedZoneId'),
      Name: cfnRef(domain),
      Type: 'A',
      AliasTarget: { DNSName: cfnGetAtt(balancer, 'DNSName'), HostedZoneId: cfnGetAtt(balancer, 'CanonicalHostedZoneID') },
    },
  });
  resources.ApiDnsRecord = alias('ApiDomainName', 'ApiLoadBalancer');
  resources.GatewayDnsRecord = alias('GatewayDomainName', 'GatewayLoadBalancer');

  // --- Alarms ------------------------------------------------------------------------------------------
  resources.AlarmTopic = {
    Type: 'AWS::SNS::Topic',
    Properties: { TopicName: `${name}-alarms`, KmsMasterKeyId: cfnRef('PlatformKey'), Tags: tags('alarms') },
  };
  resources.AlarmEmailSubscription = {
    Type: 'AWS::SNS::Subscription',
    Condition: 'HasAlarmEmail',
    Properties: { TopicArn: cfnRef('AlarmTopic'), Protocol: 'email', Endpoint: cfnRef('AlarmEmail') },
  };
  const alarm = (description: string, metric: Record<string, unknown>): CfnResource => ({
    Type: 'AWS::CloudWatch::Alarm',
    Properties: {
      AlarmDescription: `${name}: ${description}`,
      AlarmActions: [cfnRef('AlarmTopic')],
      OKActions: [cfnRef('AlarmTopic')],
      TreatMissingData: 'notBreaching',
      ...metric,
    },
  });
  resources.ApiErrorsAlarm = alarm('api 5xx responses', {
    Namespace: 'AWS/ApplicationELB',
    MetricName: 'HTTPCode_Target_5XX_Count',
    Dimensions: [{ Name: 'LoadBalancer', Value: cfnGetAtt('ApiLoadBalancer', 'LoadBalancerFullName') }],
    Statistic: 'Sum',
    Period: 300,
    EvaluationPeriods: 2,
    Threshold: 25,
    ComparisonOperator: 'GreaterThanOrEqualToThreshold',
  });
  resources.ApiUnhealthyAlarm = alarm('unhealthy api targets', {
    Namespace: 'AWS/ApplicationELB',
    MetricName: 'UnHealthyHostCount',
    Dimensions: [
      { Name: 'LoadBalancer', Value: cfnGetAtt('ApiLoadBalancer', 'LoadBalancerFullName') },
      { Name: 'TargetGroup', Value: cfnGetAtt('ApiTargetGroup', 'TargetGroupFullName') },
    ],
    Statistic: 'Maximum',
    Period: 60,
    EvaluationPeriods: 3,
    Threshold: 1,
    ComparisonOperator: 'GreaterThanOrEqualToThreshold',
  });
  resources.GatewayUnhealthyAlarm = alarm('unhealthy gateway targets', {
    Namespace: 'AWS/NetworkELB',
    MetricName: 'UnHealthyHostCount',
    Dimensions: [
      { Name: 'LoadBalancer', Value: cfnGetAtt('GatewayLoadBalancer', 'LoadBalancerFullName') },
      { Name: 'TargetGroup', Value: cfnGetAtt('GatewayTargetGroup', 'TargetGroupFullName') },
    ],
    Statistic: 'Maximum',
    Period: 60,
    EvaluationPeriods: 3,
    Threshold: 1,
    ComparisonOperator: 'GreaterThanOrEqualToThreshold',
  });
  resources.WorkerTasksAlarm = alarm('no running worker task', {
    Namespace: 'ECS/ContainerInsights',
    MetricName: 'RunningTaskCount',
    Dimensions: [
      { Name: 'ClusterName', Value: cfnRef('Cluster') },
      { Name: 'ServiceName', Value: cfnGetAtt('WorkerService', 'Name') },
    ],
    Statistic: 'Minimum',
    Period: 60,
    EvaluationPeriods: 5,
    Threshold: 1,
    ComparisonOperator: 'LessThanThreshold',
  });
  resources.DatabaseCapacityAlarm = alarm('Aurora capacity near its maximum', {
    Namespace: 'AWS/RDS',
    MetricName: 'ACUUtilization',
    Dimensions: [{ Name: 'DBClusterIdentifier', Value: cfnImport('ClusterIdentifier', 'DataStack') }],
    Statistic: 'Average',
    Period: 300,
    EvaluationPeriods: 3,
    Threshold: 90,
    ComparisonOperator: 'GreaterThanThreshold',
  });

  return assertTemplate('control-plane', {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: `better-compute ${name}: control plane (ECS Fargate api/worker/gateway, ALB+WAF, NLB passthrough, S3, KMS)`,
    Parameters: parameters,
    Conditions: {
      HasHostedZone: { 'Fn::Not': [cfnEquals(cfnRef('HostedZoneId'), '')] },
      HasAlarmEmail: { 'Fn::Not': [cfnEquals(cfnRef('AlarmEmail'), '')] },
      HasMigrateImage: { 'Fn::Not': [cfnEquals(cfnRef('MigrateImage'), '')] },
      HasAccessLogs: { 'Fn::Not': [cfnEquals(cfnRef('AccessLogsBucket'), '')] },
      HasExistingDeploymentSecret: { 'Fn::Not': [cfnEquals(cfnRef('ExistingDeploymentSecretArn'), '')] },
      CreateDeploymentSecret: cfnEquals(cfnRef('ExistingDeploymentSecretArn'), ''),
      HasExistingPkiBundleSecret: { 'Fn::Not': [cfnEquals(cfnRef('ExistingPkiBundleSecretArn'), '')] },
      CreatePkiBundleSecret: cfnEquals(cfnRef('ExistingPkiBundleSecretArn'), ''),
      HasExistingPlatformKey: { 'Fn::Not': [cfnEquals(cfnRef('ExistingPlatformKeyArn'), '')] },
      ...Object.fromEntries(
        retainedBuckets.flatMap((bucket) => [
          [`HasExisting${bucket}`, { 'Fn::Not': [cfnEquals(cfnRef(`Existing${bucket}`), '')] }],
          [`Create${bucket}`, cfnEquals(cfnRef(`Existing${bucket}`), '')],
        ]),
      ),
      CreateLogGroups: cfnEquals(cfnRef('AdoptLogGroups'), 'false'),
    },
    Resources: resources,
    Outputs: {
      ApiUrl: { Description: 'The public API origin (baseURL)', Value: cfnSub('https://${ApiDomainName}') },
      ApiLoadBalancerDnsName: { Description: 'Point ApiDomainName here (CNAME or alias)', Value: cfnGetAtt('ApiLoadBalancer', 'DNSName') },
      GatewayLoadBalancerDnsName: { Description: 'Point GatewayDomainName here', Value: cfnGetAtt('GatewayLoadBalancer', 'DNSName') },
      DownloadsUrl: { Description: 'The bcd downloads CDN', Value: cfnSub('https://${DownloadsDistribution.DomainName}') },
      DownloadsBucketName: { Description: 'Publish bcd binaries here', Value: cfnRef('DownloadsBucket') },
      BlobsBucketName: { Description: 'Support bundles and other blobs', Value: bucketName('BlobsBucket') },
      SnapshotsBucketName: { Description: 'Sandbox snapshots', Value: bucketName('SnapshotsBucket') },
      AuditBucketName: { Description: 'The Object Lock audit archive', Value: bucketName('AuditBucket') },
      EventBusName: { Description: 'The EventBridge bus for eventBridgeSink', Value: cfnRef('EventBus') },
      PlatformKeyArn: { Description: 'The platform KMS key', Value: keyArn },
      DeploymentSecretArn: { Description: 'BETTER_COMPUTE_SECRET', Value: deploymentSecret },
      PkiBundleSecretArn: { Description: 'Put the sealed PKI bundle here', Value: pkiBundle },
      AlarmTopicArn: { Description: 'Alarm notifications', Value: cfnRef('AlarmTopic') },
      ClusterName: { Description: 'The ECS cluster', Value: cfnRef('Cluster') },
      MigrateTaskDefinitionArn: { Description: 'Run once per deploy: aws ecs run-task', Value: cfnRef('MigrateTask') },
      TaskSubnetIds: { Description: 'Subnets for run-task', Value: cfnImport('PrivateSubnetIds') },
      MigrateSecurityGroupIds: {
        Description: 'Security groups for run-task',
        Value: cfnJoin(',', [cfnRef('WorkerSecurityGroup'), databaseClients]),
      },
    },
  });
}

function title(role: string): string {
  return role[0]!.toUpperCase() + role.slice(1);
}
