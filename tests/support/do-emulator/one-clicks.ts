import type { DoEmulator } from './index.js';
import type { Json } from './state.js';

// 1-Click applications: `GET /v2/1-clicks`, optionally `?type=droplet|kubernetes`. The body is
// `{ "1_clicks": [{ slug, type }] }`, unpaged, as the API reference (1-Click Applications) shows it; not a recording:
// the live suite captures the real body before release. A test edits `oneClicks` to change the listing.

export const oneClicks: Json[] = [
  { slug: 'wordpress-20-04', type: 'droplet' },
  { slug: 'docker-20-04', type: 'droplet' },
  { slug: 'monitoring', type: 'kubernetes' },
  { slug: 'ingress-nginx', type: 'kubernetes' },
];

export function registerOneClicks(emulator: DoEmulator): void {
  emulator.route('GET', /^\/1-clicks$/, (context) => {
    const type = context.url.searchParams.get('type');
    if (type !== null && type !== 'droplet' && type !== 'kubernetes')
      return emulator.error('422-unknown');
    return {
      status: 200,
      body: {
        '1_clicks': structuredClone(
          oneClicks.filter((entry) => type === null || entry.type === type),
        ),
      },
    };
  });
}
