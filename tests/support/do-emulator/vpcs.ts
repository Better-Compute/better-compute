import { createHash } from 'node:crypto';
import type { DoEmulator } from './index.js';
import { fixture, type DoState, type Json } from './state.js';

// VPCs, as far as Droplet creation needs them: `GET /v2/vpcs` (paged) over `state.vpcs`, and a
// seed. Each region also has a default VPC, which a Droplet created without `vpc_uuid` joins;
// it is made on first use. (P1 Task 8 adds the rest of the VPC endpoints.)

/** The shape of a `vpc` body, from the fixture. */
const template = fixture('vpcs').vpc as Json;

/** A uuid-shaped id derived from a seed, so the emulator's ids are stable across runs. */
function uuidFrom(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Puts a VPC in the account; returns the stored resource. */
export function seedVpc(
  state: DoState,
  vpc: { name: string; region: string; ip_range?: string; default?: boolean; id?: string },
): Json {
  const id = vpc.id ?? uuidFrom(`vpc:${vpc.name}:${vpc.region}`);
  const stored: Json = {
    ...structuredClone(template),
    id,
    urn: `do:vpc:${id}`,
    name: vpc.name,
    description: '',
    region: vpc.region,
    ip_range: vpc.ip_range ?? `10.${10 + state.vpcs.size}.0.0/20`,
    default: vpc.default ?? false,
  };
  state.vpcs.set(id, stored);
  return stored;
}

/** The region's default VPC, made on first use. */
export function defaultVpc(state: DoState, region: string): Json {
  for (const vpc of state.vpcs.values()) if (vpc.region === region && vpc.default) return vpc;
  return seedVpc(state, { name: `default-${region}`, region, default: true });
}

export function registerVpcs(emulator: DoEmulator): void {
  emulator.route('GET', /^\/vpcs$/, (context) =>
    emulator.paged(context, 'vpcs', [...context.state.vpcs.values()]),
  );
}
