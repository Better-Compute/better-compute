import { randomUUID } from 'node:crypto';
import type { DoEmulator, RouteContext } from './index.js';
import type { DoState, Json } from './state.js';

// Marketplace Add-Ons: the catalog (`/add-ons/apps`) and SaaS add-on resources (`/add-ons/saas`). Shapes follow
// the API reference (add-ons), not a recording: the live suite captures real bodies before release. A new add-on is
// `provisioning` for `emulator.addonReads` reads, a deleted one `deprovisioning` as long, then gone.

/** The catalog: each app with its plans. */
export const addonCatalog: Json[] = [
  { slug: 'acme-mail', name: 'Acme Mail', plans: [{ slug: 'free' }, { slug: 'pro' }] },
  { slug: 'acme-search', name: 'Acme Search', plans: [{ slug: 'starter' }, { slug: 'scale' }] },
];

function body(addon: Json): Json {
  const { _reads, ...rest } = addon;
  return structuredClone(rest);
}

function observe(emulator: DoEmulator, state: DoState, addon: Json): void {
  if (addon.state !== 'provisioning' && addon.state !== 'deprovisioning') return;
  addon._reads = (addon._reads ?? 0) + 1;
  if (addon._reads <= emulator.addonReads) return;
  addon._reads = 0;
  if (addon.state === 'provisioning') addon.state = 'provisioned';
  else state.addons.delete(addon.uuid);
}

/** Seeds an add-on made outside better-compute (provisioned). */
export function seedAddon(state: DoState, fields: Json = {}): Json {
  const uuid = randomUUID();
  const addon: Json = {
    uuid,
    name: `by-hand-${uuid.slice(0, 6)}`,
    app_slug: 'acme-mail',
    plan_slug: 'free',
    state: 'provisioned',
    metadata: [],
    sso_url: `https://vendor.example/sso/${uuid}?token=sso-secret-${uuid.slice(0, 8)}`,
    created_at: new Date(state.now()).toISOString(),
    ...fields,
  };
  state.addons.set(uuid, addon);
  return addon;
}

const addonOf = (context: RouteContext) =>
  context.state.addons.get(decodeURIComponent(context.match[1]!));

export function registerAddons(emulator: DoEmulator): void {
  emulator.route('GET', /^\/add-ons\/apps$/, (context) =>
    emulator.paged(context, 'apps', structuredClone(addonCatalog)),
  );

  emulator.route('GET', /^\/add-ons\/saas$/, (context) => {
    const addons = [...context.state.addons.values()];
    for (const addon of addons) observe(emulator, context.state, addon);
    return emulator.paged(context, 'resources', [...context.state.addons.values()].map(body));
  });

  emulator.route('POST', /^\/add-ons\/saas$/, (context) => {
    const input = context.body ?? {};
    const app = addonCatalog.find((entry) => entry.slug === input.app_slug);
    if (
      !app ||
      !app.plans.some((plan: Json) => plan.slug === input.plan_slug) ||
      typeof input.name !== 'string'
    )
      return emulator.error('422-unknown');
    if ([...context.state.addons.values()].some((addon) => addon.name === input.name))
      return emulator.error('422-name-in-use');
    const addon = seedAddon(context.state, {
      name: input.name,
      app_slug: input.app_slug,
      plan_slug: input.plan_slug,
      metadata: structuredClone(input.metadata ?? []),
      state: 'provisioning',
    });
    return { status: 200, body: { resource: body(addon) } };
  });

  emulator.route('GET', /^\/add-ons\/saas\/([^/]+)$/, (context) => {
    const addon = addonOf(context);
    if (!addon) return emulator.error('not-found');
    observe(emulator, context.state, addon);
    if (!context.state.addons.has(addon.uuid)) return emulator.error('not-found');
    return { status: 200, body: { resource: body(addon) } };
  });

  emulator.route('PATCH', /^\/add-ons\/saas\/([^/]+)$/, (context) => {
    const addon = addonOf(context);
    if (!addon) return emulator.error('not-found');
    if (typeof context.body?.name !== 'string') return emulator.error('422-unknown');
    addon.name = context.body.name;
    return { status: 200, body: { resource: body(addon) } };
  });

  emulator.route('PATCH', /^\/add-ons\/saas\/([^/]+)\/plan$/, (context) => {
    const addon = addonOf(context);
    if (!addon) return emulator.error('not-found');
    const app = addonCatalog.find((entry) => entry.slug === addon.app_slug)!;
    if (!app.plans.some((plan: Json) => plan.slug === context.body?.plan_slug))
      return emulator.error('422-unknown');
    addon.plan_slug = context.body!.plan_slug;
    return { status: 200, body: { resource: body(addon) } };
  });

  emulator.route('DELETE', /^\/add-ons\/saas\/([^/]+)$/, (context) => {
    const addon = addonOf(context);
    if (!addon) return emulator.error('not-found');
    addon.state = 'deprovisioning';
    addon._reads = 0;
    return { status: 204 };
  });
}
