'use client';

import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { AnimatePresence, motion, useInView } from 'motion/react';
import {
  RiArrowGoBackLine,
  RiCheckLine,
  RiCloseLine,
  RiEditLine,
  RiFileCodeLine,
  RiPulseLine,
  RiTerminalBoxLine,
} from 'react-icons/ri';
import { Switch } from '@/components/base/switch/switch';
import { cx } from '@/utils/cx';
import { DiagramFrame, PlayToggle, ReplayButton } from './frame';
import { ease, useReducedMotionSafe } from './motion';

/**
 * FleetConfig as code, simulated in the browser. The planner below is a line-for-line port of
 * packages/fleet/src/plan.ts (changes, call order, prune rules, BLOCKED reasons), with the export
 * format of state.ts, the drift check of drift.ts and the CLI's describePlan. Ids are the real
 * `draftId`s and the planHash is the real SHA-256 over the canonical call list, computed here with a
 * synchronous SHA-256 so the server render and the client agree. Nothing talks to a server.
 */

// --- Hashing: SHA-256, Crockford base32, draftId, canonical JSON ------------------------------

const TENANT = 'root';
const IDENTITY = 'usr_root';

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const rotate = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));

function sha256(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  const padded = new Uint8Array(((bytes.length + 72) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = bytes.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 2 ** 32));
  view.setUint32(padded.length - 4, bits >>> 0);
  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const words = new Array<number>(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index++) {
      const low = words[index - 15];
      const high = words[index - 2];
      const s0 = rotate(low, 7) ^ rotate(low, 18) ^ (low >>> 3);
      const s1 = rotate(high, 17) ^ rotate(high, 19) ^ (high >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index++) {
      const t1 =
        (h +
          (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
          ((e & f) ^ (~e & g)) +
          K[index] +
          words[index]) >>>
        0;
      const t2 =
        ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((value, index) => {
      hash[index] = (hash[index] + value) >>> 0;
    });
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  hash.forEach((value, index) => outView.setUint32(index * 4, value));
  return out;
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** Crockford base32, lower case (`base32` in @better-compute/core). */
function base32(bytes: Uint8Array): string {
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}

/** `draftId(prefix, tenant, caller, key)`: the id a create under this idempotency key gets. */
const draftId = (prefix: string, key: string) =>
  `${prefix}_${base32(sha256(JSON.stringify(['better-compute/draft/v1', prefix, TENANT, IDENTITY, key])))}`;

/** Canonical JSON with sorted keys: how fleet compares values and hashes plans. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

// --- FleetConfig v1 and the fleet it describes -------------------------------------------------

interface Site {
  name: string;
  kind: 'shared' | 'dedicated' | 'custom';
  region: string;
  iamRegion?: string;
}
interface Account {
  name: string;
  provider: string;
  config: Record<string, unknown>;
}
interface Offer {
  tenant: string;
  quota: Record<string, number>;
  includeDescendants?: boolean;
  priority?: number;
}
interface Pool {
  name: string;
  site: string;
  class: string;
  gpuModel?: string;
  sharing?: string;
  agent?: 'bcd' | 'none';
  policy?: Record<string, unknown>;
  ownerQuota?: Record<string, number>;
  providerAccount?: string;
  offers?: Offer[];
}
interface Flavor {
  pool: string;
  name: string;
  vcpu: number;
  memoryGiB: number;
  diskGiB: number;
  gpus?: number;
  offerId?: string;
}
interface FleetConfig {
  version: 1;
  sites?: Site[];
  providerAccounts?: Account[];
  pools?: Pool[];
  flavors?: Flavor[];
}

interface PoolState {
  id: string;
  siteId: string;
  name: string;
  site: string;
  class: string;
  sharing: string;
  agent: 'bcd' | 'none';
  policy: Record<string, unknown>;
  ownerQuota: Record<string, number>;
  offers: Offer[];
  gpuModel?: string;
  providerAccountId?: string;
  providerAccount?: string;
}
/** The tenant's live platform objects, as `readFleetState` reads them. */
interface FleetState {
  sites: (Site & { id: string })[];
  providerAccounts: (Account & { id: string })[];
  pools: PoolState[];
  flavors: (Flavor & { poolId: string })[];
}

type NamedKind = 'site' | 'pool' | 'providerAccount';
type ChangeAction = 'create' | 'update' | 'delete' | 'unchanged';
interface Change {
  kind: 'site' | 'providerAccount' | 'pool' | 'ownerQuota' | 'offer' | 'flavor';
  name: string;
  action: ChangeAction;
  fields?: string[];
  blocked?: string;
  note?: string;
}
interface Call {
  path: string;
  input: Record<string, unknown>;
  names?: { kind: NamedKind; name: string; id: string };
}
interface Plan {
  changes: Change[];
  calls: Call[];
  summary: Record<ChangeAction, number>;
  blocked: boolean;
  planHash: string;
}

const fleetKey = (kind: NamedKind, name: string) => `fleet:${TENANT}:${kind}:${name}`.slice(0, 128);
const idPrefix: Record<NamedKind, string> = { site: 'site', pool: 'pool', providerAccount: 'pacct' };

/** `planFleet` (packages/fleet/src/plan.ts) with `planHash` (drift.ts), for tenant `root`. */
function planFleet(desired: FleetConfig, state: FleetState, prune: boolean): Plan {
  const tenantId = TENANT;
  const changes: Change[] = [];
  const creates: Call[] = [];
  const updates: Call[] = [];
  const deletes: Call[] = [];
  const add = (change: Change) => changes.push(change);

  // Provider accounts.
  const accountIds = new Map(state.providerAccounts.map((account) => [account.name, account.id]));
  const wantedAccounts = new Set<string>();
  for (const account of desired.providerAccounts ?? []) {
    wantedAccounts.add(account.name);
    const current = state.providerAccounts.find((item) => item.name === account.name);
    if (!current) {
      const key = fleetKey('providerAccount', account.name);
      const id = draftId(idPrefix.providerAccount, key);
      accountIds.set(account.name, id);
      add({ kind: 'providerAccount', name: account.name, action: 'create' });
      creates.push({
        path: 'providerAccounts/create',
        input: {
          tenantId,
          provider: account.provider,
          name: account.name,
          config: account.config,
          idempotencyKey: key,
        },
        names: { kind: 'providerAccount', name: account.name, id },
      });
    } else if (current.provider !== account.provider)
      add({
        kind: 'providerAccount',
        name: account.name,
        action: 'update',
        fields: ['provider'],
        blocked: 'the provider of an account cannot change; create a new account',
      });
    else if (
      Object.entries(account.config).some(([field, value]) => !same(current.config[field], value))
    ) {
      add({ kind: 'providerAccount', name: account.name, action: 'update', fields: ['config'] });
      updates.push({
        path: 'providerAccounts/update',
        input: { tenantId, accountId: current.id, config: account.config },
      });
    } else add({ kind: 'providerAccount', name: account.name, action: 'unchanged' });
  }

  // Sites: created, never changed and never pruned.
  const siteIds = new Map(state.sites.map((site) => [site.name, site.id]));
  const wantedSites = new Set<string>();
  for (const site of desired.sites ?? []) {
    wantedSites.add(site.name);
    const current = state.sites.find((item) => item.name === site.name);
    if (!current) {
      const key = fleetKey('site', site.name);
      const id = draftId(idPrefix.site, key);
      siteIds.set(site.name, id);
      add({ kind: 'site', name: site.name, action: 'create' });
      creates.push({
        path: 'sites/create',
        input: {
          tenantId,
          kind: site.kind,
          region: site.region,
          ...(site.iamRegion ? { iamRegion: site.iamRegion } : {}),
          idempotencyKey: key,
        },
        names: { kind: 'site', name: site.name, id },
      });
      continue;
    }
    const fields = (['kind', 'region', 'iamRegion'] as const).filter(
      (field) => (current[field] ?? null) !== (site[field] ?? null),
    );
    add(
      fields.length
        ? {
            kind: 'site',
            name: site.name,
            action: 'update',
            fields,
            blocked: 'sites cannot change; create a new site',
          }
        : { kind: 'site', name: site.name, action: 'unchanged' },
    );
  }
  if (prune)
    for (const site of state.sites)
      if (!wantedSites.has(site.name))
        add({ kind: 'site', name: site.name, action: 'unchanged', note: 'sites are never pruned' });

  // Pools, owner quotas and offers.
  const poolIds = new Map(state.pools.map((pool) => [pool.name, pool.id]));
  const wantedPools = new Set<string>();
  const offerCalls: Call[] = [];
  const unoffers: Call[] = [];
  for (const pool of desired.pools ?? []) {
    wantedPools.add(pool.name);
    const siteId = siteIds.get(pool.site);
    const accountId =
      pool.providerAccount === undefined ? undefined : accountIds.get(pool.providerAccount);
    const current = state.pools.find((item) => item.name === pool.name);
    if (!siteId) {
      add({
        kind: 'pool',
        name: pool.name,
        action: current ? 'update' : 'create',
        blocked: `unknown site ${pool.site}`,
      });
      continue;
    }
    if (pool.providerAccount !== undefined && !accountId) {
      add({
        kind: 'pool',
        name: pool.name,
        action: current ? 'update' : 'create',
        blocked: `unknown provider account ${pool.providerAccount}`,
      });
      continue;
    }
    let poolId: string;
    if (!current) {
      const key = fleetKey('pool', pool.name);
      poolId = draftId(idPrefix.pool, key);
      poolIds.set(pool.name, poolId);
      add({ kind: 'pool', name: pool.name, action: 'create' });
      creates.push({
        path: 'pools/create',
        input: {
          tenantId,
          siteId,
          class: pool.class,
          ...(pool.gpuModel ? { gpuModel: pool.gpuModel } : {}),
          ...(pool.sharing ? { sharing: pool.sharing } : {}),
          ...(pool.agent ? { agent: pool.agent } : {}),
          policy: pool.policy ?? {},
          ...(pool.ownerQuota ? { ownerQuota: pool.ownerQuota } : {}),
          ...(accountId ? { providerAccountId: accountId } : {}),
          idempotencyKey: key,
        },
        names: { kind: 'pool', name: pool.name, id: poolId },
      });
    } else {
      poolId = current.id;
      const immutable: string[] = [];
      if (current.siteId !== siteId) immutable.push('site');
      if (current.class !== pool.class) immutable.push('class');
      if (pool.sharing !== undefined && current.sharing !== pool.sharing) immutable.push('sharing');
      if (pool.agent !== undefined && current.agent !== pool.agent) immutable.push('agent');
      if ((current.providerAccountId ?? null) !== (accountId ?? null))
        immutable.push('providerAccount');
      const mutable: string[] = [];
      const update: Record<string, unknown> = { tenantId, poolId };
      if (!same(current.policy, pool.policy ?? {})) {
        mutable.push('policy');
        update.policy = pool.policy ?? {};
      }
      if (pool.gpuModel !== undefined && current.gpuModel !== pool.gpuModel) {
        mutable.push('gpuModel');
        update.gpuModel = pool.gpuModel;
      }
      if (immutable.length)
        add({
          kind: 'pool',
          name: pool.name,
          action: 'update',
          fields: [...immutable, ...mutable],
          blocked: `${immutable.join(', ')} cannot change; create a new pool`,
        });
      else if (mutable.length) {
        add({ kind: 'pool', name: pool.name, action: 'update', fields: mutable });
        updates.push({ path: 'pools/update', input: update });
      } else add({ kind: 'pool', name: pool.name, action: 'unchanged' });

      for (const [resource, max] of Object.entries(pool.ownerQuota ?? {})) {
        const name = `${pool.name}:${resource}`;
        if (current.ownerQuota[resource] === max)
          add({ kind: 'ownerQuota', name, action: 'unchanged' });
        else {
          add({
            kind: 'ownerQuota',
            name,
            action: current.ownerQuota[resource] === undefined ? 'create' : 'update',
            fields: ['max'],
          });
          updates.push({ path: 'quotas/set', input: { tenantId, poolId, resource, max } });
        }
      }
    }

    const currentOffers = current?.offers ?? [];
    const wantedTenants = new Set<string>();
    for (const offer of pool.offers ?? []) {
      wantedTenants.add(offer.tenant);
      const name = `${pool.name} -> ${offer.tenant}`;
      if (offer.tenant === tenantId) {
        add({
          kind: 'offer',
          name,
          action: 'create',
          blocked: 'a pool is not offered to its owner; use ownerQuota',
        });
        continue;
      }
      const existing = currentOffers.find((item) => item.tenant === offer.tenant);
      const input = {
        tenantId,
        poolId,
        toTenantId: offer.tenant,
        quota: offer.quota,
        includeDescendants: offer.includeDescendants ?? false,
        ...(offer.priority !== undefined ? { priority: offer.priority } : {}),
      };
      if (!existing) {
        add({ kind: 'offer', name, action: 'create' });
        offerCalls.push({ path: 'pools/offer', input });
        continue;
      }
      const fields: string[] = [];
      if (
        Object.entries(offer.quota).some(([resource, max]) => existing.quota[resource] !== max)
      )
        fields.push('quota');
      if ((existing.includeDescendants ?? false) !== (offer.includeDescendants ?? false))
        fields.push('includeDescendants');
      if ((existing.priority ?? 0) !== (offer.priority ?? 0)) fields.push('priority');
      if (fields.length) {
        add({ kind: 'offer', name, action: 'update', fields });
        offerCalls.push({ path: 'pools/offer', input });
      } else add({ kind: 'offer', name, action: 'unchanged' });
    }
    if (prune)
      for (const offer of currentOffers)
        if (!wantedTenants.has(offer.tenant)) {
          add({ kind: 'offer', name: `${pool.name} -> ${offer.tenant}`, action: 'delete' });
          unoffers.push({
            path: 'pools/unoffer',
            input: { tenantId, poolId, toTenantId: offer.tenant },
          });
        }
  }

  // Flavors (this deployment runs the vps module).
  const flavorCalls: Call[] = [];
  const flavorDeletes: Call[] = [];
  const wantedFlavors = new Set<string>();
  for (const flavor of desired.flavors ?? []) {
    const name = `${flavor.pool}/${flavor.name}`;
    wantedFlavors.add(name);
    const poolId = poolIds.get(flavor.pool);
    if (!poolId) {
      add({ kind: 'flavor', name, action: 'create', blocked: `unknown pool ${flavor.pool}` });
      continue;
    }
    const input = {
      tenantId,
      poolId,
      name: flavor.name,
      vcpu: flavor.vcpu,
      memoryGiB: flavor.memoryGiB,
      diskGiB: flavor.diskGiB,
      ...(flavor.gpus !== undefined ? { gpus: flavor.gpus } : {}),
      ...(flavor.offerId !== undefined ? { offerId: flavor.offerId } : {}),
    };
    const current = state.flavors.find(
      (item) => item.poolId === poolId && item.name === flavor.name,
    );
    if (!current) {
      add({ kind: 'flavor', name, action: 'create' });
      flavorCalls.push({ path: 'flavors/create', input });
      continue;
    }
    const fields = (['vcpu', 'memoryGiB', 'diskGiB', 'gpus', 'offerId'] as const).filter(
      (field) =>
        (current[field] ?? (field === 'gpus' ? 0 : null)) !==
        (flavor[field] ?? (field === 'gpus' ? 0 : null)),
    );
    if (fields.length) {
      add({ kind: 'flavor', name, action: 'update', fields });
      flavorCalls.push({ path: 'flavors/update', input });
    } else add({ kind: 'flavor', name, action: 'unchanged' });
  }

  // Deletes (prune), children first.
  if (prune) {
    for (const flavor of state.flavors)
      if (!wantedFlavors.has(`${flavor.pool}/${flavor.name}`)) {
        add({ kind: 'flavor', name: `${flavor.pool}/${flavor.name}`, action: 'delete' });
        flavorDeletes.push({
          path: 'flavors/delete',
          input: { tenantId, poolId: flavor.poolId, name: flavor.name },
        });
      }
    for (const pool of state.pools)
      if (!wantedPools.has(pool.name)) {
        add({
          kind: 'pool',
          name: pool.name,
          action: 'delete',
          note: 'archived: running reservations keep their bookings',
        });
        deletes.push({ path: 'pools/archive', input: { tenantId, poolId: pool.id } });
      }
    for (const account of state.providerAccounts)
      if (!wantedAccounts.has(account.name)) {
        const user = state.pools.find(
          (pool) => pool.providerAccountId === account.id && wantedPools.has(pool.name),
        );
        if (user) {
          add({
            kind: 'providerAccount',
            name: account.name,
            action: 'unchanged',
            note: `kept: pool ${user.name} uses it`,
          });
          continue;
        }
        add({ kind: 'providerAccount', name: account.name, action: 'delete' });
        deletes.push({
          path: 'providerAccounts/delete',
          input: { tenantId, accountId: account.id },
        });
      }
  }

  const calls = [
    ...creates.filter((call) => call.path === 'providerAccounts/create'),
    ...updates.filter((call) => call.path === 'providerAccounts/update'),
    ...creates.filter((call) => call.path === 'sites/create'),
    ...creates.filter((call) => call.path === 'pools/create'),
    ...updates.filter((call) => call.path === 'pools/update' || call.path === 'quotas/set'),
    ...offerCalls,
    ...flavorCalls,
    ...flavorDeletes,
    ...unoffers,
    ...deletes.filter((call) => call.path === 'pools/archive'),
    ...deletes.filter((call) => call.path === 'providerAccounts/delete'),
  ];
  const summary = { create: 0, update: 0, delete: 0, unchanged: 0 };
  for (const change of changes) summary[change.action]++;
  return {
    changes,
    calls,
    summary,
    blocked: changes.some((change) => change.blocked),
    planHash: hex(sha256(canonical(calls.map(({ path, input }) => ({ path, input }))))),
  };
}

/** `describePlan` (packages/cli/src/commands/fleet.ts): one line per change that does something. */
function describePlan(plan: Pick<Plan, 'changes' | 'summary'>): string[] {
  const mark = { create: '+', update: '~', delete: '-', unchanged: '=' } as const;
  const lines = plan.changes
    .filter((change) => change.action !== 'unchanged' || change.blocked || change.note)
    .map((change) => {
      let line = `${mark[change.action]} ${change.kind} ${change.name}`;
      if (change.fields?.length) line += ` (${change.fields.join(', ')})`;
      if (change.blocked) line += `  BLOCKED: ${change.blocked}`;
      else if (change.note) line += `  (${change.note})`;
      return line;
    });
  const { create, update, delete: deleted, unchanged } = plan.summary;
  lines.push(
    `${create} to create, ${update} to update, ${deleted} to delete, ${unchanged} unchanged.`,
  );
  return lines;
}

/** Postgres jsonb key order (shorter keys first), which is how stored configs come back. */
function jsonb<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
      .map((key) => [key, jsonb(record[key])]),
  ) as T;
}

const byResource = (quota: Record<string, number>) =>
  Object.fromEntries(Object.entries(quota).sort(([a], [b]) => a.localeCompare(b)));
const byId = <T extends { id: string }>(items: T[]) =>
  [...items].sort((a, b) => (a.id < b.id ? -1 : 1));

/** The owning modules' effects of the calls `fleet.apply` invokes, on the in-memory fleet. */
function runCalls(start: FleetState, calls: Call[]): FleetState {
  const state: FleetState = structuredClone(start);
  const poolById = (id: unknown) => state.pools.find((pool) => pool.id === id);
  for (const { path, input, names } of calls) {
    if (path === 'providerAccounts/create' && names) {
      // Stored configs carry the provider manifest's defaults (hetzner-cloud: location fsn1).
      const config =
        input.provider === 'hetzner-cloud'
          ? { location: 'fsn1', ...(input.config as object) }
          : (input.config as object);
      state.providerAccounts = byId([
        ...state.providerAccounts,
        {
          id: names.id,
          name: names.name,
          provider: input.provider as string,
          config: jsonb(config as Record<string, unknown>),
        },
      ]);
    } else if (path === 'providerAccounts/update') {
      state.providerAccounts = state.providerAccounts.map((account) =>
        account.id === input.accountId
          ? { ...account, config: jsonb({ ...account.config, ...(input.config as object) }) }
          : account,
      );
    } else if (path === 'providerAccounts/delete') {
      state.providerAccounts = state.providerAccounts.filter(
        (account) => account.id !== input.accountId,
      );
    } else if (path === 'sites/create' && names) {
      const site: Site & { id: string } = {
        id: names.id,
        name: names.name,
        kind: input.kind as Site['kind'],
        region: input.region as string,
      };
      if (input.iamRegion) site.iamRegion = input.iamRegion as string;
      state.sites = byId([...state.sites, site]);
    } else if (path === 'pools/create' && names) {
      const account = state.providerAccounts.find((item) => item.id === input.providerAccountId);
      const pool: PoolState = {
        id: names.id,
        siteId: input.siteId as string,
        name: names.name,
        site: state.sites.find((site) => site.id === input.siteId)?.name ?? String(input.siteId),
        class: input.class as string,
        sharing: (input.sharing as string | undefined) ?? 'exclusive',
        agent:
          (input.agent as 'bcd' | 'none' | undefined) ??
          (input.class === 'provider' ? 'none' : 'bcd'),
        policy: jsonb(input.policy as Record<string, unknown>),
        // pools.create's default owner quota: effectively unlimited GPUs.
        ownerQuota: byResource(
          (input.ownerQuota as Record<string, number> | undefined) ?? { gpu: 2_147_483_647 },
        ),
        offers: [],
      };
      if (input.gpuModel) pool.gpuModel = input.gpuModel as string;
      if (account) {
        pool.providerAccountId = account.id;
        pool.providerAccount = account.name;
      }
      state.pools = byId([...state.pools, pool]);
    } else if (path === 'pools/update') {
      const pool = poolById(input.poolId);
      if (pool) {
        if (input.policy) pool.policy = jsonb(input.policy as Record<string, unknown>);
        if (input.gpuModel) pool.gpuModel = input.gpuModel as string;
      }
    } else if (path === 'quotas/set') {
      const pool = poolById(input.poolId);
      if (pool)
        pool.ownerQuota = byResource({
          ...pool.ownerQuota,
          [input.resource as string]: input.max as number,
        });
    } else if (path === 'pools/offer') {
      const pool = poolById(input.poolId);
      if (pool) {
        const offer: Offer = {
          tenant: input.toTenantId as string,
          quota: byResource(input.quota as Record<string, number>),
          includeDescendants: input.includeDescendants as boolean,
        };
        if (input.priority) offer.priority = input.priority as number;
        pool.offers = [...pool.offers.filter((item) => item.tenant !== offer.tenant), offer].sort(
          (a, b) => a.tenant.localeCompare(b.tenant),
        );
      }
    } else if (path === 'pools/unoffer') {
      const pool = poolById(input.poolId);
      if (pool) pool.offers = pool.offers.filter((item) => item.tenant !== input.toTenantId);
    } else if (path === 'pools/archive') {
      // Archived pools (and their flavors) drop out of what fleet reads.
      state.pools = state.pools.filter((pool) => pool.id !== input.poolId);
      state.flavors = state.flavors.filter((flavor) => flavor.poolId !== input.poolId);
    } else if (path === 'flavors/create' || path === 'flavors/update') {
      const flavor: Flavor & { poolId: string } = {
        poolId: input.poolId as string,
        pool: poolById(input.poolId)?.name ?? String(input.poolId),
        name: input.name as string,
        vcpu: input.vcpu as number,
        memoryGiB: input.memoryGiB as number,
        diskGiB: input.diskGiB as number,
      };
      if (input.gpus) flavor.gpus = input.gpus as number;
      if (input.offerId) flavor.offerId = input.offerId as string;
      state.flavors = [
        ...state.flavors.filter(
          (item) => !(item.poolId === flavor.poolId && item.name === flavor.name),
        ),
        flavor,
      ].sort((a, b) =>
        a.poolId === b.poolId ? a.name.localeCompare(b.name) : a.poolId < b.poolId ? -1 : 1,
      );
    } else if (path === 'flavors/delete') {
      state.flavors = state.flavors.filter(
        (item) => !(item.poolId === input.poolId && item.name === input.name),
      );
    }
  }
  return state;
}

/** `exportFleetConfig` (packages/fleet/src/state.ts), keys in the order `fleet export` writes them. */
function exportFleet(state: FleetState): FleetConfig {
  const config: FleetConfig = { version: 1 };
  if (state.sites.length)
    config.sites = state.sites.map((site) => ({
      name: site.name,
      kind: site.kind,
      region: site.region,
      ...(site.iamRegion ? { iamRegion: site.iamRegion } : {}),
    }));
  if (state.providerAccounts.length)
    config.providerAccounts = state.providerAccounts.map((account) => ({
      name: account.name,
      provider: account.provider,
      config: account.config,
    }));
  if (state.pools.length)
    config.pools = state.pools.map((pool) => ({
      name: pool.name,
      site: pool.site,
      class: pool.class,
      sharing: pool.sharing,
      agent: pool.agent,
      policy: pool.policy,
      ownerQuota: pool.ownerQuota,
      ...(pool.gpuModel ? { gpuModel: pool.gpuModel } : {}),
      ...(pool.providerAccount ? { providerAccount: pool.providerAccount } : {}),
      ...(pool.offers.length
        ? {
            offers: pool.offers.map((offer) => ({
              tenant: offer.tenant,
              quota: offer.quota,
              includeDescendants: offer.includeDescendants ?? false,
              ...(offer.priority ? { priority: offer.priority } : {}),
            })),
          }
        : {}),
    }));
  if (state.flavors.length)
    config.flavors = state.flavors.map((flavor) => ({
      pool: flavor.pool,
      name: flavor.name,
      vcpu: flavor.vcpu,
      memoryGiB: flavor.memoryGiB,
      diskGiB: flavor.diskGiB,
      ...(flavor.gpus ? { gpus: flavor.gpus } : {}),
      ...(flavor.offerId ? { offerId: flavor.offerId } : {}),
    }));
  return config;
}

// --- The demo's fleet and the edits a reader can make ------------------------------------------

/** What the platform team first applied: a metal GPU pool offered to acme, and a Hetzner burst pool. */
const seed: FleetConfig = {
  version: 1,
  sites: [{ name: 'fra', kind: 'shared', region: 'eu-central' }],
  providerAccounts: [
    { name: 'cloud', provider: 'hetzner-cloud', config: { token: 'secret://hetzner' } },
  ],
  pools: [
    {
      name: 'gpu-fra',
      site: 'fra',
      class: 'metal-host',
      gpuModel: 'H100',
      policy: { maxPending: '30m' },
      ownerQuota: { gpu: 32 },
      offers: [{ tenant: 'acme', quota: { gpu: 8 }, priority: 5 }],
    },
    {
      name: 'burst',
      site: 'fra',
      class: 'provider',
      providerAccount: 'cloud',
      ownerQuota: { vcpu: 256 },
    },
  ],
  flavors: [{ pool: 'burst', name: 'cx32', vcpu: 4, memoryGiB: 8, diskGiB: 80, offerId: 'cx32' }],
};

const emptyFleet: FleetState = { sites: [], providerAccounts: [], pools: [], flavors: [] };
const startFleet = runCalls(emptyFleet, planFleet(seed, emptyFleet, false).calls);
/** The file `fleet export --out fleet.json` wrote. */
const exported = exportFleet(startFleet);
const format = (doc: FleetConfig) => JSON.stringify(doc, null, 2);

type EditKey = 'quota' | 'offer' | 'ams' | 'retire' | 'region';

const editList: { key: EditKey; label: string; hint: string }[] = [
  { key: 'quota', label: 'Raise gpu-fra’s owner quota', hint: 'ownerQuota.gpu 32 → 48' },
  { key: 'offer', label: 'Offer acme more of gpu-fra', hint: 'offers[acme].quota.gpu 8 → 16' },
  { key: 'ams', label: 'Add site ams and pool gpu-ams', hint: '+ sites[ams], + pools[gpu-ams]' },
  { key: 'retire', label: 'Remove pool burst', hint: 'with its flavor and provider account' },
  { key: 'region', label: 'Move site fra to us-east', hint: 'sites[fra].region' },
];

const noEdits: Record<EditKey, boolean> = {
  quota: false,
  offer: false,
  ams: false,
  retire: false,
  region: false,
};

/** The exported document with the reader's edits, applied in a fixed order. */
function withEdits(on: Record<EditKey, boolean>): FleetConfig {
  const doc = structuredClone(exported);
  const pool = (name: string) => doc.pools?.find((item) => item.name === name);
  if (on.quota) {
    const target = pool('gpu-fra');
    if (target) target.ownerQuota = { ...target.ownerQuota, gpu: 48 };
  }
  if (on.offer) {
    const offer = pool('gpu-fra')?.offers?.find((item) => item.tenant === 'acme');
    if (offer) offer.quota = { ...offer.quota, gpu: 16 };
  }
  if (on.ams) {
    doc.sites = [...(doc.sites ?? []), { name: 'ams', kind: 'shared', region: 'eu-west' }];
    doc.pools = [
      ...(doc.pools ?? []),
      {
        name: 'gpu-ams',
        site: 'ams',
        class: 'metal-host',
        gpuModel: 'H200',
        ownerQuota: { gpu: 16 },
      },
    ];
  }
  if (on.retire) {
    doc.pools = doc.pools?.filter((item) => item.name !== 'burst');
    doc.flavors = doc.flavors?.filter((item) => item.pool !== 'burst');
    doc.providerAccounts = doc.providerAccounts?.filter((item) => item.name !== 'cloud');
    if (!doc.flavors?.length) delete doc.flavors;
    if (!doc.providerAccounts?.length) delete doc.providerAccounts;
  }
  if (on.region) {
    const site = doc.sites?.find((item) => item.name === 'fra');
    if (site) site.region = 'us-east';
  }
  return doc;
}

/** The out-of-band change: someone runs pools.update on gpu-fra directly. */
const POLICY_APPLIED = '30m';
const POLICY_OUTSIDE = '2h';

// --- The simulation: CLI transcript, fleet.apply's two phases, the fleet.drift reconciler -------

const T0 = Date.UTC(2026, 8, 24, 12, 0);
const MINUTE = 60_000;
const QUARTER = 15 * MINUTE;
const MAX_LINES = 80;

type LineKind = 'cmd' | 'note' | 'out' | 'error' | 'hint';
interface Line {
  id: number;
  kind: LineKind;
  text: string;
  /** Position in the batch it was printed with, for a short stagger. */
  order: number;
  fresh: boolean;
}

interface FleetEvent {
  id: number;
  type: 'fleet.drifted' | 'fleet.converged';
  at: number;
  lines: string[];
}

interface Drift {
  changes: Change[];
  summary: Plan['summary'];
  blocked: boolean;
  planHash: string;
}

/** The `fleet_applied` row: the last document applied, and the drift as of the last check. */
interface Applied {
  doc: FleetConfig;
  text: string;
  prune: boolean;
  planHash: string;
  at: number;
  checkedAt: number;
  driftHash: string | null;
  drift?: Drift;
  /** This apply cleared a reported drift (apply resets it; no event is published). */
  resetDrift?: boolean;
}

/** The calls panel: the last plan, and how far fleet.apply got with it. */
interface Panel {
  plan: Plan;
  /** Object names by id, including the ids this plan's creates will get. */
  names: Record<string, string>;
  text: string;
  prune: boolean;
  phase: 'planned' | 'check' | 'invoke' | 'done' | 'refused';
  step: number;
  refusal?: string;
  doc?: FleetConfig;
}

interface Sim {
  edits: Record<EditKey, boolean>;
  prune: boolean;
  fleet: FleetState;
  /** Pool names archived by a --prune apply; re-adding one would replay the archived pool. */
  archived: string[];
  applied: Applied;
  reviewed?: { text: string; prune: boolean; planHash: string; blocked: boolean };
  panel?: Panel;
  lines: Line[];
  events: FleetEvent[];
  now: number;
  /** When the next fleet.drift run is due (it runs every 15 minutes; this clock skips ahead). */
  nextCheck?: number;
  seq: number;
  editSeq: number;
}

type Act =
  | { type: 'edit'; key: EditKey; on: boolean }
  | { type: 'prune'; on: boolean }
  | { type: 'plan' }
  | { type: 'apply' }
  | { type: 'tick' }
  | { type: 'status' }
  | { type: 'outside' }
  | { type: 'check' }
  | { type: 'reset' };

const short = (hash: string) => `${hash.slice(0, 8)}…`;
const shortId = (id: string) => `${id.slice(0, id.indexOf('_') + 5)}…`;
const clock = (ms: number) => {
  const date = new Date(ms);
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
};
const nextQuarter = (ms: number) => Math.floor(ms / QUARTER) * QUARTER + QUARTER;

const initialSim: Sim = {
  edits: noEdits,
  prune: false,
  fleet: startFleet,
  archived: [],
  applied: {
    doc: exported,
    text: format(exported),
    prune: false,
    planHash: planFleet(exported, emptyFleet, false).planHash,
    at: T0 - 20 * MINUTE,
    checkedAt: T0,
    driftHash: null,
  },
  lines: [
    { id: 1, kind: 'cmd', text: 'better-compute fleet export --out fleet.json', order: 0, fresh: false },
    { id: 2, kind: 'note', text: 'Wrote /work/fleet.json.', order: 1, fresh: false },
    { id: 3, kind: 'out', text: '{ "written": "/work/fleet.json" }', order: 2, fresh: false },
  ],
  events: [],
  now: T0 + 2 * MINUTE,
  seq: 3,
  editSeq: 0,
};

function print(sim: Sim, entries: [LineKind, string][]): Sim {
  let seq = sim.seq;
  const lines = entries.map(([kind, text], order) => ({ id: ++seq, kind, text, order, fresh: true }));
  return { ...sim, seq, lines: [...sim.lines, ...lines].slice(-MAX_LINES) };
}

const planNotes = (plan: Pick<Plan, 'changes' | 'summary'>): [LineKind, string][] =>
  describePlan(plan).map((line) => ['note', line]);
const blockedCount = (plan: Plan) => plan.changes.filter((change) => change.blocked).length;

function panelFor(sim: Sim, plan: Plan, text: string, extra: Partial<Panel> = {}): Panel {
  const names: Record<string, string> = {};
  for (const pool of sim.fleet.pools) names[pool.id] = pool.name;
  for (const account of sim.fleet.providerAccounts) names[account.id] = account.name;
  for (const site of sim.fleet.sites) names[site.id] = site.name;
  for (const call of plan.calls) if (call.names) names[call.names.id] = call.names.name;
  return { plan, names, text, prune: sim.prune, phase: 'planned', step: 0, ...extra };
}

/** `recordApplied`: the document becomes the one drift is checked against, and drift resets. */
function record(sim: Sim, doc: FleetConfig, text: string, prune: boolean, planHash: string): Sim {
  return {
    ...sim,
    applied: {
      doc,
      text,
      prune,
      planHash,
      at: sim.now,
      checkedAt: sim.now,
      driftHash: null,
      resetDrift: sim.applied.drift !== undefined,
    },
  };
}

function reduce(sim: Sim, act: Act): Sim {
  switch (act.type) {
    case 'reset':
      return initialSim;
    case 'edit':
      return { ...sim, edits: { ...sim.edits, [act.key]: act.on }, editSeq: sim.editSeq + 1 };
    case 'prune':
      return { ...sim, prune: act.on };
    case 'plan': {
      const doc = withEdits(sim.edits);
      const text = format(doc);
      const plan = planFleet(doc, sim.fleet, sim.prune);
      const entries: [LineKind, string][] = [
        ['cmd', `better-compute fleet plan fleet.json${sim.prune ? ' --prune' : ''}`],
        ...planNotes(plan),
        ['out', `{ …, "blocked": ${plan.blocked}, "planHash": "${short(plan.planHash)}" }`],
      ];
      if (plan.blocked)
        entries.push(
          ['error', `PLAN_BLOCKED: ${blockedCount(plan)} change(s) cannot be applied`],
          [
            'hint',
            'Hint: Fix the BLOCKED lines in the document (or create new objects instead of changing fixed fields).',
          ],
        );
      return print(
        {
          ...sim,
          now: sim.now + MINUTE,
          reviewed: { text, prune: sim.prune, planHash: plan.planHash, blocked: plan.blocked },
          panel: panelFor(sim, plan, text),
        },
        entries,
      );
    }
    case 'apply': {
      const doc = withEdits(sim.edits);
      const text = format(doc);
      const prune = sim.prune;
      const flags = prune ? ' --prune' : '';
      // The server plans again with the document it is given.
      const plan = planFleet(doc, sim.fleet, prune);
      const next: Sim = { ...sim, now: sim.now + MINUTE };
      const reviewed = sim.reviewed;
      if (reviewed && reviewed.text === text && reviewed.prune === prune && !reviewed.blocked) {
        // fleet apply --plan-hash: straight to fleet.apply with the reviewed hash.
        const command: [LineKind, string] = [
          'cmd',
          `better-compute fleet apply fleet.json${flags} --plan-hash ${short(reviewed.planHash)}`,
        ];
        const shown = sim.panel?.text === text && sim.panel.prune === prune ? sim.panel : undefined;
        if (plan.blocked)
          return print(
            { ...next, panel: { ...panelFor(sim, plan, text), phase: 'refused', refusal: 'INVALID_STATE' } },
            [command, ['error', 'INVALID_STATE: The plan has changes that cannot be applied']],
          );
        if (plan.planHash !== reviewed.planHash)
          return print(
            {
              ...next,
              panel: {
                ...(shown ?? panelFor(sim, plan, text)),
                phase: 'refused',
                refusal: 'CONFIG_DRIFT',
              },
            },
            [
              command,
              ['error', 'CONFIG_DRIFT: The fleet changed since the plan was made; plan again'],
              ['hint', 'Hint: Run fleet plan again and review the new plan.'],
            ],
          );
        if (!plan.calls.length)
          return print(
            record(
              { ...next, reviewed: undefined, panel: { ...panelFor(sim, plan, text), phase: 'done' } },
              doc,
              text,
              prune,
              plan.planHash,
            ),
            [
              command,
              ['note', 'Applied 0 call(s).'],
              ['out', `{ "applied": 0, "planHash": "${short(plan.planHash)}" }`],
            ],
          );
        return print(
          { ...next, panel: panelFor(sim, plan, text, { phase: 'check', doc }) },
          [command],
        );
      }
      // fleet apply --yes: plan, print it, then apply exactly that plan.
      const entries: [LineKind, string][] = [
        ['cmd', `better-compute fleet apply fleet.json${flags} --yes`],
        ...planNotes(plan),
      ];
      if (plan.blocked)
        return print(
          { ...next, panel: { ...panelFor(sim, plan, text), phase: 'refused', refusal: 'PLAN_BLOCKED' } },
          [
            ...entries,
            ['error', `PLAN_BLOCKED: ${blockedCount(plan)} change(s) cannot be applied`],
            ['hint', 'Hint: Fix the BLOCKED lines in the document.'],
          ],
        );
      if (!plan.calls.length)
        // Nothing to call, so the CLI never calls fleet.apply (and nothing is recorded).
        return print({ ...next, panel: panelFor(sim, plan, text) }, [
          ...entries,
          ['out', `{ "applied": 0, "planHash": "${short(plan.planHash)}" }`],
        ]);
      return print({ ...next, panel: panelFor(sim, plan, text, { phase: 'check', doc }) }, entries);
    }
    case 'tick': {
      const panel = sim.panel;
      if (!panel || (panel.phase !== 'check' && panel.phase !== 'invoke')) return sim;
      const total = panel.plan.calls.length;
      const step = panel.step + 1;
      // Phase 1: each call decided for the caller (ctx.check), no transaction open.
      if (panel.phase === 'check')
        return {
          ...sim,
          panel: step >= total ? { ...panel, phase: 'invoke', step: 0 } : { ...panel, step },
        };
      // Phase 2: re-planned inside one transaction, every call run through ctx.invoke.
      if (step < total) return { ...sim, panel: { ...panel, step } };
      const archivedNow = panel.plan.calls
        .filter((call) => call.path === 'pools/archive')
        .map((call) => panel.names[String(call.input.poolId)] ?? '');
      const committed = record(
        {
          ...sim,
          fleet: runCalls(sim.fleet, panel.plan.calls),
          archived: [...sim.archived, ...archivedNow],
          reviewed: undefined,
          panel: { ...panel, phase: 'done', step: total },
        },
        panel.doc ?? withEdits(sim.edits),
        panel.text,
        panel.prune,
        panel.plan.planHash,
      );
      return print(committed, [
        ['note', `Applied ${total} call(s).`],
        ['out', `{ "applied": ${total}, "planHash": "${short(panel.plan.planHash)}" }`],
      ]);
    }
    case 'status': {
      const applied = sim.applied;
      return print({ ...sim, now: sim.now + MINUTE }, [
        ['cmd', 'better-compute fleet status'],
        ...(applied.drift
          ? planNotes(applied.drift)
          : [['note', 'The fleet matches the applied document.'] as [LineKind, string]]),
        [
          'out',
          `{ "tenantId": "root", "applied": { "planHash": "${short(applied.planHash)}", … }${applied.drift ? ', "drift": { … }' : ''} }`,
        ],
      ]);
    }
    case 'outside': {
      const pool = sim.fleet.pools.find((item) => item.name === 'gpu-fra');
      if (!pool) return sim;
      const value = pool.policy.maxPending === POLICY_OUTSIDE ? POLICY_APPLIED : POLICY_OUTSIDE;
      const now = sim.now + MINUTE;
      return print(
        {
          ...sim,
          now,
          fleet: runCalls(sim.fleet, [
            {
              path: 'pools/update',
              input: { tenantId: TENANT, poolId: pool.id, policy: { maxPending: value } },
            },
          ]),
          nextCheck: sim.nextCheck ?? nextQuarter(now),
        },
        [
          [
            'cmd',
            `better-compute api pools.update tenantId=root poolId=${shortId(pool.id)} policy.maxPending=${value}`,
          ],
          ['out', `{ "id": "${shortId(pool.id)}", "policy": { "maxPending": "${value}" }, … }`],
        ],
      );
    }
    case 'check': {
      // checkDrift: re-plan the applied document; publish only when the answer changes.
      if (sim.nextCheck === undefined) return sim;
      const now = Math.max(sim.now, sim.nextCheck);
      const applied = sim.applied;
      const plan = planFleet(applied.doc, sim.fleet, applied.prune);
      const drift: Drift | undefined =
        plan.calls.length > 0 || plan.blocked
          ? {
              changes: plan.changes.filter(
                (change) => change.action !== 'unchanged' || change.blocked,
              ),
              summary: plan.summary,
              blocked: plan.blocked,
              planHash: plan.planHash,
            }
          : undefined;
      const hash = drift ? drift.planHash : null;
      let seq = sim.seq;
      let events = sim.events;
      if (hash !== applied.driftHash) {
        if (drift)
          events = [{ id: ++seq, type: 'fleet.drifted', at: now, lines: describePlan(drift) }, ...events];
        else if (applied.driftHash !== null)
          events = [{ id: ++seq, type: 'fleet.converged', at: now, lines: [] }, ...events];
      }
      return {
        ...sim,
        now,
        seq,
        nextCheck: undefined,
        events: events.slice(0, 4),
        applied: { ...applied, checkedAt: now, driftHash: hash, drift, resetDrift: false },
      };
    }
  }
}

// --- Line diff of the document against the last applied one -----------------------------------

interface Row {
  kind: 'ctx' | 'add' | 'del';
  text: string;
  number?: number;
}

function diffLines(before: string, after: string): Row[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const rows: Row[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      rows.push({ kind: 'ctx', text: b[j], number: j + 1 });
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && lcs[i + 1][j] >= lcs[i][j + 1])) {
      rows.push({ kind: 'del', text: a[i] });
      i++;
    } else {
      rows.push({ kind: 'add', text: b[j], number: j + 1 });
      j++;
    }
  }
  return rows;
}

