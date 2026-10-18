// Small readers for Google's JSON error bodies, shared by the REST client and the token helpers.

export type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The first `google.rpc.<type>` entry of an error's `details`. */
export function detail(details: unknown, type: 'ErrorInfo' | 'RetryInfo'): Json | undefined {
  if (!Array.isArray(details)) return undefined;
  return details.find(
    (entry): entry is Json =>
      isRecord(entry) && typeof entry['@type'] === 'string' && entry['@type'].endsWith(`.${type}`),
  );
}
