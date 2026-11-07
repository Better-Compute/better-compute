import { describe, expect, it } from 'vitest';
import {
  cfnGetAtt,
  cfnImport,
  cfnRef,
  cfnSub,
  checkDeploymentName,
  deploymentTags,
  lintTemplate,
  type CfnTemplate,
} from '@better-compute/aws';

// The CloudFormation model under the A12 deployment templates: intrinsic helpers and the lint that
// every rendered template must pass before it is written or handed to CloudFormation.

function template(partial: Partial<CfnTemplate> = {}): CfnTemplate {
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: 'test',
    Resources: { Bucket: { Type: 'AWS::S3::Bucket' } },
    ...partial,
  };
}

describe('CloudFormation helpers', () => {
  it('builds intrinsic functions', () => {
    expect(cfnRef('Vpc')).toEqual({ Ref: 'Vpc' });
    expect(cfnGetAtt('Vpc', 'CidrBlock')).toEqual({ 'Fn::GetAtt': ['Vpc', 'CidrBlock'] });
    expect(cfnSub('${AWS::StackName}-x')).toEqual({ 'Fn::Sub': '${AWS::StackName}-x' });
    expect(cfnImport('VpcId')).toEqual({ 'Fn::ImportValue': { 'Fn::Sub': '${NetworkStack}-VpcId' } });
    expect(cfnImport('ClusterEndpoint', 'DataStack')).toEqual({ 'Fn::ImportValue': { 'Fn::Sub': '${DataStack}-ClusterEndpoint' } });
  });

  it('tags every resource with the deployment', () => {
    expect(deploymentTags('bc-prod', 'api')).toEqual([
      { Key: 'Name', Value: 'bc-prod-api' },
      { Key: 'better-compute:deployment', Value: 'bc-prod' },
    ]);
  });

  it('accepts only short lower-case deployment names', () => {
    expect(checkDeploymentName('better-compute')).toBe('better-compute');
    for (const bad of ['', 'A', 'Prod', 'bc_prod', '-bc', 'bc-', 'x'.repeat(29), 'b c', '9bc'])
      expect(() => checkDeploymentName(bad), bad).toThrow(/deployment name/);
  });
});

