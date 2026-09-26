'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { api, ApiError } from '@/lib/api';
import type { CommandBatchView, FleetStatus, Instance, NodeInfo, Rollout, Sandbox, SandboxTemplate, SandboxVolume } from '@/lib/data/fleet';
import type { LiveParts } from '@/lib/data/fleet-live';

// One poller for the whole fleet module in live mode: every useFleet() subscriber shares it, it runs only while
// someone is subscribed, and each API group is optional (a module the server doesn't mount answers NOT_FOUND and
// its part stays empty). Pages list every page of nodes; the other groups take their first page.

const REFRESH_MS = 15_000;
const MAX_NODE_PAGES = 40;

export interface LiveState {
  tenantId?: string;
  parts?: LiveParts;
  /** Per API group, the last error (e.g. { nodes: UNAUTHENTICATED }). */
  errors: Record<string, ApiError>;
  loading: boolean;
  fetchedAt?: number;
}

let state: LiveState = { errors: {}, loading: false };
const listeners = new Set<() => void>();
let subscribers = 0;
let timer: number | undefined;
let generation = 0;

function set(next: Partial<LiveState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

async function part<T>(group: string, run: () => Promise<T>, errors: Record<string, ApiError>): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    errors[group] = error instanceof ApiError ? error : new ApiError('NETWORK', String(error), 0);
    return undefined;
  }
}

async function allNodes(tenantId: string): Promise<NodeInfo[]> {
  const out: NodeInfo[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_NODE_PAGES; page++) {
    const result = await api.$request<{ items: NodeInfo[]; cursor?: string }>('nodes/list', { tenantId, limit: 50, ...(cursor ? { cursor } : {}) });
    out.push(...result.items);
    if (!result.cursor) break;
    cursor = result.cursor;
  }
  return out;
}

/** Fetches every part now; resolves when done. Safe to call while a fetch runs (the newer one wins). */
export async function refreshLive(): Promise<void> {
  const tenantId = state.tenantId;
  if (!tenantId) return;
  const mine = ++generation;
  set({ loading: true });
  const errors: Record<string, ApiError> = {};
  const [nodes, instances, sandboxes, templates, volumes, rollouts, batches, drift] = await Promise.all([
    part('nodes', () => allNodes(tenantId), errors),
    part('instances', () => api.$request<{ items: Instance[] }>('instances/list', { tenantId, limit: 200 }).then((r) => r.items), errors),
    part('sandboxes', () => api.$request<{ items: Sandbox[] }>('sandboxes/list', { tenantId, limit: 200 }).then((r) => r.items), errors),
    part('sandboxTemplates', () => api.$request<{ items: SandboxTemplate[] }>('sandboxTemplates/list', { tenantId }).then((r) => r.items), errors),
    part('sandboxVolumes', () => api.$request<{ items: SandboxVolume[] }>('sandboxVolumes/list', { tenantId }).then((r) => r.items), errors),
    part('rollouts', () => api.$request<{ items: Rollout[] }>('rollouts/list', { tenantId }).then((r) => r.items), errors),
    part('commandBatches', () => api.$request<{ items: CommandBatchView[] }>('commandBatches/list', { tenantId }).then((r) => r.items), errors),
    part('fleet', () => api.$request<FleetStatus>('fleet/status', { tenantId }), errors),
  ]);
  if (mine !== generation) return;
  set({
    loading: false,
    errors,
    fetchedAt: Date.now(),
    parts: {
      tenantId,
      nodes: nodes ?? [],
      ...(instances ? { instances } : {}),
      ...(sandboxes ? { sandboxes } : {}),
      ...(templates ? { templates } : {}),
      ...(volumes ? { volumes } : {}),
      ...(rollouts ? { rollouts } : {}),
      ...(batches ? { batches } : {}),
      ...(drift ? { drift } : {}),
    },
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The live fleet data; polls while `enabled` (at least one subscriber in live mode). */
export function useLiveFleet(enabled: boolean, tenantId: string | null | undefined): LiveState {
  const snapshot = useSyncExternalStore(subscribe, () => state, () => state);
  useEffect(() => {
    if (!enabled || !tenantId) return;
    subscribers++;
    if (state.tenantId !== tenantId) set({ tenantId, parts: undefined, errors: {} });
    if (subscribers === 1) {
      void refreshLive();
      timer = window.setInterval(() => void refreshLive(), REFRESH_MS);
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
