import type { CfnTemplate } from './cfn.js';
import { controlPlaneTemplate } from './control-plane.js';
import { dataTemplate } from './data.js';
import { networkTemplate } from './network.js';
import type { AwsDeploymentOptions } from './options.js';

export type DeploymentStack = 'network' | 'data' | 'control-plane';

export interface RenderedTemplate {
  stack: DeploymentStack;
  /** The file name `aws deploy-templates` writes. */
  file: string;
  template: CfnTemplate;
}

/** The three stacks of a deployment on AWS, in the order they deploy (each imports the earlier ones). */
export function deploymentTemplates(options: AwsDeploymentOptions = {}): RenderedTemplate[] {
  return [
    { stack: 'network', file: 'network.json', template: networkTemplate(options) },
    { stack: 'data', file: 'data.json', template: dataTemplate(options) },
    { stack: 'control-plane', file: 'control-plane.json', template: controlPlaneTemplate(options) },
  ];
}