describe('lintTemplate', () => {
  it('passes a well-formed template', () => {
    expect(
      lintTemplate(
        template({
          Parameters: { Name: { Type: 'String', Description: 'n' } },
          Resources: {
            Bucket: { Type: 'AWS::S3::Bucket', Properties: { Tags: [{ Key: 'n', Value: cfnRef('Name') }] } },
            Policy: {
              Type: 'AWS::S3::BucketPolicy',
              DependsOn: 'Bucket',
              Properties: { Bucket: cfnRef('Bucket'), Arn: cfnGetAtt('Bucket', 'Arn'), Text: cfnSub('${Bucket.Arn}/${AWS::Region}/${!Literal}') },
            },
          },
          Outputs: { BucketName: { Description: 'b', Value: cfnRef('Bucket'), Export: { Name: cfnSub('${AWS::StackName}-BucketName') } } },
        }),
      ),
    ).toEqual([]);
  });

  it('reports a Ref, GetAtt, Sub variable or DependsOn that names nothing', () => {
    const problems = lintTemplate(
      template({
        Resources: {
          Bucket: { Type: 'AWS::S3::Bucket', DependsOn: ['Ghost'], Properties: { A: cfnRef('Missing'), B: cfnGetAtt('Nope', 'Arn'), C: cfnSub('${Absent.Arn}') } },
        },
      }),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Ref Missing'),
        expect.stringContaining('GetAtt Nope'),
        expect.stringContaining('Sub variable Absent'),
        expect.stringContaining('DependsOn Ghost'),
      ]),
    );
  });

  it('resolves Sub variables given in its own map', () => {
    expect(lintTemplate(template({ Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: { A: { 'Fn::Sub': ['${X}-y', { X: 'z' }] } } } } }))).toEqual([]);
  });

  it('reports bad logical ids, duplicate exports and condition references', () => {
    const problems = lintTemplate(
      template({
        Resources: {
          'bad-id': { Type: 'AWS::S3::Bucket' },
          Other: { Type: 'AWS::S3::Bucket', Condition: 'NoSuch', Properties: { X: { 'Fn::If': ['AlsoMissing', 1, 2] } } },
        },
        Outputs: {
          A: { Description: 'a', Value: 'x', Export: { Name: 'same' } },
          B: { Description: 'b', Value: 'y', Export: { Name: 'same' } },
        },
      }),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('logical id bad-id'),
        expect.stringContaining('export same'),
        expect.stringContaining('condition NoSuch'),
        expect.stringContaining('condition AlsoMissing'),
      ]),
    );
  });

  it('reports a reference to a conditional resource outside a branch where it exists', () => {
    // A restore adopts retained resources instead of creating them: every reference to a conditional
    // resource must sit where its condition holds, or the template fails only on the path nobody tested.
    const conditions = {
      HasExisting: { 'Fn::Not': [{ 'Fn::Equals': [cfnRef('Existing'), ''] }] },
      CreateIt: { 'Fn::Equals': [cfnRef('Existing'), ''] },
    };
    const parameters = { Existing: { Type: 'String' as const, Description: 'e', Default: '' } };
    const conditional = { Type: 'AWS::S3::Bucket', Condition: 'CreateIt' };
    const ok = template({
      Parameters: parameters,
      Conditions: conditions,
      Resources: {
        Bucket: conditional,
        // The same condition on the referring resource, the resource's own branch, or the false branch of its complement.
        Same: { Type: 'AWS::S3::BucketPolicy', Condition: 'CreateIt', DependsOn: 'Bucket', Properties: { Bucket: cfnRef('Bucket') } },
        Own: { Type: 'AWS::SNS::Topic', Properties: { A: { 'Fn::If': ['CreateIt', cfnSub('${Bucket.Arn}'), cfnRef('Existing')] } } },
        Complement: { Type: 'AWS::SNS::Topic', Properties: { A: { 'Fn::If': ['HasExisting', cfnRef('Existing'), cfnGetAtt('Bucket', 'Arn')] } } },
      },
      Outputs: { Name: { Description: 'n', Value: { 'Fn::If': ['HasExisting', cfnRef('Existing'), cfnRef('Bucket')] } } },
    });
    expect(lintTemplate(ok)).toEqual([]);
    const problems = lintTemplate(
      template({
        Parameters: parameters,
        Conditions: conditions,
        Resources: {
          Bucket: conditional,
          BareRef: { Type: 'AWS::SNS::Topic', Properties: { A: cfnRef('Bucket') } },
          BareSub: { Type: 'AWS::SNS::Topic', Properties: { A: cfnSub('${Bucket.Arn}') } },
          WrongBranch: { Type: 'AWS::SNS::Topic', Properties: { A: { 'Fn::If': ['HasExisting', cfnGetAtt('Bucket', 'Arn'), cfnRef('Existing')] } } },
          Depends: { Type: 'AWS::SNS::Topic', DependsOn: 'Bucket' },
        },
        Outputs: { Name: { Description: 'n', Value: cfnRef('Bucket') } },
      }),
    );
    expect(problems).toEqual([
      expect.stringContaining('Resources.BareRef'),
      expect.stringContaining('Resources.BareSub'),
      expect.stringContaining('Resources.WrongBranch'),
      expect.stringContaining('DependsOn Bucket'),
      expect.stringContaining('Outputs.Name'),
    ]);
    for (const problem of problems) expect(problem).toContain('CreateIt');
  });

  it('refuses NoEcho parameters: secrets are generated in AWS, never passed in', () => {
    expect(
      lintTemplate(template({ Parameters: { DbPassword: { Type: 'String', Description: 'p', NoEcho: true } } })),
    ).toEqual([expect.stringContaining('NoEcho')]);
  });

  it('enforces the CloudFormation size and count limits', () => {
    const resources: CfnTemplate['Resources'] = {};
    for (let i = 0; i < 501; i++) resources[`B${i}`] = { Type: 'AWS::S3::Bucket' };
    expect(lintTemplate(template({ Resources: resources }))).toEqual([expect.stringContaining('501 resources')]);
    expect(lintTemplate(template({ Description: 'd'.repeat(1025) }))).toEqual([expect.stringContaining('Description')]);
  });
});
