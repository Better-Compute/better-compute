import { beforeAll, describe, expect, it } from 'vitest';
import { deploymentTemplates } from '@better-compute/aws';
import { createTransport, queryClient } from '../../../packages/aws/src/internal/transport.js';
import { liveGate, livePreflight } from './support/live.js';

// AWS live (A12): CloudFormation's own ValidateTemplate accepts each deployment template and sees
// the parameters the renderer declares. It creates nothing and costs nothing, but it still runs
// only behind the live gate and preflight (tests/live/aws/README.md).

const gate = liveGate();

describe.skipIf(!gate.enabled)('AWS live: deployment templates', () => {
  const config = gate.enabled ? gate.config : (undefined as never);

  beforeAll(async () => {
    await livePreflight(config);
  });

  for (const entry of deploymentTemplates({ name: 'bc-live' }))
    it(`CloudFormation validates ${entry.file}`, async () => {
      const cloudformation = queryClient(createTransport({ region: config.region, credentials: config.credentials }), {
        hostPrefix: 'cloudformation',
        version: '2010-05-15',
      });
      const result = (await cloudformation.call('ValidateTemplate', { TemplateBody: JSON.stringify(entry.template) })).child(
        'ValidateTemplateResult',
      );
      const parameters = (result?.items('Parameters') ?? []).map((parameter) => parameter.textOf('ParameterKey')).sort();
      expect(parameters).toEqual(Object.keys(entry.template.Parameters ?? {}).sort());
      // Both stacks with roles need CAPABILITY_IAM, which the runbook passes.
      if (entry.stack !== 'data') expect(result?.items('Capabilities').map((item) => item.text)).toContain('CAPABILITY_IAM');
    });
});
