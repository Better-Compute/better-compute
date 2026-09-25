// Creates the IAM + compute stack when the server starts, so migrations, the root bootstrap and compute's jobs
// run at boot rather than inside the first request's render. (The `NEXT_RUNTIME` test must wrap the import for
// the edge build to drop it.)

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { getStack } = await import('./lib/stack-core');
    try {
      await getStack();
    } catch (error) {
      // The first request retries and reports it.
      console.error('[console] Starting the stack failed:', error);
    }
  }
}
