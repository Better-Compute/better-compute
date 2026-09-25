import { getStack } from '@/lib/stack';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** better-iam's own handler: CSRF checks, cookies, authorization and audit records. */
async function handle(request: Request): Promise<Response> {
  return (await getStack()).iam.handler(request);
}

export {
  handle as GET,
  handle as POST,
  handle as PUT,
  handle as PATCH,
  handle as DELETE,
  handle as OPTIONS,
};
