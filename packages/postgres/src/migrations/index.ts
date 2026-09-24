import type { Migration } from '@better-compute/core';
import { clockMigration } from './0001_clock.js';
import { baseMigration, baseTables as base0002Tables } from './0002_base.js';
import { v01Migration, v01Tables } from './0003_v01.js';

/** Every table the base schema creates, in creation order. */
export const baseTables = Object.freeze([...base0002Tables, ...v01Tables]);

/**
 * The adapter-owned base schema, owner `core`, applied before any module migration. Append-only:
 * a release adds entries and never edits or removes one.
 */
export const baseMigrations: readonly Migration[] = Object.freeze([
  clockMigration,
  baseMigration,
  v01Migration,
]);

/** `compute_schema_version.version` after the base schema is applied: one per base migration. */
export const baseSchemaVersion = baseMigrations.length;
