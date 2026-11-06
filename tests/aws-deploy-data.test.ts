import { describe, expect, it } from 'vitest';
import { dataTemplate, lintTemplate, type CfnTemplate } from '@better-compute/aws';

// A12 `data` stack: Aurora PostgreSQL >= 16 Serverless v2 with IAM database authentication,
// btree_gist allowed, TLS forced, a KMS-encrypted cluster and a Secrets Manager-managed master
// password, reachable only from the client security group it exports.

const ofType = (template: CfnTemplate, type: string) =>
  Object.entries(template.Resources).filter(([, resource]) => resource.Type === type);

describe('data template', () => {
  it('lints clean with any reader count', () => {
    for (const readers of [0, 1, 2] as const) expect(lintTemplate(dataTemplate({ readers }))).toEqual([]);
  });

  it('runs Aurora PostgreSQL Serverless v2 with IAM auth, KMS storage encryption and deletion protection', () => {
    const template = dataTemplate();
    const cluster = template.Resources.Cluster!;
    expect(cluster.DeletionPolicy).toBe('Snapshot');
    expect(cluster.UpdateReplacePolicy).toBe('Snapshot');
    expect(cluster.Properties).toMatchObject({
      Engine: 'aurora-postgresql',
      EnableIAMDatabaseAuthentication: true,
      StorageEncrypted: true,
      KmsKeyId: { 'Fn::GetAtt': ['DatabaseKey', 'Arn'] },
      DeletionProtection: true,
      ServerlessV2ScalingConfiguration: { MinCapacity: { Ref: 'MinCapacity' }, MaxCapacity: { Ref: 'MaxCapacity' } },
      EnableCloudwatchLogsExports: ['postgresql'],
    });
    expect(template.Resources.DatabaseKey!.Properties!.EnableKeyRotation).toBe(true);
    for (const [, instance] of ofType(template, 'AWS::RDS::DBInstance'))
      expect(instance.Properties).toMatchObject({ DBInstanceClass: 'db.serverless', PubliclyAccessible: false });
  });

  it('accepts PostgreSQL 16 or later only', () => {
    const pattern = new RegExp(dataTemplate().Parameters!.EngineVersion!.AllowedPattern!);
    for (const ok of ['16.4', '16.6', '17.2', '18.0']) expect(pattern.test(ok), ok).toBe(true);
    for (const bad of ['15.4', '14.9', '9.6', '16', 'latest']) expect(pattern.test(bad), bad).toBe(false);
  });

  it('allows btree_gist and forces TLS in a parameter group of the engine major version', () => {
    const group = dataTemplate().Resources.ClusterParameters!.Properties!;
    expect(group.Parameters).toMatchObject({ 'rds.force_ssl': '1', 'rds.allowed_extensions': 'btree_gist' });
    expect(group.Family).toEqual({
      'Fn::Join': ['', ['aurora-postgresql', { 'Fn::Select': ['0', { 'Fn::Split': ['.', { Ref: 'EngineVersion' }] }] }]],
    });
  });

  it('keeps the master password in Secrets Manager under the database key, never in a parameter', () => {
    const template = dataTemplate();
    const cluster = template.Resources.Cluster!.Properties!;
    expect(cluster.ManageMasterUserPassword).toBe(true);
    expect(cluster.MasterUserSecret).toEqual({ KmsKeyId: { 'Fn::GetAtt': ['DatabaseKey', 'Arn'] } });
    expect(cluster).not.toHaveProperty('MasterUserPassword');
    for (const parameter of Object.keys(template.Parameters!)) expect(parameter).not.toMatch(/password|secret/i);
  });

  it('admits only the exported client security group on 5432 and lets the database dial nothing', () => {
    const template = dataTemplate();
    const group = template.Resources.DatabaseSecurityGroup!.Properties!;
    expect(group.SecurityGroupIngress).toEqual([
      {
        IpProtocol: 'tcp',
        FromPort: 5432,
        ToPort: 5432,
        SourceSecurityGroupId: { 'Fn::GetAtt': ['DatabaseClientSecurityGroup', 'GroupId'] },
        Description: expect.any(String),
      },
    ]);
    expect(group.SecurityGroupEgress).toEqual([{ IpProtocol: '-1', CidrIp: '127.0.0.1/32', Description: expect.any(String) }]);
    expect(template.Outputs!.DatabaseClientSecurityGroupId!.Export).toBeDefined();
  });

  it('places the cluster in the network stack private subnets', () => {
    const template = dataTemplate();
    expect(template.Resources.SubnetGroup!.Properties!.SubnetIds).toEqual({
      'Fn::Split': [',', { 'Fn::ImportValue': { 'Fn::Sub': '${NetworkStack}-PrivateSubnetIds' } }],
    });
    expect(template.Resources.DatabaseClientSecurityGroup!.Properties!.VpcId).toEqual({
      'Fn::ImportValue': { 'Fn::Sub': '${NetworkStack}-VpcId' },
    });
  });

  it('keeps the RDS Data API off unless the DataApi parameter turns it on (for the one-time bootstrap)', () => {
    const template = dataTemplate();
    expect(template.Parameters!.DataApi).toMatchObject({ Default: 'Disabled', AllowedValues: ['Disabled', 'Enabled'] });
    expect(template.Resources.Cluster!.Properties!.EnableHttpEndpoint).toEqual({ 'Fn::If': ['DataApiEnabled', true, false] });
    expect(template.Conditions!.DataApiEnabled).toEqual({ 'Fn::Equals': [{ Ref: 'DataApi' }, 'Enabled'] });
  });

  it('runs a writer plus the configured readers', () => {
    expect(ofType(dataTemplate(), 'AWS::RDS::DBInstance')).toHaveLength(2);
    expect(ofType(dataTemplate({ readers: 0 }), 'AWS::RDS::DBInstance')).toHaveLength(1);
    expect(ofType(dataTemplate({ readers: 2 }), 'AWS::RDS::DBInstance')).toHaveLength(3);
  });

  it('exports what the control plane needs for rds-db:connect and its pool', () => {
    const outputs = dataTemplate().Outputs!;
    for (const name of ['ClusterEndpoint', 'ReaderEndpoint', 'Port', 'DatabaseName', 'ClusterResourceId', 'ClusterIdentifier', 'ClusterArn', 'DatabaseClientSecurityGroupId', 'MasterUserSecretArn'])
      expect(outputs[name]!.Export!.Name, name).toEqual({ 'Fn::Sub': `\${AWS::StackName}-${name}` });
    expect(outputs.ClusterResourceId!.Value).toEqual({ 'Fn::GetAtt': ['Cluster', 'DBClusterResourceId'] });
  });
});
