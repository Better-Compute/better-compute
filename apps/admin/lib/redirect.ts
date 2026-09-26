// Where to go after sign-in (`/signin?next=…`): only a path on this admin. URL parsers drop tabs and newlines
// and treat `\` like `/`, so `/%09/evil.example` or `/\evil.example` would become `//evil.example` (another
// site) once parsed; anything with control characters, spaces or backslashes is refused before parsing, and
// the result must resolve to this origin.

const BASE = 'http://admin.invalid';

/** A same-origin path (pathname + search + hash) for `next`, or '/' when it isn't one. */
export function safeNext(next: unknown, origin: string = BASE): string {
  if (typeof next !== 'string' || next.length > 2048) return '/';
  // eslint-disable-next-line no-control-regex
  if (!next.startsWith('/') || next.startsWith('//') || /[\u0000- \u007f\\]/.test(next)) return '/';
  try {
    const url = new URL(next, origin);
    if (url.origin !== new URL(origin).origin) return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
}
