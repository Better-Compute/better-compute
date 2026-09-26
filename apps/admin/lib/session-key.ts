// The browser half of the operator session (see lib/session.ts): a random key in this origin's localStorage,
// sent as x-bc-session-key with every call to /api/session and /api/upstream. localStorage is per
// scheme+host+port, so another local server that receives the cookie (cookies ignore ports) can't read it.
// A fresh key is made at each sign-in, which also retires any session bound to the old one.

export const SESSION_KEY_HEADER = 'x-bc-session-key';
const STORAGE_KEY = 'bc-admin:session-key';
const VALID = /^[A-Za-z0-9_-]{32,128}$/;
let memory: string | null = null;

function fresh(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function store(value: string): string {
  memory = value;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // storage blocked: the session lasts as long as this page
  }
  return value;
}

/** This browser's session key (made on first use). */
export function sessionKey(): string {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved && VALID.test(saved)) return saved;
  } catch {
    if (memory) return memory;
  }
  return store(fresh());
}

/** A new key, for a new sign-in. */
export const rotateSessionKey = (): string => store(fresh());

/** Headers every call to the admin's own API carries. */
export const adminHeaders = (): Record<string, string> => ({ 'x-better-compute': '1', [SESSION_KEY_HEADER]: sessionKey() });
