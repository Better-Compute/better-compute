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
import { imageCacheMigration, imageCacheTables } from './0013_image_cache.js';
import { sshCertificatesMigration, sshCertificatesTables } from './0014_ssh_certificates.js';
import { inventoryImagesMigration } from './0015_inventory_images.js';
import { duplicateIdentityMigration } from './0016_duplicate_identity.js';
import { allocationEvidenceMigration } from './0017_allocation_evidence.js';
import { partitionedHistoryMigration } from './0018_partitioned_history.js';

/**
 * Every table the base schema creates, in creation order. Partitions of the history tables
 * (core/0018: `<table>_default`, `<table>_pYYYYMM`) are not listed; `historyPartitions` reads them.
 */
export const baseTables = Object.freeze([...base0002Tables, ...v01Tables, ...deviceHealthTables, ...runtimeTables, ...v02ServerTables, ...v02SecurityTables, ...v02EvidenceTables, ...imageCacheTables, ...sshCertificatesTables]);

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
  imageCacheMigration,
  sshCertificatesMigration,
  inventoryImagesMigration,
  duplicateIdentityMigration,
  allocationEvidenceMigration,
  partitionedHistoryMigration,
]);

/** `compute_schema_version.version` after the base schema is applied: one per base migration. */
export const baseSchemaVersion = baseMigrations.length;
