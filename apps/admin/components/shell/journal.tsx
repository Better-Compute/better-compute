'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { RiDeleteBinLine, RiFileCopyLine, RiHistoryLine } from 'react-icons/ri';
import { Button } from '@/components/base/buttons/button';
import { Drawer } from '@/components/ui/overlay';
import { Mono, Tag } from '@/components/ui/signal';
import { useFeedback } from '@/components/ui/feedback';
import { fmtClock, fmtRelative, fmtStamp } from '@/lib/data';
import { clearJournal, journalStore, type JournalEntry } from '@/lib/journal';
import { peekFor } from '@/lib/modules';
import { EntityLink } from './peek';
import { useWallNow } from './workspace';

/** Open the change journal from anywhere (operator menu, ⌘K). */
export const JOURNAL_EVENT = 'bc-admin:open-journal';

export function useJournal(): JournalEntry[] {
  return useSyncExternalStore(journalStore.subscribe, journalStore.snapshot, journalStore.serverSnapshot);
}

/** `nodeId` → 'node' when some module peeks that kind. */
function kindOf(field: string): string | null {
  const kind = field.replace(/Ids?$/, '');
  return kind !== field && peekFor(kind) ? kind : null;
}

function Fields({ fields }: { fields: Record<string, string> }) {
  const entries = Object.entries(fields);
  if (!entries.length) return null;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {entries.map(([field, value]) => {
        const kind = kindOf(field);
        const single = kind && !value.includes(',');
        return (
          <span key={field} className="inline-flex min-w-0 items-baseline gap-1 font-mono text-[11px]">
            <span className="text-text-tertiary">{field}</span>
            {single ? <EntityLink kind={kind} id={value} /> : <span className="truncate text-text-secondary">{value}</span>}
          </span>
        );
      })}
    </div>
  );
}

/** "What did I just change?": this browser's changes through the admin, newest first. */
export function JournalDrawer() {
  const [open, setOpen] = useState(false);
  const entries = useJournal();
  const now = useWallNow();
  const { confirm, toast } = useFeedback();

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(JOURNAL_EVENT, onOpen);
    return () => window.removeEventListener(JOURNAL_EVENT, onOpen);
  }, []);

  const failed = entries.filter((entry) => !entry.ok).length;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(entries, null, 2));
      toast({ title: 'Copied the journal', detail: `${entries.length} changes as JSON`, status: 'ok' });
    } catch {
      toast({ title: 'Could not copy', status: 'warn' });
    }
  };
  const clear = async () => {
    if (await confirm({ title: 'Clear the change journal?', body: 'Only this browser’s list is cleared; the API’s audit log keeps every change.', confirmLabel: 'Clear', danger: true }))
      clearJournal();
  };

  return (
    <Drawer
      open={open}
      onOpenChange={setOpen}
      title="Your changes"
      subtitle={entries.length ? `${entries.length} in this browser${failed ? ` · ${failed} failed` : ''}` : 'Nothing yet'}
      width={560}
      actions={
        entries.length ? (
          <div className="flex gap-1">
            <Button variant="ghost" size="xs" leadingIcon={RiFileCopyLine} onClick={() => void copy()}>
              Copy
            </Button>
            <Button variant="ghost" size="xs" leadingIcon={RiDeleteBinLine} onClick={() => void clear()}>
              Clear
            </Button>
          </div>
        ) : undefined
      }
    >
      {entries.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <RiHistoryLine className="size-6 text-text-tertiary" aria-hidden />
          <p className="font-mono text-[13px] text-text-primary">No changes from this browser yet</p>
          <p className="max-w-sm text-caption-1-regular text-text-secondary">
            Changes you make against the live API (cordon, release, quotas…) are listed here with their outcome. Reads are not.
          </p>
        </div>
      ) : (
        <ol className="flex flex-col">
          {entries.map((entry) => (
            <li key={entry.id} className="flex gap-3 border-b border-separator-border/70 py-2.5 last:border-0">
              <div className="w-16 shrink-0 text-right font-mono text-[11px] text-text-tertiary tabular-nums" title={`${fmtStamp(entry.at)} UTC`}>
                <div>{fmtClock(entry.at, false)}</div>
                <div suppressHydrationWarning>{fmtRelative(entry.at, now)}</div>
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-center gap-2">
                  <Mono className="truncate">{entry.method}</Mono>
                  <Tag status={entry.ok ? 'ok' : 'crit'}>{entry.ok ? 'done' : (entry.code ?? 'failed').toLowerCase()}</Tag>
                </div>
                <Fields fields={entry.fields} />
                {entry.message && <p className="text-caption-1-regular text-text-error-primary">{entry.message}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Drawer>
  );
}
