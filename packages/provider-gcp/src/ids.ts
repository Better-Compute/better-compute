import { createHash } from 'node:crypto';
import { ComputeError } from '@better-compute/core';

/** The labels better-compute puts on the VMs it manages. */
export const labels = {
  managed: 'better-compute-managed',
  instance: 'better-compute-instance',
  tenant: 'better-compute-tenant',
  pool: 'better-compute-pool',
  owner: 'better-compute-owner',
} as const;

const zonePattern = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;

/** A machine's id: `zone/name`. */
export function machineId(zone: string, name: string): string {
  return `${zone}/${name}`;
}

/** Splits a machine id; anything that is not `zone/name` is `INVALID_INPUT`. */
export function parseMachineId(id: string): { zone: string; name: string } {
  const parts = id.split('/');
  const [zone, name] = parts;
  if (parts.length !== 2 || !zone || !name || !zonePattern.test(zone) || !zonePattern.test(name))
    throw new ComputeError('INVALID_INPUT', `${JSON.stringify(id)} is not a GCE machine id`);
  return { zone, name };
}

/** An offer's id: `zone/machineType`, plus `@reservation` for capacity held by a reservation. */
export function offerId(zone: string, machineType: string, reservation?: string): string {
  return reservation ? `${zone}/${machineType}@${reservation}` : `${zone}/${machineType}`;
}

/** Splits an offer id; anything that is not an offer id is `INVALID_INPUT`. */
export function parseOfferId(id: string): {
  zone: string;
  machineType: string;
  reservation?: string;
} {
  const slash = id.indexOf('/');
  const zone = slash > 0 ? id.slice(0, slash) : '';
  const rest = slash > 0 ? id.slice(slash + 1) : '';
  const at = rest.indexOf('@');
  const machineType = at >= 0 ? rest.slice(0, at) : rest;
  const reservation = at >= 0 ? rest.slice(at + 1) : undefined;
  if (
    !zonePattern.test(zone) ||
    !/^[a-z][-_a-z0-9]*$/.test(machineType) ||
    (reservation !== undefined && reservation === '')
  )
    throw new ComputeError('INVALID_INPUT', `${JSON.stringify(id)} is not a GCE offer id`);
  return reservation === undefined ? { zone, machineType } : { zone, machineType, reservation };
}

/** A VM name: `bc-` plus the lowercased instance id, `[a-z0-9-]`, at most 63 characters. */
export function instanceName(instanceId: string): string {
  const cleaned = instanceId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '');
  return `bc-${cleaned}`.slice(0, 63).replace(/-+$/, '');
}

/** A label value: lowercase `[a-z0-9_-]`, at most 63 characters. */
export function labelValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .slice(0, 63);
}

const namespace = Buffer.from('b7c1a3e2f4d54e6a8b9c0d1e2f3a4b5c', 'hex');

/** The GCE `requestId` for an idempotency key: a UUIDv5 over a fixed namespace, stable per key. */
export function requestIdFor(idempotencyKey: string): string {
  const hash = createHash('sha1').update(namespace).update(idempotencyKey).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
