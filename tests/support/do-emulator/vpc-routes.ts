import { isoSeconds } from './actions.js';
import type { DoEmulator, RouteResult } from './index.js';
import type { DoState, Json } from './state.js';
import { uuidFrom } from './vpcs.js';

// VPC routes under `/v2/vpcs/{vpc}/routes` (VPC Routes are a DO public preview; the shape here is
// this emulator's assumption, unverified: id, name, vpc_uuid, destination, next_hop { type
// nat_gateway | droplet | ip, id | ip }, status PENDING/ACTIVE, created_at). Create (201), list
// (paged) and delete (204). A new route is `PENDING` for `emulator.routeReads` list reads, then
// `ACTIVE`. Two routes of one VPC to the same destination are a 422. A VPC that still holds a
// route can't be deleted (the VPC emulator answers its `409-vpc-in-use`).

function unprocessable(message: string): RouteResult {
  return {
    status: 422,
    body: { id: 'unprocessable_entity', message, request_id: 'emulated-route' },
  };
}

const progress = new WeakMap<DoState, Map<string, number>>();

function progressOf(state: DoState): Map<string, number> {
  let map = progress.get(state);
  if (!map) {
    map = new Map();
    progress.set(state, map);
  }
  return map;
}

/** A route of a VPC, if any (the VPC emulator refuses to delete it). */
export function routeOf(state: DoState, vpcId: string): Json | undefined {
  return [...state.vpcRoutes.values()].find((route) => route.vpc_uuid === vpcId);
}

/** Puts a route in a VPC, as if made out of band; returns the stored resource. */
export function seedRoute(state: DoState, seed: Json): Json {
  const id = seed.id ?? uuidFrom(`route:${state.nextId()}`);
  const route = { status: 'ACTIVE', created_at: isoSeconds(state.now()), ...seed, id };
  state.vpcRoutes.set(id, route);
  return route;
}

export function registerVpcRoutes(emulator: DoEmulator): void {
  emulator.route('GET', /^\/vpcs\/([^/]+)\/routes$/, (context) => {
    const { state } = context;
    const vpc = decodeURIComponent(context.match[1]!);
    if (!state.vpcs.has(vpc)) return emulator.error('not-found');
    const routes = [...state.vpcRoutes.values()].filter((route) => route.vpc_uuid === vpc);
    for (const route of routes) {
      const left = progressOf(state).get(route.id);
      if (left === undefined) continue;
      if (left > 1) progressOf(state).set(route.id, left - 1);
      else {
        progressOf(state).delete(route.id);
        route.status = 'ACTIVE';
      }
    }
    return emulator.paged(
      context,
      'routes',
      routes.map((route) => structuredClone(route)),
    );
  });
  emulator.route('POST', /^\/vpcs\/([^/]+)\/routes$/, (context) => {
    const { state } = context;
    const vpc = decodeURIComponent(context.match[1]!);
    if (!state.vpcs.has(vpc)) return emulator.error('not-found');
    const body = context.body ?? {};
    const hop = body.next_hop ?? {};
    if (typeof body.name !== 'string' || typeof body.destination !== 'string')
      return unprocessable('name and destination are required');
    if (!['nat_gateway', 'droplet', 'ip'].includes(hop.type))
      return unprocessable('next_hop.type must be nat_gateway, droplet or ip');
    if (
      [...state.vpcRoutes.values()].some(
        (route) => route.vpc_uuid === vpc && route.destination === body.destination,
      )
    )
      return unprocessable('a route to this destination already exists in the VPC');
    const route = seedRoute(state, {
      name: body.name,
      vpc_uuid: vpc,
      destination: body.destination,
      next_hop: structuredClone(hop),
      status: emulator.routeReads > 0 ? 'PENDING' : 'ACTIVE',
    });
    if (emulator.routeReads > 0) progressOf(state).set(route.id, emulator.routeReads);
    return { status: 201, body: { route: structuredClone(route) } };
  });
  emulator.route('DELETE', /^\/vpcs\/([^/]+)\/routes\/([^/]+)$/, (context) => {
    const { state } = context;
    const vpc = decodeURIComponent(context.match[1]!);
    const id = decodeURIComponent(context.match[2]!);
    const route = state.vpcRoutes.get(id);
    if (!route || route.vpc_uuid !== vpc) return emulator.error('not-found');
    state.vpcRoutes.delete(id);
    progressOf(state).delete(id);
    return { status: 204 };
  });
}
