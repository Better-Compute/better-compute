import type { Migration } from '@better-compute/core';
import { clockMigration } from './0001_clock.js';
import { baseMigration, baseTables as base0002Tables } from './0002_base.js';
import { v01Migration, v01Tables } from './0003_v01.js';
import { commandCancelMigration } from './0004_command_cancel.js';
import { auditCommitOrderMigration } from './0005_audit_commit_order.js';
import { poolArchiveMigration } from './0006_pool_archive.js';
import { deviceHealthMigration, deviceHealthTables } from './0007_device_health.js';
import { sessionVersionsMigration } from './0008_session_versions.js';
import { runtimeMigration, runtimeTables } from './0009_runtime.js';
import { v02ServerMigration, v02ServerTables } from './0010_v02_server.js';
import { v02SecurityMigration, v02SecurityTables } from './0011_v02_security.js';
import { v02EvidenceMigration, v02EvidenceTables } from './0012_v02_evidence.js';

/** Every table the base schema creates, in creation order. */
export const baseTables = Object.freeze([...base0002Tables, ...v01Tables, ...deviceHealthTables, ...runtimeTables, ...v02ServerTables, ...v02SecurityTables, ...v02EvidenceTables]);

/**
 * The adapter-owned base schema, owner `core`, applied before any module migration. Append-only:
 * a release adds entries and never edits or removes one.
 */
export const baseMigrations: readonly Migration[] = Object.freeze([
  clockMigration,
  baseMigration,
  v01Migration,
  commandCancelMigration,
  auditCommitOrderMigration,
  poolArchiveMigration,
  deviceHealthMigration,
  sessionVersionsMigration,
  runtimeMigration,
  v02ServerMigration,
  v02SecurityMigration,
  v02EvidenceMigration,
]);

/** `compute_schema_version.version` after the base schema is applied: one per base migration. */
export const baseSchemaVersion = baseMigrations.length;
