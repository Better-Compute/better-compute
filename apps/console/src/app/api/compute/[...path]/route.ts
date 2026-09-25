import { getStack } from '@/lib/stack';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The compute API on the same origin: `acceptIamCookie` lets the browser's IAM session authenticate calls that
 * carry `X-Better-Compute: 1` from this origin (the client sends it); the envelope decides every call with IAM.
 */
async function handle(request: Request): Promise<Response> {
  return (await getStack()).compute.handler(request);
}

export { handle as GET, handle as POST };
