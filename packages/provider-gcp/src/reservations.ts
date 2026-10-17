import { isComputeError, type ExternalReservation } from '@better-compute/core';
import type { GceClient } from './client.js';
import { offerId } from './ids.js';
import {
  gpuModel,
  gpusOfType,
  lastSegment,
  regionOf,
  shapeFromName,
  shapeOf,
  type GceMachineType,
} from './shapes.js';

// Capacity reservations as ExternalReservation: on-demand reservations (own and shared in) and
// future reservations that are still to be fulfilled. A reservation's vCPU and memory come from its
// machine type; 0 means the type could not be read and its name does not say.

interface InstanceProperties {
  machineType?: string;
  guestAccelerators?: { acceleratorType?: string; acceleratorCount?: number }[];
  localSsds?: { diskSizeGb?: string | number }[];
}

interface ReservationResource {
  name: string;
  zone: string;
  selfLink?: string;
  status?: string;
  specificReservation?: {
    count?: string | number;
    inUseCount?: string | number;
    instanceProperties?: InstanceProperties;
    sourceInstanceTemplate?: string;
  };
  specificReservationRequired?: boolean;
  shareSettings?: { shareType?: string };
  deleteAtTime?: string;
}

interface FutureReservationResource {
  name: string;
  zone: string;
  selfLink?: string;
  status?: { procurementStatus?: string };
  specificSkuProperties?: {
    totalCount?: string | number;
    instanceProperties?: InstanceProperties;
    sourceInstanceTemplate?: string;
  };
  specificReservationRequired?: boolean;
  shareSettings?: { shareType?: string };
  timeWindow?: {
    startTime?: string;
    endTime?: string;
    duration?: { seconds?: string | number; nanos?: number };
  };
}

interface InstanceTemplate {
  properties?: {
    machineType?: string;
    guestAccelerators?: InstanceProperties['guestAccelerators'];
    disks?: { type?: string; diskSizeGb?: string | number }[];
  };
}

export interface ReservationSource {
  client: GceClient;
  projectId: string;
  zones: readonly string[];
  /** A machine type's resource, if it can be read. */
  machineType(zone: string, name: string, signal: AbortSignal): Promise<GceMachineType | undefined>;
}

const reservationStates: Record<string, ExternalReservation['state']> = {
  CREATING: 'creating',
  READY: 'ready',
  UPDATING: 'updating',
  DELETING: 'deleting',
};

const futureScheduled = new Set([
  'PENDING_APPROVAL',
  'APPROVED',
  'PROCURING',
  'PROVISIONING',
  'PENDING_AMENDMENT_APPROVAL',
]);
// Future reservations that are not waiting for capacity and are not failures: fulfilled ones show
// up as on-demand reservations, the others were cancelled or never submitted.
const futureIgnored = new Set(['FULFILLED', 'CANCELLED', 'DRAFTING']);

const int = (value: string | number | undefined): number => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

/** The project a reservation belongs to, from its selfLink (undefined when the link is absent). */
function ownerOf(selfLink: string | undefined): string | undefined {
  return selfLink ? /\/projects\/([^/]+)\//.exec(selfLink)?.[1] : undefined;
}

async function templateProperties(
  source: ReservationSource,
  template: string,
  signal: AbortSignal,
): Promise<InstanceProperties | undefined> {
  const path = /(\/projects\/[^/]+\/(?:global|regions\/[^/]+)\/instanceTemplates\/[^/?]+)/.exec(
    template,
  )?.[1];
  const relative = path ?? (template.startsWith('global/') ? `/${template}` : undefined);
  if (!relative) return undefined;
  try {
    const found = await source.client.request<InstanceTemplate>('GET', relative, { signal });
    const properties = found.properties;
    if (!properties) return undefined;
    const scratch = (properties.disks ?? []).filter((disk) => disk.type === 'SCRATCH');
    return {
      machineType: properties.machineType,
      guestAccelerators: properties.guestAccelerators,
      localSsds: scratch.map((disk) => ({ diskSizeGb: disk.diskSizeGb ?? 375 })),
    };
  } catch (error) {
    // A template that is gone or not readable leaves the reservation without a shape: skip it.
    if (signal.aborted || !isComputeError(error)) throw error;
    if (error.code === 'NOT_FOUND' || error.code === 'ACCESS_DENIED') return undefined;
    throw error;
  }
}

interface Mapped {
  id: string;
  suffix: string;
  shared: boolean;
}

/** Identity of a reservation: own ones are `zone/name`, ones shared in carry their owner. */
function identity(
  source: ReservationSource,
  zone: string,
  name: string,
  selfLink: string | undefined,
  shareType: string | undefined,
): Mapped {
  const owner = ownerOf(selfLink);
  const foreign = owner !== undefined && owner !== source.projectId;
  return {
    id: foreign ? `projects/${owner}/zones/${zone}/reservations/${name}` : `${zone}/${name}`,
    suffix: foreign ? `projects/${owner}/reservations/${name}` : name,
    shared: shareType !== undefined && shareType !== 'LOCAL',
  };
}

async function shapeOfReservation(
  source: ReservationSource,
  zone: string,
  properties: InstanceProperties | undefined,
  signal: AbortSignal,
): Promise<
  | Pick<ExternalReservation, 'machineType' | 'vcpu' | 'memoryGiB' | 'gpus' | 'localSsdGiB'>
  | undefined