// --- The component -----------------------------------------------------------------------------

/** How long each call takes to light up while fleet.apply runs, and the pause before phase 2. */
const TICK = 170;
const BEGIN = 420;
/** Real time for "15 minutes later", when fleet.drift runs next. */
const CHECK_MS = 1800;

/** The tour that plays while the demo is on screen: edit, plan, apply, drift, converge. */
const tour: { act: Act; wait: number }[] = [
  { act: { type: 'edit', key: 'quota', on: true }, wait: 1400 },
  { act: { type: 'plan' }, wait: 1500 },
  { act: { type: 'apply' }, wait: 2300 },
  { act: { type: 'outside' }, wait: 2400 },
  { act: { type: 'status' }, wait: 1900 },
  { act: { type: 'outside' }, wait: 2600 },
  { act: { type: 'reset' }, wait: 4200 },
];

const actionOf: Record<string, string> = {
  'sites/create': 'compute:sites:manage',
  'pools/create': 'compute:pools:create',
  'pools/update': 'compute:pools:manage',
  'pools/archive': 'compute:pools:manage',
  'pools/offer': 'compute:pools:share',
  'pools/unoffer': 'compute:pools:share',
  'quotas/set': 'compute:quotas:manage',
  'flavors/create': 'compute:flavors:manage',
  'flavors/update': 'compute:flavors:manage',
  'flavors/delete': 'compute:flavors:manage',
  'providerAccounts/create': 'compute:providers:manage',
  'providerAccounts/update': 'compute:providers:manage',
  'providerAccounts/delete': 'compute:providers:manage',
};

