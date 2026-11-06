'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { api, ApiError } from '@/lib/api';
import type { FindingRow, LeakRow, ProviderAccountRow, ProviderParts } from './attention';

// One poller for the provider module in live mode, shared by every subscriber and running only while one is
// subscribed. Accounts and leaks refresh every minute. Findings are a network read at the provider (DigitalOcean's
// security scan, on the account's own rate budget), so each account's are read at most every 10 minutes; a
// provider without findings answers UNSUPPORTED and simply has none.

const REFRESH_MS = 60_000;
const FINDINGS_MS = 10 * 60_000;
const LEAK_WINDOW_MS = 35 * 86_400_000;
const MAX_ACCOUNT_PAGES = 10;

export interface ProviderLiveState {
  tenantId?: string;
  parts?: ProviderParts;
  /** Per part (`accounts`, `leaks`, `findings:<account name>`), the last error. */
  errors: Record<string, ApiError>;
  loading: boolean;
  fetchedAt?: number;
}

let state: ProviderLiveState = { errors: {}, loading: false };
const listeners = new Set<() => void>();
let subscribers = 0;
let timer: number | undefined;
let generation = 0;
/** When each account's findings were last read, so a refresh does not read them again too soon. */
const findingsReadAt = new Map<string, number>();

function set(next: Partial<ProviderLiveState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

const asApiError = (error: unknown) => (error instanceof ApiError ? error : new ApiError('NETWORK', String(error), 0));

async function allAccounts(tenantId: string): Promise<ProviderAccountRow[]> {
  const out: ProviderAccountRow[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_ACCOUNT_PAGES; page++) {
    const result = await api.$request<{ items: ProviderAccountRow[]; cursor?: string }>('providerAccounts/list', {
      tenantId,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    out.push(...result.items.map(({ id, tenantId: owner, provider, name, version }) => ({ id, tenantId: owner, provider, name, version })));
    if (!result.cursor) break;
    cursor = result.cursor;
  }
  return out;
}

/** Fetches every part now (findings only where due); resolves when done. The newer of two fetches wins. */
export async function refreshProviders(options: { findings?: 'due' | 'all' } = {}): Promise<void> {
  const tenantId = state.tenantId;
  if (!tenantId) return;
  const mine = ++generation;
  set({ loading: true });
  const errors: Record<string, ApiError> = {};
  const now = Date.now();
  const [accounts, leaks] = await Promise.all([
    allAccounts(tenantId).catch((error) => {
      errors.accounts = asApiError(error);
      return undefined;
    }),
    api
      .$request<{ items: LeakRow[] }>('billing/leaks', { from: now - LEAK_WINDOW_MS, to: now + 86_400_000 })
      .then((result) => result.items)
      .catch((error) => {
        errors.leaks = asApiError(error);
        return undefined;
      }),
  ]);
  const findings: ProviderParts['findings'] = { ...(state.parts?.findings ?? {}) };
  const due = (accounts ?? []).filter(
    (account) => options.findings === 'all' || now - (findingsReadAt.get(account.id) ?? 0) >= FINDINGS_MS,
  );
  await Promise.all(
    due.map(async (account) => {
      try {
        const result = await api.$request<{ readAt: number; items: FindingRow[] }>('providerAccounts/findings', {
          tenantId: account.tenantId,
          accountId: account.id,
        });
        findings[account.id] = { readAt: result.readAt, items: result.items };
      } catch (error) {
        const failure = asApiError(error);
        if (failure.code === 'UNSUPPORTED') findings[account.id] = { readAt: now, items: [] };
        else errors[`findings:${account.name}`] = failure;
      }
      findingsReadAt.set(account.id, now);
    }),
  );
  if (mine !== generation) return;
  const known = new Set((accounts ?? []).map((account) => account.id));
  for (const id of Object.keys(findings)) if (accounts && !known.has(id)) delete findings[id];
  set({
    loading: false,
    errors,
    fetchedAt: Date.now(),
    parts: {
      accounts: accounts ?? state.parts?.accounts ?? [],
      ...(leaks ? { leaks } : {}),
      findings,
    },
  });
}

/** The poller's last answer, outside React (the attention queue reads it). Undefined until one arrived. */
export function currentProviderParts(): ProviderParts | undefined {
  return state.parts;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The live provider data; polls while `enabled` (at least one subscriber in live mode). */
export function useLiveProviders(enabled: boolean, tenantId: string | null | undefined): ProviderLiveState {
  const snapshot = useSyncExternalStore(subscribe, () => state, () => state);
  useEffect(() => {
    if (!enabled || !tenantId) return;
    subscribers++;
    if (state.tenantId !== tenantId) {
      findingsReadAt.clear();
      set({ tenantId, parts: undefined, errors: {} });
    }
    if (subscribers === 1) {
      void refreshProviders();
      timer = window.setInterval(() => void refreshProviders(), REFRESH_MS);
    }
    return () => {
      subscribers--;
      if (subscribers === 0 && timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };
  }, [enabled, tenantId]);
  return snapshot;
}
