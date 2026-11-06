// The `data` stack: Aurora PostgreSQL (16 or later) Serverless v2 with IAM database
// authentication, btree_gist allowed and TLS forced, encrypted with its own KMS key, the master
// password generated and kept by Secrets Manager. Only the exported client security group reaches
// it; the control-plane tasks wear that group.
import {
  assertTemplate,
  cfnExport,
  cfnGetAtt,
  cfnImport,
  cfnJoin,
  cfnRef,
  cfnSelect,
  cfnSplit,
  deploymentTags,
  type CfnResource,
  type CfnTemplate,
} from './cfn.js';
import { accountKeyPolicy } from './policy.js';
import { resolveDeploymentOptions, type AwsDeploymentOptions } from './options.js';

/** The CloudFormation parameter pattern for a stack name the template imports from. */
export const stackNamePattern = '^[A-Za-z][A-Za-z0-9-]{0,127}$';

export function dataTemplate(options: AwsDeploymentOptions = {}): CfnTemplate {
  const resolved = resolveDeploymentOptions(options);
  const { name } = resolved;
  const tags = (part: string) => deploymentTags(name, part);
  const keyArn = cfnGetAtt('DatabaseKey', 'Arn');
  const instance = (promotionTier: number, part: string): CfnResource => ({
    Type: 'AWS::RDS::DBInstance',
    Properties: {
      DBClusterIdentifier: cfnRef('Cluster'),
      DBInstanceClass: 'db.serverless',
      Engine: 'aurora-postgresql',
      PubliclyAccessible: false,
      AutoMinorVersionUpgrade: true,
      PromotionTier: promotionTier,
      EnablePerformanceInsights: true,
      PerformanceInsightsKMSKeyId: keyArn,
      PerformanceInsightsRetentionPeriod: 7,
      Tags: tags(part),
    },
  });
  const resources: Record<string, CfnResource> = {
    DatabaseKey: {
      Type: 'AWS::KMS::Key',
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: {
        Description: `${name}: Aurora storage, snapshots, Performance Insights and the master secret`,
        EnableKeyRotation: true,
        KeyPolicy: accountKeyPolicy(),
        Tags: tags('database'),
      },
    },
    DatabaseKeyAlias: {
      Type: 'AWS::KMS::Alias',
      Properties: { AliasName: `alias/${name}-database`, TargetKeyId: cfnRef('DatabaseKey') },
    },
    SubnetGroup: {
      Type: 'AWS::RDS::DBSubnetGroup',
      Properties: {
        DBSubnetGroupDescription: `${name}: the network stack's private subnets`,
        SubnetIds: cfnSplit(',', cfnImport('PrivateSubnetIds')),
        Tags: tags('database'),
      },
    },
    DatabaseClientSecurityGroup: {
      Type: 'AWS::EC2::SecurityGroup',
      Properties: {
        GroupDescription: `${name}: processes that may reach the database`,
        VpcId: cfnImport('VpcId'),
        Tags: tags('database-clients'),
      },
    },
    DatabaseSecurityGroup: {
      Type: 'AWS::EC2::SecurityGroup',
      Properties: {
        GroupDescription: `${name}: the Aurora cluster`,
        VpcId: cfnImport('VpcId'),
        SecurityGroupIngress: [
          {
            IpProtocol: 'tcp',
            FromPort: 5432,
            ToPort: 5432,
            SourceSecurityGroupId: cfnGetAtt('DatabaseClientSecurityGroup', 'GroupId'),
            Description: 'PostgreSQL from the database clients group',
          },
        ],
        // The database dials nothing (a loopback-only rule replaces the default allow-all).
        SecurityGroupEgress: [{ IpProtocol: '-1', CidrIp: '127.0.0.1/32', Description: 'no egress' }],
        Tags: tags('database'),
      },
    },
    ClusterParameters: {
      Type: 'AWS::RDS::DBClusterParameterGroup',
      Properties: {
        Description: `${name}: TLS only, btree_gist allowed`,
        Family: cfnJoin('', ['aurora-postgresql', cfnSelect(0, cfnSplit('.', cfnRef('EngineVersion')))]),
        Parameters: { 'rds.force_ssl': '1', 'rds.allowed_extensions': 'btree_gist' },
        Tags: tags('database'),
      },
    },
    Cluster: {
      Type: 'AWS::RDS::DBCluster',
      DeletionPolicy: 'Snapshot',
      UpdateReplacePolicy: 'Snapshot',
      Properties: {
        Engine: 'aurora-postgresql',
        EngineVersion: cfnRef('EngineVersion'),
        DatabaseName: cfnRef('DatabaseName'),
        MasterUsername: cfnRef('MasterUsername'),
        ManageMasterUserPassword: true,
        MasterUserSecret: { KmsKeyId: keyArn },
        EnableIAMDatabaseAuthentication: true,
        StorageEncrypted: true,
        KmsKeyId: keyArn,
        ServerlessV2ScalingConfiguration: { MinCapacity: cfnRef('MinCapacity'), MaxCapacity: cfnRef('MaxCapacity') },
        DBSubnetGroupName: cfnRef('SubnetGroup'),
        VpcSecurityGroupIds: [cfnRef('DatabaseSecurityGroup')],
        DBClusterParameterGroupName: cfnRef('ClusterParameters'),
        Port: 5432,
        BackupRetentionPeriod: cfnRef('BackupRetentionDays'),
        PreferredBackupWindow: '03:00-04:00',
        PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
        CopyTagsToSnapshot: true,
        DeletionProtection: true,
        EnableCloudwatchLogsExports: ['postgresql'],
        Tags: tags('database'),
      },
    },
    WriterInstance: instance(0, 'database-writer'),
  };
  for (let reader = 0; reader < resolved.readers; reader++)
    resources[`ReaderInstance${reader}`] = instance(1, `database-reader-${reader}`);

  return assertTemplate('data', {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: `better-compute ${name}: data (Aurora PostgreSQL Serverless v2, IAM auth, KMS)`,
    Parameters: {
      NetworkStack: {
        Type: 'String',
        Description: 'The name of the network stack whose VPC and private subnets this stack imports',
        AllowedPattern: stackNamePattern,
      },
      EngineVersion: {
        Type: 'String',
        Description: 'Aurora PostgreSQL engine version (16 or later)',
        Default: '16.6',
        AllowedPattern: '^(1[6-9]|[2-9][0-9])\\.[0-9]+$',
        ConstraintDescription: 'an Aurora PostgreSQL version of 16 or later, such as 16.6',
      },
      DatabaseName: {
        Type: 'String',
        Description: 'The database the control plane uses',
        Default: 'better_compute',
        AllowedPattern: '^[a-z][a-z0-9_]{0,62}$',
      },
      MasterUsername: {
        Type: 'String',
        Description: 'The master user (its password is generated and kept in Secrets Manager)',
        Default: 'bc_admin',
        AllowedPattern: '^[a-z][a-z0-9_]{0,15}$',
      },
      MinCapacity: { Type: 'Number', Description: 'Serverless v2 minimum ACUs', Default: 0.5, MinValue: 0, MaxValue: 256 },
      MaxCapacity: { Type: 'Number', Description: 'Serverless v2 maximum ACUs', Default: 16, MinValue: 1, MaxValue: 256 },
      BackupRetentionDays: { Type: 'Number', Description: 'Automated backup retention', Default: 14, MinValue: 1, MaxValue: 35 },
    },
    Resources: resources,
    Outputs: {
      ...cfnExport('ClusterIdentifier', 'The Aurora cluster identifier', cfnRef('Cluster')),
      ...cfnExport('ClusterResourceId', 'The cluster resource id (rds-db:connect ARNs)', cfnGetAtt('Cluster', 'DBClusterResourceId')),
      ...cfnExport('ClusterEndpoint', 'The writer endpoint host', cfnGetAtt('Cluster', 'Endpoint.Address')),
      ...cfnExport('ReaderEndpoint', 'The reader endpoint host', cfnGetAtt('Cluster', 'ReadEndpoint.Address')),
      ...cfnExport('Port', 'The PostgreSQL port', cfnGetAtt('Cluster', 'Endpoint.Port')),
      ...cfnExport('DatabaseName', 'The database name', cfnRef('DatabaseName')),
      ...cfnExport('DatabaseKeyArn', 'The KMS key of the cluster', keyArn),
      ...cfnExport('DatabaseClientSecurityGroupId', 'Attach to processes that reach the database', cfnGetAtt('DatabaseClientSecurityGroup', 'GroupId')),
      ...cfnExport('MasterUserSecretArn', 'The Secrets Manager secret holding the master password', cfnGetAtt('Cluster', 'MasterUserSecret.SecretArn')),
    },
  });
}
