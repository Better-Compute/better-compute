import type { DeviceRequest } from '@better-compute/core';
import { formatSelector } from './selector.js';

// What a person asked to confirm an agent's request reads (§3.4 step 7, `MethodAdmission.describe`):
// every parameter that changes what is booked or for how long, on one or two short lines. The
// envelope binds the approval to this text, so it is deterministic (no clock, no DB) and complete.
// Caller-supplied text is clipped and stripped of control characters: it must not forge lines.

/** Caller text made safe for a one-line approval prompt: printable, single-line, short. */
export function clip(text: string, max = 64): string {
  const flat = [...text]
    .map((char) => (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(char) ? ' ' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const hour = 3_600_000;

/** `90m` as `1.5h`, `30s` as `0.5m`: short and exact enough for an approval. */
export function formatDuration(ms: number): string {
  if (ms % (24 * hour) === 0) return `${ms / (24 * hour)}d`;
  if (ms >= hour) return `${Math.round((ms / hour) * 100) / 100}h`;
  if (ms >= 60_000) return `${Math.round((ms / 60_000) * 100) / 100}m`;
  return `${Math.round(ms / 1000)}s`;
}

const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

function describeDevice(device: DeviceRequest): string {
  const extras = [
    device.selector ? clip(formatSelector(device.selector), 80) : '',
    device.sharing ? String(device.sharing) : '',
    device.topology ? String(device.topology) : '',
  ].filter(Boolean);
  return `${device.count}× ${device.class}${extras.length ? ` (${extras.join('; ')})` : ''}`;
}

/** `reservations.create`: pool, devices, duration and start, plus whatever changes the booking. */
export function describeCreateReservation(input: {
  poolId: string;
  projectId?: string;
  devices: readonly DeviceRequest[];
  topology?: string;
  start?: number;
  duration: number;
  binding?: string;
  node?: { profileId: string; profileVersion?: number };
  leaseSeconds?: number;
  gang?: { size: number; topologyKey?: string };
  spot?: boolean;
}): string {
  const parts = [
    `pool ${clip(input.poolId)}`,
    input.devices.length ? input.devices.map(describeDevice).join(', ') : 'no devices',
    `for ${formatDuration(input.duration)} from ${input.start === undefined ? 'now' : iso(input.start)}`,
  ];
  if (input.gang)
    parts.push(
      `gang of ${input.gang.size} nodes${input.gang.topologyKey ? ` sharing ${clip(input.gang.topologyKey)}` : ''}`,
    );
  if (input.topology && input.topology !== 'any') parts.push(`topology ${clip(input.topology)}`);
  if (input.binding === 'node')
    parts.push(
      `whole node, profile ${clip(input.node?.profileId ?? '?')}${
        input.node?.profileVersion !== undefined ? ` v${input.node.profileVersion}` : ''
      }`,
    );
  if (input.spot) parts.push('spot (preemptible)');
  if (input.leaseSeconds !== undefined) parts.push(`lease ${input.leaseSeconds}s`);
  if (input.projectId) parts.push(`project ${clip(input.projectId)}`);
  return clip(`reservations.create: ${parts.join('; ')}`, 480);
}

/** `reservations.extend`, after `prepare` resolved `by` into the absolute `until`. */
export function describeExtendReservation(input: {
  reservationId: string;
  until?: number;
  by?: number;
}): string {
  const to =
    input.until !== undefined ? `until ${iso(input.until)}` : `by ${formatDuration(input.by ?? 0)}`;
  return `reservations.extend: ${clip(input.reservationId)} ${to}`;
}
