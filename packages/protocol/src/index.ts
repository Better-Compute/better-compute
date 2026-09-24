/**
 * Wire contracts between `bcd` and the better-compute control plane, generated from
 * `proto/bettercompute` by protoc-gen-es (`node scripts/proto-gen.mjs`), plus small helpers.
 * Browser-safe: depends only on `@bufbuild/protobuf`.
 *
 * `agent/v1` and `common/v1` are frozen (additive changes only). `site` and `driver` are drafts,
 * exported as namespaces, and may change until v0.2 and v0.5.
 */
import { createRegistry } from '@bufbuild/protobuf';
import { file_bettercompute_common_v1_common } from './gen/bettercompute/common/v1/common_pb.js';
import { file_bettercompute_agent_v1_session } from './gen/bettercompute/agent/v1/session_pb.js';
import { file_bettercompute_agent_v1_inventory } from './gen/bettercompute/agent/v1/inventory_pb.js';
import { file_bettercompute_agent_v1_commands } from './gen/bettercompute/agent/v1/commands_pb.js';
import { file_bettercompute_site_v1_site } from './gen/bettercompute/site/v1/site_pb.js';
import { file_bettercompute_driver_v1_driver } from './gen/bettercompute/driver/v1/driver_pb.js';

export * from './gen/bettercompute/common/v1/common_pb.js';
export * from './gen/bettercompute/agent/v1/session_pb.js';
export * from './gen/bettercompute/agent/v1/inventory_pb.js';
export * from './gen/bettercompute/agent/v1/commands_pb.js';
/** DRAFT, unstable until v0.2: site agent payloads (`bettercompute.site.v1`). */
export * as site from './gen/bettercompute/site/v1/site_pb.js';
/** DRAFT, unstable until v0.5: the bcx driver plugin protocol (`bettercompute.driver.v1`). */
export * as driver from './gen/bettercompute/driver/v1/driver_pb.js';

export * from './errors.js';
export * from './frames.js';
export * from './kinds.js';
export * from './sections.js';
export * from './signing.js';
export * from './version.js';

/**
 * Every message, enum and service of the better-compute protos, for `google.protobuf.Any`
 * payloads and JSON (`toJson(schema, message, { registry: protocolRegistry })`).
 */
export const protocolRegistry = /*@__PURE__*/ createRegistry(
  file_bettercompute_common_v1_common,
  file_bettercompute_agent_v1_session,
  file_bettercompute_agent_v1_inventory,
  file_bettercompute_agent_v1_commands,
  file_bettercompute_site_v1_site,
  file_bettercompute_driver_v1_driver,
);
