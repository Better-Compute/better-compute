import { ComputeError } from '@better-compute/core';

/**
 * Follows `next` tokens until a page has none. A token seen before is a loop (`PROVIDER_ERROR`,
 * reason `pagination-loop`), and more than `maxPages` pages is too (reason `pagination-limit`).
 */
export async function* paginate<T>(
  page: (token: string | undefined) => Promise<{ items: readonly T[]; next?: string }>,
  options: { maxPages?: number } = {},
): AsyncIterable<T> {
  const maxPages = options.maxPages ?? 10_000;
  const seen = new Set<string>();
  let token: string | undefined;
  for (let count = 0; ; count++) {
    if (count >= maxPages)
      throw new ComputeError('PROVIDER_ERROR', 'AWS pagination did not end', undefined, {
        provider: 'aws',
        reason: 'pagination-limit',
      });
    const result = await page(token);
    yield* result.items;
    const next = result.next === '' ? undefined : result.next;
    if (next === undefined) return;
    if (seen.has(next))
      throw new ComputeError('PROVIDER_ERROR', 'AWS returned a pagination token twice', undefined, {
        provider: 'aws',
        reason: 'pagination-loop',
      });
    seen.add(next);
    token = next;
  }
}
