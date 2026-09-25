import glossary from '@/data/glossary.json';

/** One term of `data/glossary.json`: the glossary page and every `<Term id>` hover card read it. */
export interface GlossaryEntry {
  /** What `<Term id="...">` names. */
  id: string;
  term: string;
  /** One or two sentences; `inline code` in backticks is rendered as code. */
  definition: string;
  /** The page that explains the term in depth. */
  href?: string;
}

/** Every entry, alphabetically by term. */
export const glossaryEntries: GlossaryEntry[] = [...(glossary as GlossaryEntry[])].sort((a, b) =>
  a.term.localeCompare(b.term, 'en', { sensitivity: 'base' }),
);

const byId = new Map(glossaryEntries.map((entry) => [entry.id, entry]));

export function glossaryEntry(id: string): GlossaryEntry | undefined {
  return byId.get(id);
}

/**
 * The anchor of a term on the glossary page: lowercase, every run of characters other than a-z and 0-9 a hyphen
 * (`Allocation lease` is `#allocation-lease`).
 */
export function glossarySlug(term: string): string {
  return term.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

export const glossaryUrl = (term: string) => `/docs/reference/glossary#${glossarySlug(term)}`;

/** The glossary as Markdown, for `llms.txt` and the page's Markdown copy. */
export function glossaryMarkdown(): string {
  return glossaryEntries
    .map(
      (entry) =>
        `### ${entry.term}\n\n${entry.definition}${entry.href ? `\n\nSee [${entry.term}](${entry.href}).` : ''}`,
    )
    .join('\n\n');
}
