import type { Migration } from '@better-compute/core';

/**
 * The v0.1 base schema, frozen at the end of P0 (PLAN.md §8.3). Later changes are new, additive
 * migrations; this text never changes once released.
 *
 * - The §8.3 tables are as the plan writes them.
 * - Then come the indexes behind the access paths the plan spells out, and the tables its "also"
 *   list needs in v0.1.
 * - v0.2+ tables arrive with their phases: join_requests, workflows, workflow_steps, images,
 *   image_locations, profiles, sealed_secrets (v0.2); instances, provider_accounts, webhooks
 *   (v0.3).
 *
 * Every timestamp default is `compute_now()` (P9). Tenant-scoped rows carry their tenant.
 */
export const baseMigration: Migration = {
  name: 'core/0002_base',
  sql: `
-- Fleet: sites, pools, offerings, projects (§2, §8.3).
CREATE TABLE sites (
  id text PRIMARY KEY,
  owner_tenant_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('shared', 'dedicated', 'custom')),
  region text NOT NULL,
  iam_region text,
  version bigint NOT NULL
);
CREATE TABLE pools (
  id text PRIMARY KEY,
  owner_tenant_id text NOT NULL,
  site_id text NOT NULL REFERENCES sites,
  class text NOT NULL,
  gpu_model text,
  sharing text NOT NULL,
  agent text NOT NULL CHECK (agent IN ('bcd', 'none')),
  policy jsonb NOT NULL,
  version bigint NOT NULL
);
CREATE TABLE pool_offers (
  pool_id text REFERENCES pools,
  tenant_id text,
  include_descendants bool NOT NULL DEFAULT false,
  PRIMARY KEY (pool_id, tenant_id)
);
CREATE TABLE projects (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  name text NOT NULL,
  state text NOT NULL,
  version bigint NOT NULL,
  UNIQUE (tenant_id, name)
);

-- Nodes and their sessions (§3.3, §7.2). nodes.shard = fnv1a(id) % 256.
CREATE TABLE nodes (
  id text PRIMARY KEY,
  site_id text NOT NULL REFERENCES sites,
  pool_id text REFERENCES pools,
  owner_tenant_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('unassigned', 'host', 'dedicated', 'site')),
  provision_state text NOT NULL,
  maintenance bool NOT NULL,
  cordoned bool NOT NULL,
  connectivity text NOT NULL,
  trust text NOT NULL CHECK (trust IN ('platform', 'tenant-owned', 'tenant-controlled')),
  -- NoSchedule taints and conditions; written by Health, Liveness and nodes.taint.
  no_schedule_reasons text[] NOT NULL DEFAULT '{}',
  hardware_key bytea,
  hardware_key_trusted bool NOT NULL DEFAULT false,
  spec jsonb,
  generation bigint NOT NULL,
  observed_generation bigint NOT NULL,
  next_cmd_seq bigint NOT NULL,
  identity_gen int NOT NULL,
  shard smallint NOT NULL,
  version bigint NOT NULL,
  CHECK (role <> 'site' OR pool_id IS NULL)
);
CREATE UNIQUE INDEX nodes_hardware_key ON nodes (hardware_key) WHERE hardware_key_trusted;
CREATE TABLE node_labels (
  node_id text REFERENCES nodes,
  key text,
  value text NOT NULL,
  source text NOT NULL,
  PRIMARY KEY (node_id, key)
);
CREATE TABLE node_conditions (
  node_id text REFERENCES nodes,
  type text,
  status text NOT NULL,
  reason text,
  since timestamptz NOT NULL,
  PRIMARY KEY (node_id, type)
);
-- JoinService inserts (node_id, session_epoch = 0); Hello bumps the epoch.
CREATE TABLE node_sessions (
  node_id text PRIMARY KEY REFERENCES nodes,
  gateway_id text,
  session_id text,
  session_epoch bigint NOT NULL,
  boot_id text,
  journal_id text,
  role text,
  acked_event_seq bigint NOT NULL DEFAULT 0,
  last_seen timestamptz,
  connected_at timestamptz,
  disconnected_at timestamptz
);

-- Devices, bookings and guarded counters (§10.2-10.4).
CREATE TABLE devices (
  id text PRIMARY KEY,
  node_id text NOT NULL REFERENCES nodes,
  parent_id text REFERENCES devices,
  class text NOT NULL,
  bookable bool NOT NULL,
  healthy bool NOT NULL,
  -- gpuProduct, gpuModel, vramGiB, numaNode, ...
  attributes jsonb NOT NULL
);
CREATE TABLE device_bookings (
  device_id text NOT NULL REFERENCES devices,
  allocation_id text NOT NULL,
  during tstzrange NOT NULL CHECK (NOT isempty(during)),
  EXCLUDE USING gist (device_id WITH =, during WITH &&)
);
CREATE TABLE node_resources (
  node_id text,
  resource text,
  allocatable bigint NOT NULL,
  ratio numeric NOT NULL,
  allocated bigint NOT NULL,
  PRIMARY KEY (node_id, resource),
  CHECK (allocated BETWEEN 0 AND floor(allocatable * ratio))
);
-- Rows are created by pools.offer (and pools.create for the owner); a missing row grants 0.
CREATE TABLE quota_usage (
  tenant_id text,
  pool_id text,
  resource text,
  max bigint NOT NULL,
  used bigint NOT NULL,
  PRIMARY KEY (tenant_id, pool_id, resource),
  CHECK (used BETWEEN 0 AND max)
);

-- Reservations (§3.4, §10.5). Idempotency keys are scoped to (tenant, owner identity).
CREATE TABLE reservations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  pool_id text NOT NULL,
  project_id text,
  state text NOT NULL,
  request jsonb NOT NULL,
  request_hash bytea NOT NULL,
  during tstzrange,
  owner_identity_id text NOT NULL,
  agent_id text,
  delegation_id text,
  idempotency_key text NOT NULL,
  version bigint NOT NULL,
  UNIQUE (tenant_id, owner_identity_id, idempotency_key)
);

-- Commands, the coalescing work queue, leases and workers (§7.4, §8.4, §8.5).
CREATE TABLE commands (
  id text PRIMARY KEY,
  node_id text NOT NULL,
  seq bigint NOT NULL,
  kind text NOT NULL,
  body bytea NOT NULL,
  signature bytea,
  state text NOT NULL,
  reason text,
  session_epoch bigint,
  not_before timestamptz NOT NULL DEFAULT compute_now(),
  not_after timestamptz NOT NULL,
  min_generation bigint,
  retry_safe bool NOT NULL,
  self_terminating bool NOT NULL,
  attested bool NOT NULL,
  idempotency_key text NOT NULL,
  UNIQUE (node_id, seq),
  UNIQUE (node_id, idempotency_key)
);
CREATE TABLE work_queue (
  kind text,
  key text,
  shard smallint NOT NULL,
  gen bigint NOT NULL,
  not_before timestamptz NOT NULL,
  claimed_until timestamptz,
  PRIMARY KEY (kind, key)
);
-- Names: shard:<n>, pool:<id>, site:<id>:boot, singleton:<job>, gateway:<id>.
CREATE TABLE leases (
  name text PRIMARY KEY,
  owner text,
  epoch bigint NOT NULL,
  expires_at timestamptz NOT NULL
);
-- Rendezvous hashing spreads the 256 shards over these.
CREATE TABLE workers (
  id text PRIMARY KEY,
  started_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL
);

-- Outbox and IAM projection (§8.4, §12.4, §12.8).
CREATE TABLE outbox (
  seq bigserial PRIMARY KEY,
  txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  topic text NOT NULL,
  payload jsonb
);
CREATE TABLE authz_projection (
  type text,
  id text,
  tenant_id text,
  attributes jsonb NOT NULL,
  parent_type text,
  parent_id text,
  owner_id text,
  pending jsonb,
  PRIMARY KEY (type, id, tenant_id)
);
CREATE TABLE iam_inbox (
  event_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  sequence bigint NOT NULL,
  occurred_at timestamptz NOT NULL,
  action text NOT NULL,
  body jsonb NOT NULL,
  received_at timestamptz NOT NULL,
  processed_at timestamptz
);
CREATE INDEX iam_inbox_pending ON iam_inbox (tenant_id, sequence) WHERE processed_at IS NULL;
CREATE TABLE join_tokens (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('node', 'site', 'provisioned', 'discovery')),
  pool_id text,
  site_id text,
  secret_hash bytea NOT NULL,
  uses_left int NOT NULL,
  expect jsonb,
  allow_reclaim bool NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

-- Indexes for the access paths the plan spells out.
CREATE INDEX nodes_pool ON nodes (pool_id);
CREATE INDEX nodes_shard ON nodes (shard);
CREATE INDEX devices_node ON devices (node_id);
CREATE INDEX device_bookings_allocation ON device_bookings (allocation_id);
CREATE INDEX node_sessions_gateway ON node_sessions (gateway_id);
-- Gateway dispatch (§8.5) and the CommandSweeper (§7.4).
CREATE INDEX commands_pending ON commands (node_id, seq) WHERE state = 'pending';
CREATE INDEX commands_open ON commands (not_after)
  WHERE state IN ('pending', 'dispatched', 'acked', 'running');
-- Claims by shard (§8.4) and outbox cursor reads in (txid, seq) order.
CREATE INDEX work_queue_claim ON work_queue (shard, not_before);
CREATE INDEX outbox_cursor ON outbox (txid, seq);
CREATE INDEX reservations_tenant ON reservations (tenant_id, state);
CREATE INDEX reservations_pending ON reservations (pool_id) WHERE state = 'pending';
CREATE INDEX authz_projection_tenant ON authz_projection (tenant_id, type);

-- The projection's change feed (§8.3, §12.4): the outbox (txid, seq) shape, read with its cursor.
CREATE TABLE authz_changes (
  seq bigserial PRIMARY KEY,
  txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  type text NOT NULL,
  id text NOT NULL,
  tenant_id text NOT NULL,
  op text NOT NULL CHECK (op IN ('upsert', 'delete'))
);
CREATE INDEX authz_changes_cursor ON authz_changes (txid, seq);

-- Gateways (§7.1, §8.5): the registry behind routing and doctor's headroom check. Liveness is the
-- gateway:<id> lease; node_sessions.gateway_id routes to these rows.
CREATE TABLE gateways (
  id text PRIMARY KEY,
  region text NOT NULL,
  -- Internal mTLS endpoint the api dials for tunnels and forwarded calls.
  internal_url text NOT NULL,
  software_version text NOT NULL,
  max_streams int NOT NULL CHECK (max_streams > 0),
  sessions int NOT NULL DEFAULT 0,
  draining bool NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL DEFAULT compute_now(),
  heartbeat_at timestamptz NOT NULL DEFAULT compute_now()
);

-- Allocations (§2, §3.4): a placement on one node, owned by a reservation (or an instance, v0.3).
-- device_bookings rows are the exclusivity truth; atoms records what was assigned.
CREATE TABLE allocations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  pool_id text NOT NULL REFERENCES pools,
  node_id text NOT NULL REFERENCES nodes,
  owner_kind text NOT NULL CHECK (owner_kind IN ('reservation', 'instance')),
  owner_id text NOT NULL,
  atoms text[] NOT NULL DEFAULT '{}',
  -- Claimed scalar amounts: {"vcpu": 8, "memoryGiB": 32}.
  resources jsonb NOT NULL DEFAULT '{}',
  during tstzrange NOT NULL CHECK (NOT isempty(during)),
  -- What the node reported in AllocationBound: {"cdiDevices": [...], "envFile": "..."}.
  binding jsonb,
  bound_at timestamptz,
  released_at timestamptz,
  version bigint NOT NULL
);
CREATE INDEX allocations_owner ON allocations (owner_kind, owner_id);
CREATE INDEX allocations_node ON allocations (node_id) WHERE released_at IS NULL;

-- Usage (§12.7): one row per allocation, hourly window and meter, handed to the usage sink.
CREATE TABLE usage_windows (
  -- cmp:<allocId>:<windowStartMs>
  idempotency_key text PRIMARY KEY,
  allocation_id text NOT NULL REFERENCES allocations,
  tenant_id text NOT NULL,
  -- NULL once orphaned (tenant-attributed).
  identity_id text,
  meter text NOT NULL,
  quantity numeric NOT NULL CHECK (quantity >= 0),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  -- Bounded-cardinality tags only: region, pool, gpuModel, project, agent.
  tags jsonb NOT NULL DEFAULT '{}',
  recorded_at timestamptz,
  outcome text CHECK (outcome IN ('recorded', 'duplicate', 'reattributed', 'dead-lettered')),
  CHECK (window_end > window_start),
  UNIQUE (allocation_id, window_start, meter)
);
CREATE INDEX usage_windows_unrecorded ON usage_windows (window_end) WHERE recorded_at IS NULL;
-- Only an event that still fails after bisection and per-event retry lands here.
CREATE TABLE usage_dead_letters (
  idempotency_key text PRIMARY KEY,
  tenant_id text NOT NULL,
  -- The UsageEvent as last sent.
  event jsonb NOT NULL,
  error_code text NOT NULL,
  error_message text NOT NULL,
  attempts int NOT NULL DEFAULT 1 CHECK (attempts > 0),
  first_failed_at timestamptz NOT NULL DEFAULT compute_now(),
  last_failed_at timestamptz NOT NULL DEFAULT compute_now(),
  resolved_at timestamptz
);

-- Node certificates (§3.3, §6, §13): Renew, revocation, and node_sig verification from v0.2.
CREATE TABLE node_certs (
  serial text PRIMARY KEY,
  node_id text NOT NULL REFERENCES nodes,
  role text NOT NULL CHECK (role IN ('node', 'site', 'ramdisk', 'node-tenant')),
  -- nodes.identity_gen when issued; a new identity generation revokes the old certs.
  identity_gen int NOT NULL,
  spki_sha256 bytea NOT NULL,
  der bytea NOT NULL,
  not_before timestamptz NOT NULL,
  not_after timestamptz NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT compute_now(),
  revoked_at timestamptz,
  revocation_reason text,
  CHECK (not_after > not_before)
);
CREATE INDEX node_certs_node ON node_certs (node_id, not_after);
CREATE INDEX node_certs_revoked ON node_certs (revoked_at) WHERE revoked_at IS NOT NULL;

-- Inventory (§10.1): append-only snapshots of NodeInventory v1 by section.
CREATE TABLE inventory_snapshots (
  id text PRIMARY KEY,
  node_id text NOT NULL REFERENCES nodes,
  -- sha256 over the canonical section hashes.
  sha256 bytea NOT NULL,
  -- {"<section>": "<hex sha256>"}
  section_hashes jsonb NOT NULL,
  sections jsonb NOT NULL,
  boot_id text,
  collected_at timestamptz NOT NULL
);
CREATE INDEX inventory_snapshots_node ON inventory_snapshots (node_id, collected_at);

-- Audit (§2, §13): every allowed mutation with its admission context, plus command, step,
-- ticket and security events. No foreign keys: records outlive what they describe.
CREATE TABLE audit_events (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT compute_now(),
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  admission jsonb,
  details jsonb
);
CREATE INDEX audit_events_tenant ON audit_events (tenant_id, occurred_at);
CREATE INDEX audit_events_resource ON audit_events (resource_type, resource_id, occurred_at);

-- Capacity rollups (§10.2, §10.6): updated in the booking transaction, recomputed by the Rollup
-- job, so reads never aggregate devices. A rebuildable cache (P1), hence no CHECKs.
CREATE TABLE pool_capacity_rollup (
  pool_id text REFERENCES pools,
  -- gpu, or a scalar such as vcpu or memoryGiB.
  resource text,
  total bigint NOT NULL DEFAULT 0,
  allocatable bigint NOT NULL DEFAULT 0,
  allocated bigint NOT NULL DEFAULT 0,
  reserved bigint NOT NULL DEFAULT 0,
  provisioning bigint NOT NULL DEFAULT 0,
  unhealthy bigint NOT NULL DEFAULT 0,
  maintenance bigint NOT NULL DEFAULT 0,
  unreachable bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT compute_now(),
  PRIMARY KEY (pool_id, resource)
);
`,
};

/** Every table the base schema creates, in creation order. */
export const baseTables = [
  'compute_sim_clock',
  'sites',
  'pools',
  'pool_offers',
  'projects',
  'nodes',
  'node_labels',
  'node_conditions',
  'node_sessions',
  'devices',
  'device_bookings',
  'node_resources',
  'quota_usage',
  'reservations',
  'commands',
  'work_queue',
  'leases',
  'workers',
  'outbox',
  'authz_projection',
  'iam_inbox',
  'join_tokens',
  'authz_changes',
  'gateways',
  'allocations',
  'usage_windows',
  'usage_dead_letters',
  'node_certs',
  'inventory_snapshots',
  'audit_events',
  'pool_capacity_rollup',
] as const;
