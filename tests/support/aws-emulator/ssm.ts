import type { AwsEmulator } from './index.js';
import { jsonError, requestId } from './xml.js';

// SSM Parameter Store as EC2 images use it: GetParameters (JSON 1.1, target AmazonSSM) over the
// public `/aws/service/` AMI parameters, which all resolve to `publicAmi` unless `parameters`
// overrides them, and private parameters a test adds to `parameters`. A `name:<version>` selector
// reads the same value. Names that do not exist come back in InvalidParameters, as on AWS.

/** The AMI every public `/aws/service/` parameter resolves to by default. */
export const publicAmi = 'ami-0fedcba9876543210';

export class SsmEmulator {
  /** Parameter name → value (an AMI id for image parameters). */
  readonly parameters = new Map<string, string>();

  constructor(emu: AwsEmulator) {
    emu.register(/^ssm\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/, {
      service: 'ssm',
      protocol: 'json',
      handle: (request) => {
        if (request.operation !== 'GetParameters')
          return jsonError('InvalidAction', `The action ${request.operation} is not valid`);
        let body: { Names?: unknown };
        try {
          body = JSON.parse(request.body) as { Names?: unknown };
        } catch {
          return jsonError('SerializationException', 'unreadable request');
        }
        const names = body.Names;
        if (
          !Array.isArray(names) ||
          names.length < 1 ||
          names.length > 10 ||
          !names.every((n) => typeof n === 'string')
        )
          return jsonError('ValidationException', 'Names has 1 to 10 parameter names');
        const parameters: Record<string, unknown>[] = [];
        const invalid: string[] = [];
        for (const requested of names as string[]) {
          const [name, version] = requested.split(':');
          const value = this.value(name!);
          if (value === undefined) invalid.push(requested);
          else
            parameters.push({
              Name: name,
              ...(version !== undefined ? { Selector: `:${version}` } : {}),
              Type: 'String',
              Value: value,
              Version: version !== undefined ? Number(version) : 1,
              DataType: 'aws:ec2:image',
            });
        }
        return new Response(
          JSON.stringify({ Parameters: parameters, InvalidParameters: invalid }),
          {
            status: 200,
            headers: {
              'content-type': 'application/x-amz-json-1.1',
              'x-amzn-requestid': requestId(),
            },
          },
        );
      },
    });
  }

  /** The value of `name` (a `:<version>` selector is ignored); undefined when it does not exist. */
  value(name: string): string | undefined {
    const bare = name.split(':')[0]!;
    if (this.parameters.has(bare)) return this.parameters.get(bare);
    if (bare.startsWith('/aws/service/')) return publicAmi;
    return undefined;
  }
}
