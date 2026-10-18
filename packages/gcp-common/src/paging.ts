import type { GoogleClient, GoogleRequest } from './http.js';

// Page-token paging for Google list endpoints (`pageSize` / `pageToken` / `nextPageToken`).

export type PaginateRequest = Omit<GoogleRequest, 'method' | 'body'> & {
  /** The response property that holds one page's items (`instances`, `items`, ...). */
  field: string;
  pageSize?: number;
};

/**
 * Yields every item of a list endpoint, one GET per page, following `nextPageToken`. A page
 * without the field yields nothing, and an empty page that carries a token still continues. The
 * signal is checked before each request, so an abort stops paging after the current page and
 * rejects with the abort reason.
 */
export async function* paginate<T>(
  client: GoogleClient,
  request: PaginateRequest,
): AsyncGenerator<T, void, undefined> {
  const { field, pageSize, ...rest } = request;
  let pageToken: string | undefined;
  do {
    request.signal.throwIfAborted();
    const page = await client.request<Record<string, unknown>>({
      ...rest,
      method: 'GET',
      query: {
        ...rest.query,
        ...(pageSize !== undefined ? { pageSize: String(pageSize) } : {}),
        ...(pageToken !== undefined ? { pageToken } : {}),
      },
    });
    const items = page[field];
    if (Array.isArray(items)) yield* items as T[];
    const next = page.nextPageToken;
    pageToken = typeof next === 'string' && next !== '' ? next : undefined;
  } while (pageToken !== undefined);
}