/**
 * Fleet configuration as code: edit a real FleetConfig document with the switches, run `fleet plan`
 * to see the changes and the exact calls, `fleet apply` to converge (every call decided first, then
 * all of them in one transaction), and change a pool outside fleet to watch `fleet.drift` publish
 * `fleet.drifted`, then `fleet.converged` when it is put back. It plays a short tour while on screen;
 * any control takes over.
 */
export function FleetPlan() {
  const [sim, dispatch] = useReducer(reduce, initialSim);
  const [tourStep, setTourStep] = useState(0);
  const [autoplay, setAutoplay] = useState(true);
  // Pressing play is an explicit choice, so it overrides the reduced-motion default.
  const [chosen, setChosen] = useState(false);
  // The reader changed something, so play starts the tour over from a clean fleet.
  const [tookOver, setTookOver] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [focused, setFocused] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const docPane = useRef<HTMLDivElement>(null);
  const terminal = useRef<HTMLDivElement>(null);
  const inView = useInView(root, { amount: 0.3 });
  const reduced = useReducedMotionSafe();
  const playing = autoplay && (!reduced || chosen);

  const doc = useMemo(() => withEdits(sim.edits), [sim.edits]);
  const text = useMemo(() => format(doc), [doc]);
  const rows = useMemo(() => diffLines(sim.applied.text, text), [sim.applied.text, text]);
  const added = rows.filter((row) => row.kind === 'add').length;
  const removed = rows.filter((row) => row.kind === 'del').length;

  const applying = sim.panel?.phase === 'check' || sim.panel?.phase === 'invoke';
  const busy = applying || sim.nextCheck !== undefined;
  const edited = text !== sim.applied.text;
  const fresh =
    sim.reviewed !== undefined && sim.reviewed.text === text && sim.reviewed.prune === sim.prune;
  const suggest = applying
    ? null
    : fresh && !sim.reviewed?.blocked && ((sim.panel?.plan.calls.length ?? 0) > 0 || edited)
      ? 'apply'
      : !fresh && (edited || sim.applied.drift)
        ? 'plan'
        : null;
  const outside =
    sim.fleet.pools.find((pool) => pool.name === 'gpu-fra')?.policy.maxPending === POLICY_OUTSIDE;
  const sync: SyncState = sim.applied.drift ? 'drifted' : edited ? 'edited' : 'synced';
  const locked: Partial<Record<EditKey, string>> = {};
  if (sim.archived.includes('burst')) locked.retire = 'burst is archived · reset to restore it';
  if (sim.archived.includes('gpu-ams')) locked.ams = 'gpu-ams is archived · reset to add it again';

  /** The reader takes over from the tour. */
  function act(action: Act) {
    setAutoplay(false);
    setTookOver(true);
    dispatch(action);
  }

  // fleet.apply: phase 1 lights each call as it is decided, phase 2 as it runs, then it commits.
  useEffect(() => {
    if (!applying || !sim.panel) return;
    const pause = sim.panel.phase === 'invoke' && sim.panel.step === 0 ? BEGIN : TICK;
    const timer = setTimeout(() => dispatch({ type: 'tick' }), reduced ? 0 : pause);
    return () => clearTimeout(timer);
  }, [applying, sim.panel, reduced]);

  // fleet.drift runs at the next quarter hour after the fleet was changed outside fleet.
  useEffect(() => {
    if (sim.nextCheck === undefined) return;
    const timer = setTimeout(() => dispatch({ type: 'check' }), reduced ? 250 : CHECK_MS);
    return () => clearTimeout(timer);
  }, [sim.nextCheck, reduced]);

  // The tour: one step at a time while on screen, idle, and not being read.
  useEffect(() => {
    if (!playing || !inView || hovering || focused || busy) return;
    const step = tour[tourStep];
    const timer = setTimeout(() => {
      dispatch(step.act);
      setTourStep((tourStep + 1) % tour.length);
    }, step.wait);
    return () => clearTimeout(timer);
  }, [playing, inView, hovering, focused, busy, tourStep]);

  // New terminal output scrolls into view inside the terminal, never moving the page.
  const lastLine = sim.lines[sim.lines.length - 1]?.id;
  useEffect(() => {
    const pane = terminal.current;
    if (!pane) return;
    pane.scrollTo({ top: pane.scrollHeight, behavior: reduced ? 'auto' : 'smooth' });
  }, [lastLine, reduced]);

  // An edit scrolls the document to where it changed.
  const seen = useRef({ editSeq: 0, rows: rows.map((row) => row.kind + row.text) });
  useEffect(() => {
    const keys = rows.map((row) => row.kind + row.text);
    const before = seen.current;
    seen.current = { editSeq: sim.editSeq, rows: keys };
    const pane = docPane.current;
    if (!pane || before.editSeq === sim.editSeq) return;
    let index = 0;
    while (index < keys.length && keys[index] === before.rows[index]) index++;
    const row = pane.querySelectorAll<HTMLElement>('[data-row]')[index];
    if (!row) return;
    pane.scrollTo({
      top: Math.max(0, row.offsetTop - pane.clientHeight / 3),
      behavior: reduced ? 'auto' : 'smooth',
    });
  }, [rows, sim.editSeq, reduced]);

  function togglePlay() {
    if (playing) {
      setAutoplay(false);
      return;
    }
    if (tookOver) {
      dispatch({ type: 'reset' });
      setTourStep(0);
      setTookOver(false);
    }
    setChosen(true);
    setAutoplay(true);
  }

  function reset() {
    dispatch({ type: 'reset' });
    setTourStep(0);
    setTookOver(false);
  }

  function onBlur(event: FocusEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
  }

  return (
    <div
      ref={root}
      onPointerEnter={(event: PointerEvent<HTMLDivElement>) => {
        if (event.pointerType === 'mouse') setHovering(true);
      }}
      onPointerLeave={() => setHovering(false)}
      onFocus={(event) => {
        if (event.target.matches(':focus-visible')) setFocused(true);
      }}
      onBlur={onBlur}
    >
      <DiagramFrame
        live={playing}
        label={
          <>
            <span className="font-mono text-text-primary">fleet.json</span> · tenant{' '}
            <span className="font-mono text-text-primary">root</span>
          </>
        }
        actions={
          <>
            <SyncPill state={sync} />
            <PlayToggle paused={!playing} onClick={togglePlay} compact />
            <ReplayButton onClick={reset} label="Reset" />
          </>
        }
        footer={
          <>
            Runs in your browser on a port of the fleet module’s planner: the same changes, call
            order, draft ids and SHA-256 planHash. fleet.drift runs every 15 minutes; this clock
            skips ahead.
          </>
        }
      >
        <div className="grid gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-6">
          {/* The document */}
          <div className="flex min-w-0 flex-col gap-3">
            <p className="eyebrow">Edit the document</p>
            <div className="flex flex-col gap-1.5">
              {editList.map((edit, index) => {
                const on = sim.edits[edit.key];
                const lock = locked[edit.key];
                return (
                  <motion.div
                    key={edit.key}
                    initial={{ opacity: 0, y: 8 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, amount: 0.5 }}
                    transition={{ delay: index * 0.05, duration: 0.4, ease }}
                  >
                    <Switch
                      size="sm"
                      isSelected={on}
                      isDisabled={applying || lock !== undefined}
                      onChange={(value) => act({ type: 'edit', key: edit.key, on: value })}
                      className={cx(
                        'flex w-full flex-row-reverse justify-between gap-3 rounded-lg border bg-surface-raised px-3 py-2 shadow-xs transition-[border-color,opacity,scale] duration-200 active:scale-[0.99]',
                        on
                          ? 'border-text-primary'
                          : 'border-border-button-default hover:border-border-button-hover',
                        lock && 'border-dashed opacity-70',
                      )}
                    >
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-body-2-medium text-text-primary">{edit.label}</span>
                        <span className="font-mono text-caption-2-regular break-words text-text-secondary">
                          {lock ?? edit.hint}
                        </span>
                      </span>
                    </Switch>
                  </motion.div>
                );
              })}
            </div>

            {/* On wide screens the file fills what the right column leaves: a 0px basis, so its length never sets the height. */}
            <div className="relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-border-button-default bg-background-primary-default lg:min-h-[20.5rem] lg:grow lg:basis-0">
              <div className="flex h-9 shrink-0 items-center gap-2 border-b border-separator-border px-3 text-caption-1-regular text-text-secondary">
                <RiFileCodeLine className="size-3.5 shrink-0 text-foreground-icon-secondary" aria-hidden />
                <span className="font-mono text-text-primary">fleet.json</span>
                <span className="ms-auto flex min-w-0 items-center gap-2 font-mono tabular-nums">
                  {added || removed ? (
                    <>
                      <span className="text-text-primary">+{added}</span>
                      <span>−{removed}</span>
                      <span className="hidden truncate sm:inline">since the last apply</span>
                    </>
                  ) : (
                    <span className="truncate">matches the last apply</span>
                  )}
                </span>
              </div>
              <div
                ref={docPane}
                tabIndex={0}
                role="region"
                aria-label="fleet.json, with changes since the last apply"
                data-lenis-prevent
                className="relative h-[15rem] overflow-auto py-2 font-mono text-[0.75rem] leading-[1.125rem] outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-border-focus-ring lg:h-auto lg:min-h-0 lg:grow lg:basis-0"
              >
                {rows.map((row, index) => (
                  <DiffRow key={`${index}:${row.kind}:${row.text}`} row={row} />
                ))}
              </div>
            </div>
          </div>

          {/* The CLI, fleet.apply and fleet.drift */}
          <div className="flex min-w-0 flex-col gap-3">
            <p className="eyebrow">Plan, apply, watch for drift</p>
            <div className="min-w-0 overflow-hidden rounded-xl border border-border-button-default bg-background-primary-default">
              <div className="flex flex-wrap items-center gap-1.5 border-b border-separator-border p-2">
                <CommandButton
                  label="fleet plan"
                  ariaLabel="Run better-compute fleet plan fleet.json"
                  primary={suggest === 'plan'}
                  disabled={applying}
                  onClick={() => act({ type: 'plan' })}
                />
                <CommandButton
                  label="fleet apply"
                  ariaLabel="Run better-compute fleet apply fleet.json"
                  primary={suggest === 'apply'}
                  disabled={applying}
                  onClick={() => act({ type: 'apply' })}
                />
                <CommandButton
                  label="fleet status"
                  ariaLabel="Run better-compute fleet status"
                  disabled={applying}
                  onClick={() => act({ type: 'status' })}
                />
                <Switch
                  size="sm"
                  isSelected={sim.prune}
                  isDisabled={applying}
                  onChange={(value) => act({ type: 'prune', on: value })}
                  className="ms-auto rounded-lg px-1.5 py-1"
                >
                  <span className="font-mono text-caption-1-medium text-text-primary">--prune</span>
                </Switch>
              </div>
              <div
                ref={terminal}
                role="log"
                aria-live={playing ? 'off' : 'polite'}
                aria-label="Terminal"
                tabIndex={0}
                data-lenis-prevent
                className="h-[12.5rem] overflow-y-auto px-3 py-2.5 font-mono text-[0.75rem] leading-[1.125rem] outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-border-focus-ring lg:h-[13.5rem]"
              >
                {sim.lines.map((line, index) => (
                  <TerminalLine key={line.id} line={line} first={index === 0} />
                ))}
              </div>
            </div>

            <CallsPanel panel={sim.panel} stale={Boolean(sim.panel && sim.panel.phase === 'planned' && !fresh)} />

            <DriftPanel
              sim={sim}
              outside={outside}
              disabled={applying}
              reduced={reduced}
              onOutside={() => act({ type: 'outside' })}
            />
          </div>
        </div>
      </DiagramFrame>
    </div>
  );
}

