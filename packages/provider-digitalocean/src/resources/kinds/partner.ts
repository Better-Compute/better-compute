import {
  ComputeError,
  field,
  isComputeError,
  manifest,
  type CallContext,
  type ProviderResourceRequest,
  type ProviderResourceState,
  type SecretRef,
} from '@better-compute/core';
import {
  found,
  replaceRequired,
  scrubbing,
  strings,
  type DoKind,
  type DoKindEnv,
} from '../kind.js';

// Partner Network Connect (`do.partner-attachment`): a private interconnect between VPCs of the account and a
// network-as-a-service partner (Megaport and the like). It joins account VPCs to an outside network, so it exists
// only on the tenant's own account (`accountScope: 'tenant'`); on a shared account it is refused before any call.
// No tags: ownership is the name suffix `-bc<deployment hash>`. The service key (what the partner portal takes) and
// the BGP auth key are secret outputs; a BGP auth key the tenant chooses is a SecretRef, resolved just before the
// create. Only the attached VPCs change in place. Shapes follow the API reference (partner_network_connect), not a
// recording: the live suite captures real bodies before release.

export const partnerKindName = 'do.partner-attachment';
/** One per attachment per hour while it exists (DigitalOcean bills it by its bandwidth). */
export const partnerHoursMeter = 'do.partner-attachment.hours';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ipv4Cidr = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
const ownSuffix = /-bc([0-9a-f]{12})$/;

export interface PartnerSpec {
  region: string;
  bandwidthMbps: '1000' | '2000' | '5000' | '10000';
  naasProvider: string;
  vpcs: string[];
  localRouterIp?: string;
  peerRouterIp?: string;
  peerRouterAsn?: number;
  bgpAuthKey?: SecretRef;
}

interface DoAttachment {
  id: string;
  name: string;
  state?: string;
  region: string;
  connection_bandwidth_in_mbps: number;
  naas_provider: string;
  vpc_ids?: string[] | null;
  bgp?: { local_router_ip?: string; peer_router_ip?: string; peer_router_asn?: number } | null;
  created_at?: string;
}

const deploymentHash = (env: DoKindEnv) =>
  env.deploymentTag.slice(env.deploymentTag.indexOf(':') + 1);

function owned(env: DoKindEnv, attachment: DoAttachment): void {
  const match = ownSuffix.exec(attachment.name ?? '');
  if (!match || match[1] !== deploymentHash(env))
    throw new ComputeError(
      'INVALID_STATE',
      `Partner attachment ${attachment.id} is not managed by this better-compute deployment; it is left alone`,
      undefined,
      { provider: 'digitalocean', reason: 'notManaged' },
    );
}

function status(value: string | undefined): ProviderResourceState['state'] {
  switch ((value ?? '').toUpperCase()) {
    case 'ACTIVE':
      return 'ready';
    case 'DELETING':
      return 'deleting';
    case 'ERROR':
    case 'FAILED':
      return 'error';
    default:
      return 'pending';
  }
}

const base = '/partner_network_connect/attachments';
const path = (id: string) => `${base}/${encodeURIComponent(id)}`;

async function read(env: DoKindEnv, id: string, signal: AbortSignal) {
  const reply = await found(() =>
    env.client.request<{ partner_attachment: DoAttachment }>('GET', path(id), {
      signal,
      budget: 'observe',
    }),
  );
  return reply?.partner_attachment;
}

async function byName(env: DoKindEnv, name: string, context: CallContext) {
  for await (const attachment of env.client.pages<DoAttachment>(base, 'partner_attachments', {
    signal: context.signal,
    budget: 'observe',
  }))
    if (attachment.name === name) return attachment;
  return undefined;
}

