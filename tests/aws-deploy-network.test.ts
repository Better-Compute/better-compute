import { describe, expect, it } from 'vitest';
import { lintTemplate, networkTemplate, type CfnTemplate } from '@better-compute/aws';

// A12 `network` stack: a VPC across the zones with public and private subnets, NAT, the S3
// gateway endpoint and the interface endpoints the control plane calls, flow logs, and the
// exports the data and control-plane stacks import.

const ofType = (template: CfnTemplate, type: string) =>
  Object.entries(template.Resources).filter(([, resource]) => resource.Type === type);

describe('network template', () => {
  it('lints clean in every shape', () => {
    for (const zones of [2, 3] as const)
      for (const natGateways of ['per-zone', 'single'] as const)
        expect(lintTemplate(networkTemplate({ zones, natGateways }))).toEqual([]);
  });

  it('spans three zones with a public and a private subnet in each', () => {
    const template = networkTemplate();
    const subnets = ofType(template, 'AWS::EC2::Subnet');
    expect(subnets).toHaveLength(6);
    const zones = subnets.map(([, subnet]) => JSON.stringify(subnet.Properties!.AvailabilityZone));
    expect(new Set(zones).size).toBe(3);
    // Nothing gets a public address by itself: the ALB, NLB and NAT gateways own the public side.
    for (const [, subnet] of subnets) expect(subnet.Properties!.MapPublicIpOnLaunch).toBe(false);
    expect(ofType(networkTemplate({ zones: 2 }), 'AWS::EC2::Subnet')).toHaveLength(4);
  });

  it('routes each private subnet through its own NAT gateway, or one shared in single mode', () => {
    expect(ofType(networkTemplate(), 'AWS::EC2::NatGateway')).toHaveLength(3);
    const single = networkTemplate({ natGateways: 'single' });
    expect(ofType(single, 'AWS::EC2::NatGateway')).toHaveLength(1);
    const routes = ofType(single, 'AWS::EC2::Route').filter(([, route]) => route.Properties!.NatGatewayId);
    expect(routes).toHaveLength(3);
    for (const [, route] of routes) expect(route.Properties!.NatGatewayId).toEqual({ Ref: 'NatGateway0' });
  });

  it('has the S3 gateway endpoint on the private route tables and the interface endpoints', () => {
    const template = networkTemplate();
    const endpoints = ofType(template, 'AWS::EC2::VPCEndpoint').map(([, endpoint]) => endpoint.Properties!);
    const services = endpoints.map((endpoint) => (endpoint.ServiceName as { 'Fn::Sub': string })['Fn::Sub']);
    expect(services.sort()).toEqual(
      ['ecr.api', 'ecr.dkr', 'kms', 'logs', 's3', 'secretsmanager', 'sts'].map((service) => `com.amazonaws.\${AWS::Region}.${service}`).sort(),
    );
    const s3 = endpoints.find((endpoint) => endpoint.VpcEndpointType === 'Gateway')!;
    expect(s3.RouteTableIds).toHaveLength(3);
    for (const endpoint of endpoints.filter((entry) => entry.VpcEndpointType === 'Interface')) {
      expect(endpoint.PrivateDnsEnabled).toBe(true);
      expect(endpoint.SecurityGroupIds).toEqual([{ Ref: 'EndpointSecurityGroup' }]);
    }
  });

  it('admits only HTTPS from inside the VPC to the interface endpoints', () => {
    const group = networkTemplate().Resources.EndpointSecurityGroup!.Properties!;
    expect(group.SecurityGroupIngress).toEqual([
      { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: { 'Fn::GetAtt': ['Vpc', 'CidrBlock'] }, Description: expect.any(String) },
    ]);
  });

  it('logs every flow to CloudWatch Logs through a role only the flow-logs service of this account assumes', () => {
    const template = networkTemplate();
    expect(template.Resources.FlowLog!.Properties).toMatchObject({ ResourceType: 'VPC', TrafficType: 'ALL', LogDestinationType: 'cloud-watch-logs' });
    const trust = template.Resources.FlowLogRole!.Properties!.AssumeRolePolicyDocument as { Statement: Record<string, unknown>[] };
    expect(trust.Statement[0]).toMatchObject({
      Principal: { Service: 'vpc-flow-logs.amazonaws.com' },
      Condition: { StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } } },
    });
  });

  it('exports what the other stacks import', () => {
    const outputs = networkTemplate().Outputs!;
    for (const name of ['VpcId', 'VpcCidr', 'PublicSubnetIds', 'PrivateSubnetIds', 'EndpointSecurityGroupId'])
      expect(outputs[name]!.Export!.Name).toEqual({ 'Fn::Sub': `\${AWS::StackName}-${name}` });
  });

  it('tags every taggable resource with the deployment name', () => {
    const template = networkTemplate({ name: 'bc-prod' });
    for (const [id, resource] of Object.entries(template.Resources)) {
      const tags = resource.Properties?.Tags as { Key: string; Value: unknown }[] | undefined;
      if (!tags) continue;
      expect(tags, id).toContainEqual({ Key: 'better-compute:deployment', Value: 'bc-prod' });
    }
  });

  it('refuses a bad deployment name or zone count', () => {
    expect(() => networkTemplate({ name: 'Bad_Name' })).toThrow(/deployment name/);
    expect(() => networkTemplate({ zones: 4 as 3 })).toThrow(/zones/);
  });
});