type SyncState = 'synced' | 'edited' | 'drifted';

/** In sync is solid ink, an edited document is an outline, drift is hatched. */
function SyncPill({ state }: { state: SyncState }) {
  const label = state === 'synced' ? 'in sync' : state;
  return (
    <span className="relative inline-flex">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={state}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.2, ease }}
          className={cx(
            'inline-flex h-6 items-center gap-1 rounded-full border px-2 font-mono text-caption-2-medium whitespace-nowrap',
            state === 'synced' && 'border-text-primary bg-text-primary text-background-full',
            state === 'edited' && 'border-text-primary bg-surface-raised text-text-primary',
            state === 'drifted' &&
              'hatch border-dashed border-text-primary bg-surface-raised text-text-primary',
          )}
        >
          {state === 'synced' ? (
            <RiCheckLine className="size-3" aria-hidden />
          ) : state === 'edited' ? (
            <RiEditLine className="size-3" aria-hidden />
          ) : (
            <RiPulseLine className="size-3" aria-hidden />
          )}
          {label}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

function CommandButton({
  label,
  ariaLabel,
  primary = false,
  disabled,
  onClick,
}: {
  label: string;
  ariaLabel: string;
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cx(
        'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 font-mono text-caption-1-medium transition-[background-color,border-color,color,scale] duration-200 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50',
        'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus-ring',
        primary
          ? 'border-text-primary bg-text-primary text-background-full'
          : 'border-border-button-default bg-surface-raised text-text-primary hover:border-border-button-hover',
      )}
    >
      <RiTerminalBoxLine className="size-3.5 shrink-0" aria-hidden />
      {label}
    </button>
  );
}

