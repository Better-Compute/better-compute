// A small CloudFormation model for the deployment templates (A12, AQ7): JSON rendered from
// TypeScript, so no YAML dependency and every template is unit-testable. `lintTemplate` is the
// static check each rendered template passes before it is written or handed to CloudFormation.
import { ComputeError } from '@better-compute/core';

export type CfnParameterType =
  | 'String'
  | 'Number'
  | 'CommaDelimitedList'
  | 'AWS::EC2::VPC::Id'
  | 'List<AWS::EC2::Subnet::Id>'
  | 'AWS::Route53::HostedZone::Id';

export interface CfnParameter {
  Type: CfnParameterType;
  Description: string;
  Default?: string | number;
  AllowedValues?: readonly (string | number)[];
  AllowedPattern?: string;
  ConstraintDescription?: string;
  MinValue?: number;
  MaxValue?: number;
  MinLength?: number;
  MaxLength?: number;
  /** Refused by `lintTemplate`: the templates take no secrets as parameters. */
  NoEcho?: boolean;
}

export interface CfnResource {
  Type: string;
  Properties?: Record<string, unknown>;
  DependsOn?: string | readonly string[];
  Condition?: string;
  DeletionPolicy?: 'Delete' | 'Retain' | 'RetainExceptOnCreate' | 'Snapshot';
  UpdateReplacePolicy?: 'Delete' | 'Retain' | 'Snapshot';
  Metadata?: Record<string, unknown>;
}

export interface CfnOutput {
  Description: string;
  Value: unknown;
  Export?: { Name: unknown };
  Condition?: string;
}

export interface CfnTemplate {
  AWSTemplateFormatVersion: '2010-09-09';
  Description: string;
  Metadata?: Record<string, unknown>;
  Parameters?: Record<string, CfnParameter>;
  Conditions?: Record<string, unknown>;
  Resources: Record<string, CfnResource>;
  Outputs?: Record<string, CfnOutput>;
}

export const cfnRef = (name: string) => ({ Ref: name });
export const cfnGetAtt = (resource: string, attribute: string) => ({ 'Fn::GetAtt': [resource, attribute] });
export function cfnSub(text: string, variables?: Readonly<Record<string, unknown>>) {
  return variables ? { 'Fn::Sub': [text, variables] } : { 'Fn::Sub': text };
}
export const cfnJoin = (separator: string, values: unknown) => ({ 'Fn::Join': [separator, values] });
export const cfnSelect = (index: number, list: unknown) => ({ 'Fn::Select': [String(index), list] });
export const cfnSplit = (separator: string, text: unknown) => ({ 'Fn::Split': [separator, text] });
export const cfnIf = (condition: string, whenTrue: unknown, whenFalse: unknown) => ({ 'Fn::If': [condition, whenTrue, whenFalse] });
export const cfnEquals = (a: unknown, b: unknown) => ({ 'Fn::Equals': [a, b] });
export const cfnNoValue = { Ref: 'AWS::NoValue' };
/** The `index`th availability zone of the stack's region. */
export const cfnAz = (index: number) => cfnSelect(index, { 'Fn::GetAZs': '' });
/** A value exported by another stack of the deployment: `${<stackParameter>}-<name>`. */
export function cfnImport(name: string, stackParameter = 'NetworkStack') {
  return { 'Fn::ImportValue': { 'Fn::Sub': `\${${stackParameter}}-${name}` } };
}
/** An output exported as `${AWS::StackName}-<name>`, the shape `cfnImport` reads. */
export function cfnExport(name: string, description: string, value: unknown): Record<string, CfnOutput> {
  return { [name]: { Description: description, Value: value, Export: { Name: cfnSub(`\${AWS::StackName}-${name}`) } } };
}

const namePattern = /^[a-z](?:[a-z0-9-]{0,26}[a-z0-9])?$/;

/** A deployment name: 2–28 characters, lower-case letters, digits and inner dashes, starting with a letter. */
export function checkDeploymentName(name: string): string {
  if (typeof name !== 'string' || name.length < 2 || !namePattern.test(name))
    throw new ComputeError(
      'INVALID_INPUT',
      'the deployment name must be 2-28 characters of a-z, 0-9 and inner dashes, starting with a letter',
    );
  return name;
}

/** `Name` and `better-compute:deployment` tags for one resource. */
export function deploymentTags(name: string, part?: string): { Key: string; Value: unknown }[] {
  return [
    { Key: 'Name', Value: part ? `${name}-${part}` : name },
    { Key: 'better-compute:deployment', Value: name },
  ];
}

