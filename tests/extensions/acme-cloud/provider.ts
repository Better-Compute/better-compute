// `@acme/bc-provider-acme-cloud` as a third party would write it: a `defineProvider` over the Acme
// Cloud HTTP API, with an injectable `fetch` (the real one in production, an emulator or a
// record/replay transport in tests). Uses only @better-compute/core and @better-compute/vps.

import {
  ComputeError,
  field,
  manifest,
  type ExternalMachine,
  type Offer,
  type ProviderImpl,
} from '@better-compute/core';
import { defineProvider } from '@better-compute/vps';

interface AcmeServerView {
  id: string;
  name: string;
  offer: string;
  status: string;
  ipv4: string;
}

const states: Record<string, ExternalMachine['state']> = {
  provisioning: 'pending',
  active: 'running',
  off: 'stopped',
  deleting: 'deleting',
};

function machine(server: AcmeServerView): ExternalMachine {
  return {
    id: server.id,
    name: server.name,
    state: states[server.status] ?? 'unknown',
    offerId: server.offer,
    region: 'ams',
    addresses: server.ipv4 ? [server.ipv4] : [],
  };
}

export function acmeCloudProvider(options: { fetch?: typeof globalThis.fetch } = {}) {
  const transport = options.fetch ?? globalThis.fetch;
  return defineProvider({
    id: 'acme-cloud',
    version: '1.0.0',
    provides: ['vps'],
    config: manifest({
      token: field.secret().describe('Acme Cloud API token'),
      endpoint: field.url().default('https://api.acme-cloud.test'),
    }),
    async create(config, context): Promise<ProviderImpl> {
      const call = async (
        method: string,
        path: string,
        init: { body?: unknown; key?: string } = {},
      ): Promise<Response> => {
        const token = await context.secrets.resolve(config.token);
        const response = await transport(`${config.endpoint}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(init.key ? { 'idempotency-key': init.key } : {}),
          },
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        });
        if (response.status === 401)
          throw new ComputeError('INVALID_CONFIG', 'Acme Cloud refused the account token');
        return response;
      };
      const failure = async (response: Response, what: string) =>
        new ComputeError('PROVIDER_ERROR', `Acme Cloud ${what} failed (${response.status})`);

      return {
        async listOffers(query) {
          const response = await call('GET', '/v1/offers');
          if (!response.ok) throw await failure(response, 'listOffers');
          const { offers } = (await response.json()) as {
            offers: {
              id: string;
              region: string;
              vcpu: number;
              memory_gib: number;
              disk_gib: number;
              available: boolean;
            }[];
          };
          return offers
            .map(
              (offer): Offer => ({
                id: offer.id,
                kind: 'vps',
                region: offer.region,
                vcpu: offer.vcpu,
                memoryGiB: offer.memory_gib,
                diskGiB: offer.disk_gib,
                available: offer.available,
              }),
            )
            .filter(
              (offer) =>
                (query.kind === undefined || query.kind === offer.kind) &&
                (query.region === undefined || query.region === offer.region) &&
                offer.vcpu >= (query.minVcpu ?? 0) &&
                offer.memoryGiB >= (query.minMemoryGiB ?? 0) &&
                (query.minGpus ?? 0) === 0,
            );
        },
        async create(request, callContext) {
          const response = await call('POST', '/v1/servers', {
            key: callContext.idempotencyKey,
            body: {
              name: request.name,
              offer: request.offerId,
              image: request.image,
              user_data: request.userData,
            },
          });
          if (!response.ok) throw await failure(response, 'create');
          return machine(((await response.json()) as { server: AcmeServerView }).server);
        },
        async get(id) {
          const response = await call('GET', `/v1/servers/${encodeURIComponent(id)}`);
          if (response.status === 404) return undefined;
          if (!response.ok) throw await failure(response, 'get');
          return machine(((await response.json()) as { server: AcmeServerView }).server);
        },
        async delete(id) {
          const response = await call('DELETE', `/v1/servers/${encodeURIComponent(id)}`);
          if (response.status === 404) throw new ComputeError('NOT_FOUND', `No server ${id}`);
          if (!response.ok) throw await failure(response, 'delete');
        },
        async power(id, action) {
          // Acme Cloud has on and off only; a graceful off is its off, and it has no reset or NMI.
          const verbs: Partial<Record<typeof action, string>> = {
            on: 'poweron',
            off: 'poweroff',
            'graceful-off': 'poweroff',
          };
          const verb = verbs[action];
          if (!verb) throw new ComputeError('UNSUPPORTED', `Acme Cloud cannot ${action}`);
          const response = await call(
            'POST',
            `/v1/servers/${encodeURIComponent(id)}/actions/${verb}`,
          );
          if (!response.ok) throw await failure(response, 'power');
        },
      };
    },
  });
}
