import api from '@/generated/api.json';

/**
 * The API catalog `scripts/generate.mjs` extracts from the live registry (every module registered) and PLAN.md
 * §9.2. It has no dependency on the page source, so lib/llms-text.ts can read it while the source is being built.
 */

/** One method of the catalog. */
export interface ApiMethodInfo {
  method: string;
  /** `POST /api/compute/{group}/{method}`. */
  route: string;
  kind: string;
  /** The IAM action decided for a call (`compute:reservations:create`), or null for a public method. */
  action: string | null;
  resource: string | null;
  phase: string | null;
  module: string;
  /** `registered`: served by this release; `planned`: designed for `phase`, not served yet. */
  status: string;
  /** The first paragraph of `description` (both from descriptions/api/{group}.md; empty when not written yet). */
  summary: string;
  description: string;
}

export interface ApiGroupInfo {
  group: string;
  /** The reference page slug: the group in kebab case (`joinTokens` is `join-tokens`). */
  slug: string;
  module: string;
  methods: ApiMethodInfo[];
}

/** Typed loosely enough that a regenerated file with nulls in new places still compiles. */
export const apiGroups = api as unknown as ApiGroupInfo[];

const groupsByName = new Map(apiGroups.map((entry) => [entry.group, entry]));
const groupsBySlug = new Map(apiGroups.map((entry) => [entry.slug, entry]));

/** A group by its name (`joinTokens`). */
export function apiGroup(group: string): ApiGroupInfo | undefined {
  return groupsByName.get(group);
}

/** A group by its reference page slug (`join-tokens`). */
export function apiGroupBySlug(slug: string): ApiGroupInfo | undefined {
  return groupsBySlug.get(slug);
}

/** A method of the catalog, or undefined when the group or method does not exist. */
export function apiMethod(group: string, method: string): ApiMethodInfo | undefined {
  return groupsByName.get(group)?.methods.find((entry) => entry.method === method);
}

/** Lowercased `group.method` to its canonical spelling, for every method in the catalog. */
export const knownMethods = new Map(
  apiGroups.flatMap((entry) =>
    entry.methods.map((method) => {
      const key = `${entry.group}.${method.method}`;
      return [key.toLowerCase(), key] as const;
    }),
  ),
);

/** The API reference anchor of a `group.method` key: `/docs/reference/api/join-tokens#create`. */
export function referenceUrl(key: string): string {
  const [group = '', method = ''] = key.split('.');
  const slug =
    groupsByName.get(group)?.slug ?? group.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
  return `/docs/reference/api/${slug}#${method.toLowerCase()}`;
}

/** How a method is authorized, in words: `compute:reservations:create @ compute-pool`, or `public`. */
export function authorizationText(info: ApiMethodInfo): string {
  if (info.action === null) return 'public';
  return info.resource ? `${info.action} @ ${info.resource}` : info.action;
}
