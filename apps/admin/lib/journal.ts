// The change journal: every change this browser sent through the admin (any method that isn't a read), with
// its outcome, kept in localStorage (last 100). It answers "what did I just do?" from the operator menu and ⌘K;
// the compute API's own audit log stays the record. Only ids, names and reasons from the input are kept, never
// anything that looks like a secret.

import { isReadMethod } from './methods';

export interface JournalEntry {
  id: string;
  /** Wall-clock ms (not the workspace clock: changes happen now). */
  at: number;
  method: string;
  ok: boolean;
  /** The API's error code when it failed. */
  code?: string;
  message?: string;
  /** Identifying input fields: { nodeId: 'n-1', reason: '…' }. */
  fields: Record<string, string>;
}

const KEY = 'bc-admin:journal';
const EVENT = 'bc-admin:journal-changed';
const MAX = 100;
const SECRET = /token|secret|password|passwd|key|credential|cert|private/i;
const IDENTIFYING = /(^id$|Id$|Ids$|^name$|Name$|^reason$|^tenant$|^pool$|^site$)/;

/** The input fields worth remembering about a change: ids, names, a reason. Never secrets; short values only. */
export function journalFields(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [field, value] of Object.entries(input as Record<string, unknown>)) {
    if (SECRET.test(field) || !IDENTIFYING.test(field)) continue;
    const text =
      typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : Array.isArray(value) && value.every((v) => typeof v === 'string' || typeof v === 'number')
          ? value.length > 5
            ? `${value.slice(0, 5).join(', ')} +${value.length - 5}`
            : value.join(', ')
          : null;
    if (text !== null && text.length > 0) out[field] = text.length > 120 ? `${text.slice(0, 119)}…` : text;
    if (Object.keys(out).length >= 6) break;
  }
  return out;
}

let cache: JournalEntry[] | null = null;

function isEntry(value: unknown): value is JournalEntry {
  const e = value as JournalEntry;
  return Boolean(e) && typeof e.id === 'string' && typeof e.at === 'number' && typeof e.method === 'string' && typeof e.ok === 'boolean' && typeof e.fields === 'object' && e.fields !== null;
}

export function readJournal(): JournalEntry[] {
  if (cache) return cache;
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) ?? '[]') as unknown;
    cache = Array.isArray(parsed) ? parsed.filter(isEntry).slice(0, MAX) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(entries: JournalEntry[]) {
  cache = entries.slice(0, MAX);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // kept for this page only
  }
  window.dispatchEvent(new Event(EVENT));
}

/** Record a call's outcome if it was a change (reads are not journaled). */
export function journalCall(method: string, input: unknown, outcome: { ok: true } | { ok: false; code: string; message: string }, at = Date.now()) {
  if (typeof window === 'undefined' || isReadMethod(method)) return;
  // A refusal before anything happened (signed out) is not a change: the toast already said so.
  if (!outcome.ok && outcome.code === 'READ_ONLY') return;
  const entry: JournalEntry = {
    id: `${at.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    at,
    method,
    ok: outcome.ok,
    ...(outcome.ok ? {} : { code: outcome.code, message: outcome.message.slice(0, 240) }),
    fields: journalFields(input),
  };
  write([entry, ...readJournal()]);
}

export const clearJournal = () => write([]);

/** For useSyncExternalStore. */
export const journalStore = {
  subscribe(callback: () => void) {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== KEY) return;
      cache = null;
      callback();
    };
    window.addEventListener(EVENT, callback);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(EVENT, callback);
      window.removeEventListener('storage', onStorage);
    };
  },
  snapshot: readJournal,
  serverSnapshot: (): JournalEntry[] => EMPTY,
};
const EMPTY: JournalEntry[] = [];
