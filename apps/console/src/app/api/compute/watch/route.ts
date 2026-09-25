import { ComputeError, resourceType, type SqlExecutor } from 'better-compute/core';
import { handleWatch } from 'better-compute/events';
import { getStack } from '@/lib/stack';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/compute/watch` (PLAN.md §9.3): the signed-in tenant's events as Server-Sent Events, which keep the
 * console's stores current. The IAM session cookie authenticates it (console-kit reads the stream with fetch, so it
 * sends `X-Better-Compute: 1` like every other call), and IAM decides `compute:events:read` on the tenant.
 * `?tenantId=` lets a platform administrator follow another organization.
 */
export async function GET(request: Request): Promise<Response> {
  const { compute, origin } = await getStack();
  return handleWatch(request, {
    sql: compute.context.sql as SqlExecutor,
    authorize: async (watch) => {
      // Browsers omit Origin on same-origin GETs, so the custom header is the CSRF guard (a cross-origin request
      // carrying it needs a preflight nothing here approves); Sec-Fetch-Site and Origin are checked when sent.
      if (watch.headers.get('x-better-compute') !== '1')
        throw new ComputeError('CSRF_REJECTED', 'Send X-Better-Compute: 1');
      const site = watch.headers.get('sec-fetch-site');
      const from = watch.headers.get('origin');
      if ((site && site !== 'same-origin') || (from && from !== origin))
        throw new ComputeError('UNTRUSTED_ORIGIN', 'Origin is not trusted');
      const credential = { headers: watch.headers };
      const caller = await compute.context.iam.authenticate(credential);
      const tenantId = new URL(watch.url).searchParams.get('tenantId') ?? caller.tenantId;
      await compute.context.iam.require(credential, {
        tenantId,
        action: 'compute:events:read',
        resource: { type: resourceType('tenant'), id: tenantId },
      });
      return { tenantId };
    },
  });
}
