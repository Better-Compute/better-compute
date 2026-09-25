import Link from 'next/link';
import { Heading } from 'fumadocs-ui/components/heading';
import { inlineCode } from '@/components/term';
import { glossaryEntries, glossarySlug, type GlossaryEntry } from '@/lib/glossary';

/** The letter a term is filed under; terms that start with a digit or symbol share `#`. */
const initial = (term: string) => {
  const letter = term.charAt(0).toUpperCase();
  return /[A-Z]/.test(letter) ? letter : '#';
};

/**
 * Every term of `data/glossary.json`, alphabetically, grouped by initial. Each term is a heading whose id is the
 * term's slug (`/docs/reference/glossary#allocation-lease`), the anchor `<Term>` hover cards link to.
 */
export function Glossary() {
  if (!glossaryEntries.length)
    return <p className="text-text-secondary">The glossary has no terms yet.</p>;

  const groups = new Map<string, GlossaryEntry[]>();
  for (const entry of glossaryEntries) {
    const letter = initial(entry.term);
    groups.set(letter, [...(groups.get(letter) ?? []), entry]);
  }

  return (
    <div>
      <nav
        aria-label="Glossary letters"
        className="not-prose my-6 flex flex-wrap gap-1 rounded-2xl border border-border-button-default bg-surface-sunken p-1.5"
      >
        {[...groups].map(([letter, entries]) => (
          <a
            key={letter}
            href={`#${glossarySlug(entries[0]!.term)}`}
            className="inline-flex size-8 items-center justify-center rounded-lg font-mono text-caption-1-medium text-text-secondary transition-colors hover:bg-background-primary-default hover:text-text-primary"
          >
            {letter}
          </a>
        ))}
      </nav>
      {[...groups].map(([letter, entries]) => (
        <section key={letter} aria-label={letter === '#' ? 'Symbols' : letter}>
          <p className="not-prose mt-10 mb-2 border-b border-separator-border pb-2 font-mono text-caption-1-semibold tracking-widest text-text-secondary">
            {letter}
          </p>
          {entries.map((entry) => (
            <div key={entry.id}>
              <Heading as="h3" id={glossarySlug(entry.term)}>
                {entry.term}
              </Heading>
              <p>{inlineCode(entry.definition)}</p>
              {entry.href ? (
                <p className="-mt-2 text-sm">
                  <Link href={entry.href}>Learn more</Link>
                </p>
              ) : null}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
