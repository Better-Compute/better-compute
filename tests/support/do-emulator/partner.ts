import { randomBytes, randomUUID } from 'node:crypto';
import type { DoEmulator, RouteContext } from './index.js';
import type { DoState, Json } from './state.js';

// Partner Network Connect attachments with their service key and BGP auth key. Shapes follow the API reference
// (partner_network_connect), not a recording: the live suite captures real bodies before release. A new attachment
// is `PENDING` for `emulator.partnerReads` reads, then `ACTIVE`; a deleted one is `DELETING` as long, then gone.

function body(attachment: Json): Json {
  const { _reads, _serviceKey, _authKey, ...rest } = attachment;
  const out = structuredClone(rest);
  if (out.bgp) delete out.bgp.auth_key;
  return out;
}

function observe(emulator: DoEmulator, state: DoState, attachment: Json): void {
  if (attachment.state !== 'PENDING' && attachment.state !== 'DELETING') return;
  attachment._reads = (attachment._reads ?? 0) + 1;
  if (attachment._reads <= emulator.partnerReads) return;
  attachment._reads = 0;
  if (attachment.state === 'PENDING') attachment.state = 'ACTIVE';
  else state.partnerAttachments.delete(attachment.id);
}

/** Seeds an attachment made outside better-compute (active). */
export function seedAttachment(state: DoState, fields: Json = {}): Json {
  const id = randomUUID();
  const attachment: Json = {
    id,
    name: `by-hand-${id.slice(0, 6)}`,
    state: 'ACTIVE',
    region: 'nyc3',
    connection_bandwidth_in_mbps: 1000,
    naas_provider: 'MEGAPORT',
    vpc_ids: [randomUUID()],
    bgp: {
      local_router_ip: '169.254.0.1/29',
      peer_router_ip: '169.254.0.6/29',
      peer_router_asn: 64532,
    },
    created_at: new Date(state.now()).toISOString(),
    ...fields,
    _serviceKey: `svckey-${randomBytes(10).toString('hex')}`,
    _authKey: `bgp-${randomBytes(10).toString('hex')}`,
  };
  state.partnerAttachments.set(id, attachment);
  return attachment;
}

const of = (context: RouteContext) =>
  context.state.partnerAttachments.get(decodeURIComponent(context.match[1]!));

export function registerPartner(emulator: DoEmulator): void {
  const list = /^\/partner_network_connect\/attachments$/;
  const one = /^\/partner_network_connect\/attachments\/([^/]+)$/;

  emulator.route('GET', list, (context) => {
    for (const attachment of [...context.state.partnerAttachments.values()])
      observe(emulator, context.state, attachment);
    return emulator.paged(
      context,
      'partner_attachments',
      [...context.state.partnerAttachments.values()].map(body),
    );
  });

  emulator.route('POST', list, (context) => {
    const input = context.body ?? {};
    if (
      typeof input.name !== 'string' ||
      typeof input.region !== 'string' ||
      !Array.isArray(input.vpc_ids) ||
      ![1000, 2000, 5000, 10000].includes(input.connection_bandwidth_in_mbps)
    )
      return emulator.error('422-unknown');
    if ([...context.state.partnerAttachments.values()].some((a) => a.name === input.name))
      return emulator.error('422-name-in-use');
    const attachment = seedAttachment(context.state, {
      name: input.name,
      region: input.region,
      connection_bandwidth_in_mbps: input.connection_bandwidth_in_mbps,
      naas_provider: input.naas_provider,
      vpc_ids: [...input.vpc_ids],
      bgp: input.bgp ? structuredClone(input.bgp) : null,
      state: 'PENDING',
    });
    if (input.bgp?.auth_key) attachment._authKey = input.bgp.auth_key;
    return { status: 200, body: { partner_attachment: body(attachment) } };
  });

  emulator.route('GET', one, (context) => {
    const attachment = of(context);
    if (!attachment) return emulator.error('not-found');
    observe(emulator, context.state, attachment);
    if (!context.state.partnerAttachments.has(attachment.id)) return emulator.error('not-found');
    return { status: 200, body: { partner_attachment: body(attachment) } };
  });

  emulator.route('PATCH', one, (context) => {
    const attachment = of(context);
    if (!attachment) return emulator.error('not-found');
    if (Array.isArray(context.body?.vpc_ids)) attachment.vpc_ids = [...context.body!.vpc_ids];
    if (typeof context.body?.name === 'string') attachment.name = context.body.name;
    return { status: 200, body: { partner_attachment: body(attachment) } };
  });

  emulator.route('DELETE', one, (context) => {
    const attachment = of(context);
    if (!attachment) return emulator.error('not-found');
    attachment.state = 'DELETING';
    attachment._reads = 0;
    return { status: 202 };
  });

  emulator.route(
    'GET',
    /^\/partner_network_connect\/attachments\/([^/]+)\/service_key$/,
    (context) => {
      const attachment = of(context);
      if (!attachment || attachment.state !== 'ACTIVE') return emulator.error('not-found');
      return {
        status: 200,
        body: { service_key: { value: attachment._serviceKey, state: 'CREATED' } },
      };
    },
  );

  emulator.route(
    'GET',
    /^\/partner_network_connect\/attachments\/([^/]+)\/bgp_auth_key$/,
    (context) => {
      const attachment = of(context);
      if (!attachment) return emulator.error('not-found');
      return { status: 200, body: { bgp_auth_key: { value: attachment._authKey } } };
    },
  );
}