> {
  if (!properties?.machineType) return undefined;
  const machineType = lastSegment(properties.machineType);
  const type = await source.machineType(zone, machineType, signal);
  const shape = type ? shapeOf(type) : shapeFromName(machineType);
  const accelerator = properties.guestAccelerators?.find((entry) => entry.acceleratorType);
  const gpus = accelerator
    ? {
        model: gpuModel(accelerator.acceleratorType!),
        count: properties.guestAccelerators!.reduce(
          (sum, entry) => sum + (entry.acceleratorCount ?? 0),
          0,
        ),
      }
    : type
      ? gpusOfType(type)
      : undefined;
  const localSsdGiB = (properties.localSsds ?? []).reduce(
    (sum, disk) => sum + int(disk.diskSizeGb),
    0,
  );
  return {
    machineType,
    vcpu: shape?.vcpu ?? 0,
    memoryGiB: shape?.memoryGiB ?? 0,
    ...(gpus ? { gpus } : {}),
    ...(localSsdGiB > 0 ? { localSsdGiB } : {}),
  };
}

/** On-demand reservations in the account's zones. */
async function onDemand(
  source: ReservationSource,
  signal: AbortSignal,
): Promise<ExternalReservation[]> {
  const out: ExternalReservation[] = [];
  for await (const reservation of source.client.aggregated<ReservationResource>(
    '/aggregated/reservations',
    'reservations',
    { signal },
  )) {
    const zone = lastSegment(reservation.zone);
    if (!source.zones.includes(zone)) continue;
    const specific = reservation.specificReservation;
    let properties = specific?.instanceProperties;
    if (!properties && specific?.sourceInstanceTemplate)
      properties = await templateProperties(source, specific.sourceInstanceTemplate, signal);
    const shape = await shapeOfReservation(source, zone, properties, signal);
    if (!shape) continue;
    const { id, suffix, shared } = identity(
      source,
      zone,
      reservation.name,
      reservation.selfLink,
      reservation.shareSettings?.shareType,
    );
    const mapped: ExternalReservation = {
      id,
      name: reservation.name,
      zone,
      region: regionOf(zone),
      state: reservationStates[reservation.status ?? ''] ?? 'error',
      ...shape,
      total: int(specific?.count),
      inUse: int(specific?.inUseCount),
      specificOnly: reservation.specificReservationRequired === true,
      shared,
      offerId: offerId(zone, shape.machineType, suffix),
    };
    const endsAt = reservation.deleteAtTime ? Date.parse(reservation.deleteAtTime) : NaN;
    if (Number.isFinite(endsAt)) mapped.endsAt = endsAt;
    out.push(mapped);
  }
  return out;
}

/** Future reservations that are waiting to be fulfilled. */
async function future(
  source: ReservationSource,
  signal: AbortSignal,
): Promise<ExternalReservation[]> {
  const out: ExternalReservation[] = [];
  for await (const reservation of source.client.aggregated<FutureReservationResource>(
    '/aggregated/futureReservations',
    'futureReservations',
    { signal },
  )) {
    const zone = lastSegment(reservation.zone);
    if (!source.zones.includes(zone)) continue;
    const procurement = reservation.status?.procurementStatus ?? '';
    if (futureIgnored.has(procurement)) continue;
    const sku = reservation.specificSkuProperties;
    let properties = sku?.instanceProperties;
    if (!properties && sku?.sourceInstanceTemplate)
      properties = await templateProperties(source, sku.sourceInstanceTemplate, signal);
    const shape = await shapeOfReservation(source, zone, properties, signal);
    if (!shape) continue;
    const { id, suffix, shared } = identity(
      source,
      zone,
      reservation.name,
      reservation.selfLink,
      reservation.shareSettings?.shareType,
    );
    const mapped: ExternalReservation = {
      id: `future:${id}`,
      name: reservation.name,
      zone,
      region: regionOf(zone),
      state: futureScheduled.has(procurement) ? 'scheduled' : 'error',
      ...shape,
      total: int(sku?.totalCount),
      inUse: 0,
      specificOnly: reservation.specificReservationRequired === true,
      shared,
      offerId: offerId(zone, shape.machineType, suffix),
    };
    const window = reservation.timeWindow;
    const startsAt = window?.startTime ? Date.parse(window.startTime) : NaN;
    if (Number.isFinite(startsAt)) mapped.startsAt = startsAt;
    const endTime = window?.endTime ? Date.parse(window.endTime) : NaN;
    if (Number.isFinite(endTime)) mapped.endsAt = endTime;
    else if (Number.isFinite(startsAt) && window?.duration)
      mapped.endsAt =
        startsAt +
        int(window.duration.seconds) * 1000 +
        Math.floor((window.duration.nanos ?? 0) / 1e6);
    out.push(mapped);
  }
  return out;
}

/** Every on-demand and still-pending future reservation in the account's zones, by id. */
export async function readReservations(
  source: ReservationSource,
  signal: AbortSignal,
): Promise<ExternalReservation[]> {
  const all = [...(await onDemand(source, signal)), ...(await future(source, signal))];
  return all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
