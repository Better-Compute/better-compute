import type { Migration } from '@better-compute/core';
import { clockMigration } from './0001_clock.js';
import { baseMigration } from './0002_base.js';

export { baseTables } from './0002_base.js';

/**
 * The adapter-owned base schema, owner `core`, applied before any module migration. Append-only:
 * a release adds entries and never edits or removes one.
 */
export const baseMigrations: readonly Migration[] = Object.freeze([clockMigration, baseMigration]);

/** `compute_schema_version.version` after the base schema is applied: one per base migration. */
export const baseSchemaVersion = baseMigrations.length;
