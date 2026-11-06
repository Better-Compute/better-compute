import { ComputeError } from '@better-compute/core';
import { parseXml } from '@better-compute/aws-core';
import { mapAwsError } from './transport.js';

/**
 * Settles an accepted 404 from GetObject, HeadObject or DeleteObject: returns when the object is
 * missing (NoSuchKey, or HEAD's empty body) and throws otherwise. NoSuchBucket (a mistyped or
 * deleted bucket) is INVALID_CONFIG, never "missing", so a get does not return undefined and a
 * delete does not report success for a bucket that is not there (used by the S3 stores).
 */
export async function settleMissing(response: Response, operation: string): Promise<void> {
  const body = await response.text().catch(() => '');
  let code: string | undefined;
  let message: string | undefined;
  if (body.trim() !== '') {
    try {
      const root = parseXml(body);
      code = root.textOf('Code') ?? undefined;
      message = root.textOf('Message') ?? undefined;
    } catch {
      code = undefined;
    }
  }
  if (code === 'NoSuchKey' || (body.trim() === '' && operation === 'HeadObject')) return;
  const error = mapAwsError({
    status: response.status,
    code,
    message,
    requestId: response.headers.get('x-amz-request-id') ?? undefined,
    service: 's3',
    operation,
  });
  if (code === 'NoSuchBucket')
    throw new ComputeError('INVALID_CONFIG', `S3 ${operation}: the configured bucket does not exist`, undefined, error.details);
  throw error;
}