/** A key the attachment answers once it is active; undefined while it has none. */
async function key(
  env: DoKindEnv,
  id: string,
  which: 'service_key' | 'bgp_auth_key',
  signal: AbortSignal,
): Promise<string | undefined> {
  const reply = await found(() =>
    env.client.request<Record<string, { value?: string } | undefined>>(
      'GET',
      `${path(id)}/${which}`,
      { signal, budget: 'observe' },
    ),
  );
  const value = reply?.[which]?.value;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

function specOf(attachment: DoAttachment): Record<string, unknown> {
  return {
    region: attachment.region,
    bandwidthMbps: String(attachment.connection_bandwidth_in_mbps),
    naasProvider: attachment.naas_provider,
    vpcs: [...(attachment.vpc_ids ?? [])],
    ...(attachment.bgp?.local_router_ip ? { localRouterIp: attachment.bgp.local_router_ip } : {}),
    ...(attachment.bgp?.peer_router_ip ? { peerRouterIp: attachment.bgp.peer_router_ip } : {}),
    ...(attachment.bgp?.peer_router_asn ? { peerRouterAsn: attachment.bgp.peer_router_asn } : {}),
  };
}

async function state(
  env: DoKindEnv,
  attachment: DoAttachment,
  signal: AbortSignal,
): Promise<ProviderResourceState> {
  const phase = status(attachment.state);
  const secrets: Record<string, string> = {};
  if (phase === 'ready') {
    const service = await key(env, attachment.id, 'service_key', signal);
    const bgp = await key(env, attachment.id, 'bgp_auth_key', signal);
    if (service) secrets.serviceKey = service;
    if (bgp) secrets.bgpAuthKey = bgp;
  }
  return {
    id: attachment.id,
    state: phase,
    ...(phase === 'error' ? { message: `The attachment is ${attachment.state}` } : {}),
    outputs: strings({
      status: attachment.state,
      region: attachment.region,
      naasProvider: attachment.naas_provider,
      bandwidthMbps: attachment.connection_bandwidth_in_mbps,
    }),
    ...(Object.keys(secrets).length > 0 ? { secretOutputs: secrets } : {}),
    usage: { [partnerHoursMeter]: 1 },
    spec: specOf(attachment),
  };
}

function assertTenantAccount(request: Pick<ProviderResourceRequest, 'accountScope'>): void {
  if (request.accountScope !== 'tenant')
    throw new ComputeError(
      'INVALID_INPUT',
      `${partnerKindName} joins account VPCs to an outside network; only the tenant's own account may have one`,
      undefined,
      { provider: 'digitalocean', reason: 'accountWide', fields: ['vpcs'] },
    );
}

export function partnerKind(): DoKind {
  const what = (id: string) => `Partner attachment ${id}`;
  return {
    definition: {
      kind: partnerKindName,
      family: 'network',
      description:
        'A DigitalOcean Partner Network Connect attachment (tenant-owned accounts only); its keys are sealed',
      spec: manifest({
        region: field.string({ pattern: /^[a-z]{3}[0-9]$/ }).describe('Region slug, e.g. nyc3'),
        bandwidthMbps: field
          .option(['1000', '2000', '5000', '10000'])
          .describe('Connection bandwidth in Mbps'),
        naasProvider: field
          .string({ pattern: /^[A-Z0-9_]{2,32}$/ })
          .describe('The partner, e.g. MEGAPORT'),
        vpcs: field
          .list(field.string({ pattern: uuid }), { min: 1, max: 10 })
          .describe("VPCs of the tenant's own account to attach (uuids)"),
        localRouterIp: field
          .string({ pattern: ipv4Cidr })
          .optional()
          .describe('BGP: the DigitalOcean side, e.g. 169.254.0.1/29'),
        peerRouterIp: field
          .string({ pattern: ipv4Cidr })
          .optional()
          .describe('BGP: the partner side, e.g. 169.254.0.6/29'),
        peerRouterAsn: field
          .int({ min: 1, max: 4_294_967_295 })
          .optional()
          .describe('BGP: the partner ASN'),
        bgpAuthKey: field.secret().optional().describe('BGP: an auth key you choose (a SecretRef)'),
      }),
      outputs: ['status', 'region', 'naasProvider', 'bandwidthMbps'],
      secretOutputs: ['serviceKey', 'bgpAuthKey'],
      regional: true,
      updatable: ['vpcs'],
      meters: [{ meter: partnerHoursMeter, unit: 'hour' }],
      // It joins account VPCs to an outside network: the tenant's own account only, whatever the spec.
      accountWide: () => ['vpcs'],
    },

    async ensure(env, request, context) {
      assertTenantAccount(request);
      const wanted = request.spec as PartnerSpec;
      const name = `${request.name}-bc${deploymentHash(env)}`;
      let attachment: DoAttachment | undefined;
      if (request.id !== undefined) {
        attachment = await read(env, request.id, context.signal);
        if (!attachment)
          return {
            id: request.id,
            state: 'error',
            message: `${what(request.id)} is gone at DigitalOcean`,
          };
        owned(env, attachment);
      } else attachment = await byName(env, name, context);
      if (!attachment) {
        const authKey = wanted.bgpAuthKey
          ? await context.secrets.resolve(wanted.bgpAuthKey)
          : undefined;
        const bgp =
          wanted.localRouterIp || wanted.peerRouterIp || wanted.peerRouterAsn || authKey
            ? {
                bgp: {
                  ...(wanted.localRouterIp ? { local_router_ip: wanted.localRouterIp } : {}),
                  ...(wanted.peerRouterIp ? { peer_router_ip: wanted.peerRouterIp } : {}),
                  ...(wanted.peerRouterAsn ? { peer_router_asn: wanted.peerRouterAsn } : {}),
                  ...(authKey ? { auth_key: authKey } : {}),
                },
              }
            : {};
        try {
          const created = await scrubbing(authKey ? [authKey] : [], () =>
            env.client.request<{ partner_attachment: DoAttachment }>('POST', base, {
              body: {
                name,
                region: wanted.region,
                connection_bandwidth_in_mbps: Number(wanted.bandwidthMbps),
                naas_provider: wanted.naasProvider,
                vpc_ids: wanted.vpcs,
                ...bgp,
              },
              signal: context.signal,
              budget: 'mutate',
            }),
          );
          return await state(env, created.partner_attachment, context.signal);
        } catch (error) {
          if (!isComputeError(error, 'CONFLICT')) throw error;
          attachment = await byName(env, name, context);
          if (!attachment) throw error;
        }
      }
      const have = specOf(attachment);
      for (const fixed of [
        'region',
        'bandwidthMbps',
        'naasProvider',
        'localRouterIp',
        'peerRouterIp',
        'peerRouterAsn',
      ] as const)
        if (wanted[fixed] !== undefined && String(wanted[fixed]) !== String(have[fixed]))
          throw replaceRequired(partnerKindName, fixed);
      if (sameSet(wanted.vpcs, attachment.vpc_ids ?? []))
        return state(env, attachment, context.signal);
      if (status(attachment.state) !== 'ready') return state(env, attachment, context.signal);
      const updated = await env.client.request<{ partner_attachment: DoAttachment }>(
        'PATCH',
        path(attachment.id),
        { body: { vpc_ids: wanted.vpcs }, signal: context.signal, budget: 'mutate' },
      );
      return state(env, updated.partner_attachment, context.signal);
    },

    async get(env, id, context) {
      const attachment = await read(env, id, context.signal);
      return attachment ? state(env, attachment, context.signal) : undefined;
    },

    async delete(env, id, context) {
      const attachment = await read(env, id, context.signal);
      if (!attachment) return { id, state: 'deleted' };
      owned(env, attachment);
      if (status(attachment.state) === 'deleting') return { id, state: 'deleting' };
      await found(() =>
        env.client.request('DELETE', path(id), { signal: context.signal, budget: 'mutate' }),
      );
      return { id, state: 'deleting' };
    },
  };
}