/** One line of fleet.json: added lines carry an ink rule, removed ones are hatched and struck. */
function DiffRow({ row }: { row: Row }) {
  return (
    <motion.div
      data-row
      initial={row.kind === 'ctx' ? false : { opacity: 0, x: -4 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25, ease }}
      className={cx(
        'grid grid-cols-[2.25rem_1rem_minmax(0,1fr)] border-s-2 pe-3',
        row.kind === 'ctx' && 'border-transparent',
        row.kind === 'add' && 'border-text-primary bg-background-secondary-default',
        row.kind === 'del' && 'hatch border-dashed border-text-tertiary',
      )}
    >
      <span aria-hidden className="pe-2 text-end text-text-tertiary tabular-nums select-none">
        {row.number ?? ''}
      </span>
      <span aria-hidden className="text-center text-text-primary select-none">
        {row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ''}
      </span>
      <span
        className={cx(
          'whitespace-pre',
          row.kind === 'del' && 'text-text-tertiary line-through decoration-text-tertiary',
        )}
      >
        {row.kind === 'add' ? <span className="sr-only">added: </span> : null}
        {row.kind === 'del' ? <span className="sr-only">removed: </span> : null}
        {row.kind === 'del' ? row.text : <JsonTokens text={row.text} />}
      </span>
    </motion.div>
  );
}

