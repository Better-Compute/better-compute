// The "Acme Cloud" HTTP API, emulated in memory: what a third party's provider package talks to.
// Bearer-token auth, idempotent creates (Idempotency-Key), servers that boot on `tick()`.

export interface AcmeServer {
  id: string;
  name: string;
  offer: string;
  image: string;
  user_data: string;
  status: 'provisioning' | 'active' | 'off' | 'deleting';
  ipv4: string;
  idempotency_key: string;
}

export interface AcmeCloudEmulator {
  readonly servers: Map<string, AcmeServer>;
  /** Every request, as `METHOD /path`. */
  readonly log: string[];
  /** The emulator's HTTP handler (pass it as the provider's `fetch`). */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** Servers that are provisioning become active. */
  tick(): void;
}

export const ACME_OFFERS = [
  { id: 'a1.small', region: 'ams', vcpu: 2, memory_gib: 4, disk_gib: 40, available: true },
  { id: 'a1.large', region: 'ams', vcpu: 8, memory_gib: 32, disk_gib: 160, available: false },
];

export function createAcmeCloud(options: { token: string }): AcmeCloudEmulator {
  const servers = new Map<string, AcmeServer>();
  const log: string[] = [];
  let next = 0;
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const missing = () => json({ error: 'not_found' }, 404);

  return {
    servers,
    log,
    tick() {
      for (const server of servers.values())
        if (server.status === 'provisioning') server.status = 'active';
    },
    async fetch(input, init) {
      const request = new Request(input, init);
      const url = new URL(request.url);
      log.push(`${request.method} ${url.pathname}`);
      if (request.headers.get('authorization') !== `Bearer ${options.token}`)
        return json({ error: 'unauthorized' }, 401);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'v1') return missing();
      if (request.method === 'GET' && parts[1] === 'offers' && parts.length === 2)
        return json({ offers: ACME_OFFERS });
      if (parts[1] !== 'servers') return missing();
      if (request.method === 'POST' && parts.length === 2) {
        const key = request.headers.get('idempotency-key') ?? '';
        const existing = [...servers.values()].find((server) => server.idempotency_key === key);
        if (key && existing) return json({ server: existing });
        const body = (await request.json()) as Record<string, string>;
        if (!ACME_OFFERS.some((offer) => offer.id === body.offer && offer.available))
          return json({ error: 'offer_unavailable' }, 422);
        const id = `acm-${++next}`;
        const server: AcmeServer = {
          id,
          name: body.name ?? id,
          offer: body.offer!,
          image: body.image!,
          user_data: body.user_data ?? '',
          status: 'provisioning',
          ipv4: `198.51.100.${next}`,
          idempotency_key: key,
        };
        servers.set(id, server);
        return json({ server }, 201);
      }
      const server = parts[2] ? servers.get(parts[2]) : undefined;
      if (request.method === 'GET' && parts.length === 3)
        return server ? json({ server }) : missing();
      if (request.method === 'DELETE' && parts.length === 3) {
        if (!server) return missing();
        servers.delete(server.id);
        return new Response(null, { status: 204 });
      }
      if (request.method === 'POST' && parts.length === 5 && parts[3] === 'actions') {
        if (!server) return missing();
        if (parts[4] === 'poweroff') server.status = 'off';
        else if (parts[4] === 'poweron') server.status = 'active';
        else return missing();
        return json({ server });
      }
      return missing();
    },
  };
}