const pseudoParameters = new Set([
  'AWS::AccountId',
  'AWS::NotificationARNs',
  'AWS::NoValue',
  'AWS::Partition',
  'AWS::Region',
  'AWS::StackId',
  'AWS::StackName',
  'AWS::URLSuffix',
]);

const logicalId = /^[A-Za-z0-9]{1,255}$/;

/** The limits CloudFormation enforces on a template (S3-hosted body). */
export const cfnLimits = {
  resources: 500,
  parameters: 200,
  outputs: 200,
  descriptionBytes: 1024,
  templateBytes: 1_000_000,
  /** A `--template-body` passed inline; larger templates go through an S3 bucket. */
  inlineTemplateBytes: 51_200,
} as const;

/**
 * Static problems in a template: references (Ref, GetAtt, Sub, DependsOn, conditions) that name
 * nothing, references to a conditional resource from where its condition may not hold, bad logical
 * ids, duplicate export names, NoEcho parameters and CloudFormation limits. An empty list means it
 * passes.
 */
export function lintTemplate(template: CfnTemplate): string[] {
  const problems: string[] = [];
  const parameters = Object.keys(template.Parameters ?? {});
  const resources = Object.keys(template.Resources);
  const conditions = new Set(Object.keys(template.Conditions ?? {}));
  const names = new Set([...parameters, ...resources]);
  const where = (path: string) => (path ? ` (at ${path})` : '');
  // A conditional resource may be named only where its condition is known to hold: under the same
  // condition, in the true branch of an Fn::If on it, or in the false branch of one on its complement.
  const resourceCondition = new Map(
    Object.entries(template.Resources).flatMap(([id, resource]) => (resource.Condition === undefined ? [] : [[id, resource.Condition] as const])),
  );
  const complements = new Map<string, string[]>();
  const conditionBodies = Object.entries(template.Conditions ?? {}).map(([id, body]) => [id, JSON.stringify(body)] as const);
  for (const [a, body] of conditionBodies)
    for (const [b, other] of conditionBodies)
      if (body === `{"Fn::Not":[${other}]}` || other === `{"Fn::Not":[${body}]}` || body === JSON.stringify({ 'Fn::Not': [{ Condition: b }] }))
        complements.set(a, [...(complements.get(a) ?? []), b]);
  const checkHeld = (target: string, held: ReadonlySet<string>, path: string) => {
    const condition = resourceCondition.get(target);
    if (condition !== undefined && !held.has(condition))
      problems.push(`${target} exists only when ${condition}, which may not hold here${where(path)}`);
  };

  if (Buffer.byteLength(template.Description, 'utf8') > cfnLimits.descriptionBytes)
    problems.push(`Description is over ${cfnLimits.descriptionBytes} bytes`);
  if (resources.length > cfnLimits.resources) problems.push(`${resources.length} resources (limit ${cfnLimits.resources})`);
  if (parameters.length > cfnLimits.parameters) problems.push(`${parameters.length} parameters (limit ${cfnLimits.parameters})`);
  const outputs = Object.keys(template.Outputs ?? {});
  if (outputs.length > cfnLimits.outputs) problems.push(`${outputs.length} outputs (limit ${cfnLimits.outputs})`);
  const size = Buffer.byteLength(JSON.stringify(template), 'utf8');
  if (size > cfnLimits.templateBytes) problems.push(`template is ${size} bytes (limit ${cfnLimits.templateBytes})`);

  for (const id of [...parameters, ...resources, ...outputs, ...conditions])
    if (!logicalId.test(id)) problems.push(`logical id ${id} is not alphanumeric`);
  for (const [id, parameter] of Object.entries(template.Parameters ?? {}))
    if (parameter.NoEcho) problems.push(`parameter ${id} is NoEcho: secrets are generated in AWS, never parameters`);

  /** The conditions known to hold at a point: the enclosing resource's or output's, and the Fn::If branches above it. */
  const visit = (value: unknown, path: string, held: ReadonlySet<string>): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`, held));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1) {
      const [key] = keys as [string];
      const argument = record[key];
      if (key === 'Ref') {
        if (typeof argument !== 'string' || !(names.has(argument) || pseudoParameters.has(argument)))
          problems.push(`Ref ${String(argument)} names no parameter or resource${where(path)}`);
        else checkHeld(argument, held, path);
        return;
      }
      if (key === 'Fn::GetAtt') {
        const target = Array.isArray(argument) ? argument[0] : typeof argument === 'string' ? argument.split('.')[0] : undefined;
        if (typeof target !== 'string' || !resources.includes(target))
          problems.push(`GetAtt ${String(target)} names no resource${where(path)}`);
        else checkHeld(target, held, path);
        return;
      }
      if (key === 'Fn::Sub') {
        const [text, map] = Array.isArray(argument) ? (argument as [unknown, unknown]) : [argument, undefined];
        const local = new Set(map && typeof map === 'object' ? Object.keys(map as object) : []);
        if (typeof text === 'string') checkSub(text, path, local, held);
        if (map) visit(map, `${path}.Fn::Sub`, held);
        return;
      }
      if (key === 'Fn::If' && Array.isArray(argument)) {
        if (typeof argument[0] !== 'string' || !conditions.has(argument[0]))
          problems.push(`Fn::If condition ${String(argument[0])} is not defined${where(path)}`);
        const condition = String(argument[0]);
        visit(argument[1], `${path}.Fn::If[1]`, new Set([...held, condition]));
        visit(argument[2], `${path}.Fn::If[2]`, new Set([...held, ...(complements.get(condition) ?? [])]));
        return;
      }
      if (key === 'Condition' && typeof argument === 'string' && path.startsWith('Conditions')) {
        if (!conditions.has(argument)) problems.push(`condition ${argument} is not defined${where(path)}`);
        return;
      }
    }
    for (const [key, item] of Object.entries(record)) visit(item, path ? `${path}.${key}` : key, held);
  };
  const checkSub = (text: string, path: string, local: ReadonlySet<string>, held: ReadonlySet<string>) => {
    for (const match of text.matchAll(/\$\{([^}]*)\}/g)) {
      const variable = match[1]!;
      if (variable.startsWith('!')) continue;
      const head = variable.includes('::') ? variable : variable.split('.')[0]!;
      if (local.has(variable) || local.has(head) || pseudoParameters.has(head)) continue;
      if (names.has(head)) {
        checkHeld(head, held, path);
        continue;
      }
      problems.push(`Sub variable ${variable} names no parameter or resource${where(path)}`);
    }
  };

  for (const [id, resource] of Object.entries(template.Resources)) {
    const dependsOn = resource.DependsOn === undefined ? [] : typeof resource.DependsOn === 'string' ? [resource.DependsOn] : resource.DependsOn;
    const own = new Set(resource.Condition === undefined ? [] : [resource.Condition]);
    for (const target of dependsOn)
      if (!resources.includes(target)) problems.push(`DependsOn ${target} names no resource (at Resources.${id})`);
      else if (resourceCondition.has(target) && !own.has(resourceCondition.get(target)!))
        problems.push(`DependsOn ${target}: it exists only when ${resourceCondition.get(target)} (at Resources.${id})`);
    if (resource.Condition !== undefined && !conditions.has(resource.Condition))
      problems.push(`condition ${resource.Condition} is not defined (at Resources.${id})`);
    if (typeof resource.Type !== 'string' || !/^(AWS|Custom)::/.test(resource.Type))
      problems.push(`resource ${id} has no AWS type`);
    visit(resource.Properties, `Resources.${id}.Properties`, own);
  }
  for (const [id, output] of Object.entries(template.Outputs ?? {})) {
    if (output.Condition !== undefined && !conditions.has(output.Condition))
      problems.push(`condition ${output.Condition} is not defined (at Outputs.${id})`);
    const own = new Set(output.Condition === undefined ? [] : [output.Condition]);
    visit(output.Value, `Outputs.${id}.Value`, own);
    if (output.Export) visit(output.Export.Name, `Outputs.${id}.Export`, own);
  }
  visit(template.Conditions, 'Conditions', new Set());

  const exports = new Map<string, string>();
  for (const [id, output] of Object.entries(template.Outputs ?? {})) {
    if (!output.Export) continue;
    const key = JSON.stringify(output.Export.Name);
    const label = typeof output.Export.Name === 'string' ? output.Export.Name : key;
    if (exports.has(key)) problems.push(`export ${label} is declared by ${exports.get(key)} and ${id}`);
    else exports.set(key, id);
  }
  return problems;
}

/** Throws INTERNAL_ERROR with the lint problems; the renderers call it on what they return. */
export function assertTemplate(name: string, template: CfnTemplate): CfnTemplate {
  const problems = lintTemplate(template);
  if (problems.length > 0)
    throw new ComputeError('INTERNAL_ERROR', `the ${name} template does not lint: ${problems.slice(0, 5).join('; ')}`);
  return template;
}
