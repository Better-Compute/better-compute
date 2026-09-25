'use client';

import { useMemo, useState } from 'react';
import { useDocsSearch } from 'fumadocs-core/search/client';
import { fetchClient } from 'fumadocs-core/search/client/fetch';
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogFooter,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  TagsList,
  TagsListItem,
  type SharedProps,
} from 'fumadocs-ui/components/dialog/search';
import { Kbd } from '@/components/base/kbd/kbd';

const kbd = 'min-w-5 bg-background-secondary-default px-1.5 font-mono text-text-secondary';

const tags = [
  { name: 'Guides', value: 'guides' },
  { name: 'Extending', value: 'extending' },
  { name: 'Daemon', value: 'daemon' },
  { name: 'Operations', value: 'operations' },
  { name: 'Reference', value: 'reference' },
];

const quickLinks: [string, string][] = [
  ['Quickstart', '/docs/guides/quickstart'],
  ['Reservations', '/docs/guides/capacity/reservations'],
  ['Joining nodes', '/docs/guides/nodes/joining'],
  ['Bare-metal workflows', '/docs/guides/bare-metal/workflows'],
  ['Writing a module', '/docs/extending/modules'],
  ['API reference', '/docs/reference/api'],
  ['CLI', '/docs/reference/cli'],
  ['Error codes', '/docs/reference/errors'],
];

/**
 * Search with section filters and quick links shown before the reader types. Composed from Fumadocs'
 * primitives so the filter footer lives inside the dialog.
 */
export default function Search(props: SharedProps) {
  const [tag, setTag] = useState<string | undefined>();
  const client = useMemo(() => fetchClient({ api: '/api/search', tag }), [tag]);
  const { search, setSearch, query } = useDocsSearch({ client, delayMs: 120 });
  const defaultItems = useMemo(
    () => quickLinks.map(([name, url]) => ({ type: 'page' as const, id: url, content: name, url })),
    [],
  );

  return (
    <SearchDialog search={search} onSearchChange={setSearch} isLoading={query.isLoading} {...props}>
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput placeholder="Search guides, API methods, CLI commands…" />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList items={query.data !== 'empty' ? query.data : defaultItems} />
        <SearchDialogFooter className="flex flex-wrap items-center gap-2">
          <TagsList tag={tag} onTagChange={setTag} allowClear>
            {tags.map((item) => (
              <TagsListItem key={item.value} value={item.value}>
                {item.name}
              </TagsListItem>
            ))}
          </TagsList>
          <span className="ms-auto hidden items-center gap-1.5 text-caption-1-regular text-text-secondary sm:inline-flex">
            <Kbd className={kbd}>↑↓</Kbd> navigate
            <Kbd className={kbd}>↵</Kbd> open
            <Kbd className={kbd}>esc</Kbd> close
          </span>
        </SearchDialogFooter>
      </SearchDialogContent>
    </SearchDialog>
  );
}
