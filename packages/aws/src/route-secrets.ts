import { ComputeError, type SecretStore } from '@better-compute/core';

export interface RouteSecretStoresOptions {
  /** Refs that start with `prefix` go to `store` (the longest matching prefix wins). */
  routes: readonly { prefix: string; store: SecretStore }[];
  /** Every other ref (e.g. local-sealed's `secret://<tenant>/<id>`). */
  fallback: SecretStore;
  /** Where new secrets go. */
  putTo: SecretStore;
}

/**
 * One `secret`-scheme store over several: refs route by path prefix and `put` goes to `putTo`, so
 * existing local-sealed refs keep resolving while new ones land in, say, Secrets Manager.
 */
export function routeSecretStores(options: RouteSecretStoresOptions): SecretStore {
  for (const route of options.routes)
    if (!/^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9_-]+\/$/.test(route.prefix))
      throw new ComputeError('INVALID_CONFIG', 'a route prefix looks like secret://<store>/');
  const routes = [...options.routes].sort((a, b) => b.prefix.length - a.prefix.length);
  const pick = (ref: string): SecretStore =>
    routes.find((route) => ref.startsWith(route.prefix))?.store ?? options.fallback;
  const stores = [options.fallback, options.putTo, ...routes.map((route) => route.store)];
  return {
    id: 'route',
    schemes: [...new Set(stores.flatMap((store) => store.schemes))],
    put: (tenantId, value, putOptions) =>
      (putOptions?.ref ? pick(putOptions.ref) : options.putTo).put(tenantId, value, putOptions),
    resolve: (ref, context) => pick(ref).resolve(ref, context),
    delete: (ref) => pick(ref).delete(ref),
  };
}
