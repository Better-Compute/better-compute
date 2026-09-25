// A record/replay HTTP transport (PLAN.md §5.6 walkthrough 2: `providerConformance(acmeCloud,
// { recordReplay })`): record a conformance run against a live account or an emulator once, then
// replay it offline in CI. Exchanges are matched by method, URL and body, in order per match, and a
// request the recording never saw fails loudly instead of reaching the network.

export interface Exchange {
  method: string;
  url: string;
  body: string;
  status: number;
  response: string;
}

export function recording(fetch: typeof globalThis.fetch) {
  const exchanges: Exchange[] = [];
  const transport: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = request.body ? await request.clone().text() : '';
    const response = await fetch(request);
    const text = response.status === 204 ? '' : await response.clone().text();
    exchanges.push({
      method: request.method,
      url: request.url,
      body,
      status: response.status,
      response: text,
    });
    return response;
  };
  return { transport, exchanges };
}

export function replaying(exchanges: readonly Exchange[]) {
  const remaining = [...exchanges];
  const transport: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = request.body ? await request.text() : '';
    const index = remaining.findIndex(
      (exchange) =>
        exchange.method === request.method &&
        exchange.url === request.url &&
        exchange.body === body,
    );
    if (index < 0) throw new Error(`No recorded exchange for ${request.method} ${request.url}`);
    const [exchange] = remaining.splice(index, 1);
    return new Response(exchange!.status === 204 ? null : exchange!.response, {
      status: exchange!.status,
      headers: exchange!.response ? { 'content-type': 'application/json' } : {},
    });
  };
  return { transport, remaining };
}
