'use client';

import Link from 'next/link';
import { RiCompass3Line, RiSearchLine } from 'react-icons/ri';
import { allNav } from '@/lib/modules';

function similarity(a: string, b: string): number {
  // Shared path words, then shared characters: good enough to suggest "/node/x" → Nodes.
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const wa = words(a);
  const wb = words(b);
  let score = 0;
  for (const w of wa) for (const v of wb) if (v.startsWith(w.slice(0, 4)) || w.startsWith(v.slice(0, 4))) score += 3;
  return score;
}

/** A path nothing serves: say so, suggest the likeliest pages, and offer search. */
export function NotFound({ path }: { path: string }) {
  const suggestions = allNav()
    .map((item) => ({ item, score: similarity(path, `${item.href} ${item.label} ${(item.keywords ?? []).join(' ')}`) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((s) => s.item);
  return (
    <div className="mx-auto flex max-w-xl flex-col items-start gap-4 py-16">
      <span className="grid size-10 place-items-center border border-dashed border-separator-border-strong">
        <RiCompass3Line className="size-5 text-text-tertiary" aria-hidden />
      </span>
      <div>
        <h1 className="font-mono text-[20px] font-medium text-text-primary">Nothing lives at this path</h1>
        <p className="mt-1 text-body-regular text-text-secondary">
          <code className="font-mono text-text-primary">{path}</code> isn&apos;t a page of any installed module. It may have moved, or the
          module that served it isn&apos;t installed here.
        </p>
      </div>
      {suggestions.length > 0 && (
        <div className="w-full">
          <div className="mb-2 font-mono text-[10px] tracking-[0.14em] text-text-tertiary uppercase">Did you mean</div>
          <ul className="flex flex-col gap-1">
            {suggestions.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="flex items-center gap-2.5 border border-separator-border bg-surface-raised px-3 py-2 hover:border-signal-fill/60">
                  <item.icon className="size-4 text-text-tertiary" aria-hidden />
                  <span className="text-body-medium text-text-primary">{item.label}</span>
                  <span className="truncate text-caption-1-regular text-text-tertiary">{item.description ?? item.href}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="flex items-center gap-1.5 text-caption-1-regular text-text-secondary">
        <RiSearchLine className="size-3.5" aria-hidden />
        Press <kbd className="border border-separator-border px-1 font-mono text-[11px]">⌘K</kbd> to search every page, pool, node and
        tenant.
      </p>
    </div>
  );
}