const tokenPattern =
  /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)|([{}[\],])/g;

/** Monochrome JSON: keys secondary, values in ink, punctuation tertiary. */
function JsonTokens({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    const [whole, string, colon, number, literal] = match;
    if (string && colon)
      parts.push(
        <span key={index} className="text-text-secondary">
          {string}
        </span>,
        <span key={`${index}:`} className="text-text-tertiary">
          {colon}
        </span>,
      );
    else if (string || number || literal)
      parts.push(
        <span key={index} className="text-text-primary">
          {whole}
        </span>,
      );
    else
      parts.push(
        <span key={index} className="text-text-tertiary">
          {whole}
        </span>,
      );
    last = index + whole.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

const summaryLine = /^\d+ to create, /;

function TerminalLine({ line, first }: { line: Line; first: boolean }) {
  const content = (() => {
    if (line.kind === 'cmd')
      return (
        <>
          <span aria-hidden className="text-text-tertiary select-none">
            ${' '}
          </span>
          <span className="text-text-primary">{line.text}</span>
        </>
      );
    if (line.kind === 'error') {
      const split = line.text.indexOf(': ');
      return (
        <>
          <span className="hatch rounded-sm border border-text-primary px-1 text-text-primary">
            {line.text.slice(0, split)}
          </span>
          <span className="text-text-primary">{line.text.slice(split)}</span>
        </>
      );
    }
    if (line.kind === 'hint') return <span className="text-text-secondary">{line.text}</span>;
    if (line.kind === 'out') return <span className="text-text-tertiary">{line.text}</span>;
    // Notes on stderr: plan lines (+ ~ - =), the summary, and what happened.
    const mark = /^([+~=-]) /.exec(line.text)?.[1];
    if (mark) {
      const [change, blocked] = line.text.slice(2).split('  BLOCKED: ');
      return (
        <>
          <span className="text-text-primary">{mark} </span>
          <span className={blocked ? 'text-text-primary' : 'text-text-secondary'}>{change}</span>
          {blocked ? (
            <>
              {'  '}
              <span className="hatch rounded-sm border border-dashed border-text-primary px-1 text-text-primary">
                BLOCKED
              </span>
              <span className="text-text-primary">: {blocked}</span>
            </>
          ) : null}
        </>
      );
    }
    return (
      <span className={summaryLine.test(line.text) ? 'text-text-secondary' : 'text-text-primary'}>
        {line.text}
      </span>
    );
  })();
  return (
    <motion.div
      initial={line.fresh ? { opacity: 0, y: 3 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease, delay: Math.min(line.order, 8) * 0.045 }}
      className={cx(
        'whitespace-pre-wrap [overflow-wrap:anywhere]',
        line.kind === 'cmd' && !first && 'mt-2',
      )}
    >
      {content}
    </motion.div>
  );
}

type Mark = 'pending' | 'decided' | 'ran';

/** A call's progress: pending is dashed, decided is an outline, ran is solid ink. */
function CallMark({ state, label }: { state: Mark; label: string }) {
  return (
    <span
      role="img"
      aria-label={`${label}: ${state}`}
      className={cx(
        'flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors duration-200',
        state === 'pending' && 'border-dashed border-text-tertiary',
        state === 'decided' && 'border-text-primary text-text-primary',
        state === 'ran' && 'border-text-primary bg-text-primary text-background-full',
      )}
    >
      {state === 'pending' ? null : <RiCheckLine className="size-3" aria-hidden />}
    </span>
  );
}

function PhaseChip({
  index,
  label,
  state,
}: {
  index: number;
  label: string;
  state: 'waiting' | 'running' | 'done';
}) {
  return (
    <span
      className={cx(
        'inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-caption-2-medium whitespace-nowrap transition-colors duration-200',
        state === 'waiting' && 'border-dashed border-border-button-hover text-text-secondary',
        state === 'running' && 'border-text-primary bg-text-primary text-background-full',
        state === 'done' && 'border-text-primary text-text-primary',
      )}
    >
      {state === 'done' ? (
        <RiCheckLine className="size-3" aria-hidden />
      ) : (
        <span className="font-mono tabular-nums">{index}</span>
      )}
      {label}
    </span>
  );
}

function callTarget(call: Call, names: Record<string, string>): string {
  const input = call.input;
  const name = (id: unknown) => names[String(id)] ?? shortId(String(id));
  switch (call.path) {
    case 'sites/create':
      return `${call.names?.name} · ${input.region}`;
    case 'pools/create':
      return `${call.names?.name} · ${input.class}`;
    case 'providerAccounts/create':
      return `${call.names?.name} · ${input.provider}`;
    case 'quotas/set':
      return `${name(input.poolId)}:${input.resource} = ${input.max}`;
    case 'pools/offer':
      return `${name(input.poolId)} → ${input.toTenantId} · ${Object.entries(
        input.quota as Record<string, number>,
      )
        .map(([resource, max]) => `${resource} ${max}`)
        .join(', ')}`;
    case 'pools/unoffer':
      return `${name(input.poolId)} → ${input.toTenantId}`;
    case 'pools/update':
      return `${name(input.poolId)} · ${Object.keys(input)
        .filter((key) => key !== 'tenantId' && key !== 'poolId')
        .join(', ')}`;
    case 'pools/archive':
      return name(input.poolId);
    case 'flavors/create':
    case 'flavors/update':
    case 'flavors/delete':
      return `${name(input.poolId)}/${input.name}`;
    default:
      return name(input.accountId);
  }
}

/** The calls fleet.apply makes, in order: decided one by one, then run in one transaction. */
function CallsPanel({ panel, stale }: { panel?: Panel; stale: boolean }) {
  const calls = panel?.plan.calls ?? [];
  const phase = panel?.phase;
  const markOf = (index: number): [Mark, Mark] => {
    if (phase === 'done') return ['ran', 'ran'];
    if (phase === 'invoke') return ['decided', index < (panel?.step ?? 0) ? 'ran' : 'pending'];
    if (phase === 'check') return [index < (panel?.step ?? 0) ? 'decided' : 'pending', 'pending'];
    return ['pending', 'pending'];
  };
  const first =
    phase === 'check' ? 'running' : phase === 'invoke' || phase === 'done' ? 'done' : 'waiting';
  const second = phase === 'invoke' ? 'running' : phase === 'done' ? 'done' : 'waiting';
  return (
    <div
      className={cx(
        'min-w-0 overflow-hidden rounded-xl border bg-background-primary-default transition-[border-color,opacity] duration-300',
        stale ? 'border-dashed border-border-button-hover' : 'border-border-button-default',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-separator-border px-3 py-2">
        <span className="text-caption-1-medium text-text-primary">fleet.apply</span>
        {panel ? (
          <span className="font-mono text-caption-2-regular text-text-secondary">
            planHash {short(panel.plan.planHash)}
          </span>
        ) : null}
        {panel?.refusal ? (
          <span className="hatch rounded-sm border border-text-primary px-1 font-mono text-caption-2-medium text-text-primary">
            {panel.refusal} · nothing applied
          </span>
        ) : stale ? (
          <span className="rounded-sm border border-dashed border-border-button-hover px-1 font-mono text-caption-2-regular text-text-secondary">
            stale: plan again
          </span>
        ) : panel?.plan.blocked ? (
          <span className="hatch rounded-sm border border-dashed border-text-primary px-1 font-mono text-caption-2-medium text-text-primary">
            blocked · apply refuses the whole plan
          </span>
        ) : null}
        <span className="ms-auto flex items-center gap-1.5">
          <PhaseChip index={1} label="decide each call" state={first} />
          <PhaseChip index={2} label="one transaction" state={second} />
        </span>
      </div>
      {calls.length ? (
        <ol
          aria-label="Calls fleet.apply makes"
          tabIndex={0}
          data-lenis-prevent
          className={cx(
            'h-[9.5rem] overflow-y-auto border-s-2 py-1 transition-colors duration-300',
            'outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-border-focus-ring',
            phase === 'invoke' || phase === 'done' ? 'border-text-primary' : 'border-transparent',
            stale && 'opacity-60',
          )}
        >
          {calls.map((call, index) => {
            const [decided, ran] = markOf(index);
            const created = call.names?.id;
            return (
              <motion.li
                key={`${panel?.plan.planHash}:${index}`}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, ease, delay: Math.min(index, 8) * 0.04 }}
                className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-2 px-3 py-1 sm:grid-cols-[1.25rem_minmax(0,1fr)_minmax(0,11rem)_auto]"
              >
                <span className="font-mono text-caption-2-regular text-text-tertiary tabular-nums">
                  {index + 1}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-mono text-caption-1-medium text-text-primary">
                    {call.path}
                  </span>
                  <span className="truncate font-mono text-caption-2-regular text-text-secondary">
                    {callTarget(call, panel?.names ?? {})}
                    {created ? <span className="text-text-tertiary"> · {shortId(created)}</span> : null}
                  </span>
                </span>
                <span className="hidden truncate font-mono text-caption-2-regular text-text-secondary sm:block">
                  {actionOf[call.path]}
                </span>
                <span className="flex items-center gap-1">
                  <CallMark state={decided} label="decided" />
                  <CallMark state={ran} label="ran" />
                </span>
              </motion.li>
            );
          })}
        </ol>
      ) : (
        <p className="h-[9.5rem] px-3 py-3 text-caption-1-regular text-text-secondary">
          {panel
            ? 'No calls: the fleet already matches this document.'
            : 'Run fleet plan to see the exact calls fleet apply makes, each decided for you before any of them runs.'}
        </p>
      )}
    </div>
  );
}

/** fleet.drift: the button that changes the fleet behind fleet's back, the next run, and the events. */
function DriftPanel({
  sim,
  outside,
  disabled,
  reduced,
  onOutside,
}: {
  sim: Sim;
  outside: boolean;
  disabled: boolean;
  reduced: boolean;
  onOutside: () => void;
}) {
  const applied = sim.applied;
  const drift = applied.drift;
  const changed = drift ? drift.summary.create + drift.summary.update + drift.summary.delete : 0;
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-border-button-default bg-background-primary-default">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-separator-border px-3 py-2">
        <RiPulseLine className="size-3.5 shrink-0 text-foreground-icon-secondary" aria-hidden />
        <span className="font-mono text-caption-1-medium text-text-primary">fleet.drift</span>
        <span className="text-caption-2-regular text-text-secondary">
          re-plans the applied document every 15 minutes
        </span>
        <span className="ms-auto font-mono text-caption-2-regular text-text-secondary">
          applied {short(applied.planHash)} · {clock(applied.at)}
        </span>
      </div>
      <div className="flex flex-col gap-2.5 p-3 sm:flex-row sm:items-center">
        <button
          type="button"
          onClick={onOutside}
          disabled={disabled}
          className={cx(
            'group inline-flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-1.5 text-start transition-[border-color,background-color,scale] duration-200 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50',
            'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus-ring',
            outside
              ? 'border-text-primary bg-surface-raised'
              : 'border-dashed border-border-button-hover bg-surface-raised hover:border-text-primary',
          )}
        >
          {outside ? (
            <RiArrowGoBackLine className="size-4 shrink-0 text-text-primary" aria-hidden />
          ) : (
            <RiEditLine className="size-4 shrink-0 text-text-primary" aria-hidden />
          )}
          <span className="flex min-w-0 flex-col">
            <span className="text-body-2-medium text-text-primary">
              {outside ? 'Put gpu-fra back' : 'Change gpu-fra outside fleet'}
            </span>
            <span className="truncate font-mono text-caption-2-regular text-text-secondary">
              pools.update policy.maxPending={outside ? POLICY_APPLIED : POLICY_OUTSIDE}
            </span>
          </span>
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="font-mono text-caption-2-regular text-text-secondary">
            {sim.nextCheck !== undefined
              ? `next run ${clock(sim.nextCheck)}`
              : drift
                ? `last run ${clock(applied.checkedAt)} · ${changed} change${changed === 1 ? '' : 's'} outside fleet`
                : applied.resetDrift
                  ? `drift reset by fleet apply at ${clock(applied.at)} (no event)`
                  : `last run ${clock(applied.checkedAt)} · matches`}
          </span>
          <span aria-hidden className="relative h-1 overflow-hidden rounded-full bg-background-tertiary-default">
            {sim.nextCheck !== undefined ? (
              <motion.span
                key={sim.nextCheck}
                className="absolute inset-0 origin-left rounded-full bg-text-primary"
                initial={{ scaleX: reduced ? 1 : 0 }}
                animate={{ scaleX: 1 }}
                transition={{ duration: reduced ? 0 : CHECK_MS / 1000, ease: 'linear' }}
              />
            ) : drift ? (
              <span className="trace-bar-after absolute inset-0 rounded-full" />
            ) : null}
          </span>
        </div>
      </div>
      <ol
        aria-label="Events"
        tabIndex={0}
        data-lenis-prevent
        className="h-[6.75rem] overflow-y-auto border-t border-separator-border outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-border-focus-ring"
      >
        {sim.events.length ? (
          sim.events.map((event, index) => (
            <motion.li
              key={event.id}
              initial={index === 0 ? { opacity: 0, y: -4 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease }}
              className="flex items-start gap-2.5 border-b border-separator-border px-3 py-2 last:border-b-0"
            >
              <span
                className={cx(
                  'mt-px inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 font-mono text-caption-2-medium',
                  event.type === 'fleet.drifted'
                    ? 'hatch border-dashed border-text-primary text-text-primary'
                    : 'border-text-primary bg-text-primary text-background-full',
                )}
              >
                {event.type === 'fleet.drifted' ? (
                  <RiCloseLine className="size-3" aria-hidden />
                ) : (
                  <RiCheckLine className="size-3" aria-hidden />
                )}
                {event.type}
              </span>
              <span className="flex min-w-0 flex-col font-mono text-caption-2-regular">
                <span className="text-text-secondary">
                  fleet/root · {clock(event.at)}
                  {event.type === 'fleet.converged' ? ' · the drift cleared on its own' : ''}
                </span>
                {event.lines.map((text) => (
                  <span key={text} className="break-words text-text-primary">
                    {text}
                  </span>
                ))}
              </span>
            </motion.li>
          ))
        ) : (
          <li className="px-3 py-2 text-caption-1-regular text-text-secondary">
            No events yet. <span className="font-mono">fleet.drifted</span> is published once per
            distinct drift, <span className="font-mono">fleet.converged</span> when it clears on its
            own.
          </li>
        )}
      </ol>
    </div>
  );
}
