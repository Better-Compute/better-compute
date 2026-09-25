import { apiGroupBySlug, knownMethods } from '@/lib/api-catalog';
import { source } from '@/lib/source';

export {
  apiGroup,
  apiGroups,
  apiMethod,
  referenceUrl,
  type ApiGroupInfo,
  type ApiMethodInfo,
} from '@/lib/api-catalog';

export interface PageLink {
  title: string;
  url: string;
}

/**
 * API methods a page mentions, as canonical `group.method` keys: server calls such as
 * `compute.api.reservations.create(credential, input)`, browser client calls such as
 * `client.joinTokens.create(input)`, and links into the API reference such as `/docs/reference/api/join-tokens#create`
 * (anchors are lowercase, so keys are compared case-insensitively against the catalog). Anything that names no
 * catalog method is ignored.
 */
export function methodsIn(text: string): Set<string> {
  const found = new Set<string>();
  const add = (group: string | undefined, method: string | undefined) => {
    const key = group && method ? knownMethods.get(`${group}.${method}`.toLowerCase()) : undefined;
    if (key) found.add(key);
  };
  // `compute.api.` is unambiguous, so a mention without the call parentheses counts too.
  for (const match of text.matchAll(/\bcompute\.api\.([a-zA-Z]+)\.([a-zA-Z]+)\b/g))
    add(match[1], match[2]);
  for (const match of text.matchAll(/\bclient\.([a-zA-Z]+)\.([a-zA-Z]+)\s*\(/g))
    add(match[1], match[2]);
  for (const match of text.matchAll(/\/docs\/reference\/api\/([a-z0-9-]+)#([a-z0-9]+)/g))
    add(apiGroupBySlug(match[1]!)?.group, match[2]);
  return found;
}

let index: Promise<Map<string, PageLink[]>> | undefined;

/**
 * `group.method` to the guide pages that use it, built once per server process from every non-reference page's
 * processed Markdown.
 */
export function apiUsage(): Promise<Map<string, PageLink[]>> {
  index ??= (async () => {
    const usedIn = new Map<string, PageLink[]>();
    for (const page of source.getPages()) {
      if (page.slugs[0] === 'reference') continue;
      const text = await page.data.getText('processed');
      for (const key of methodsIn(text)) {
        const list = usedIn.get(key) ?? [];
        if (!list.some((entry) => entry.url === page.url))
          list.push({ title: page.data.title, url: page.url });
        usedIn.set(key, list);
      }
    }
    return usedIn;
  })();
  return index;
}
