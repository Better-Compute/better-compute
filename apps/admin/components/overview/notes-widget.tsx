'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { RiEdit2Line, RiEyeLine } from 'react-icons/ri';
import type { WidgetProps } from '@/lib/modules';
import { ToolButton } from '@/components/ui/overlay';

// A scratchpad on the dashboard: handover notes, runbook links, who is on call. Plain text with a tiny markup:
// lines starting with "- " are bullets, "# " a heading, [label](url) a link (internal paths stay in the app),
// and `code` is mono. Saved into the widget instance, so it travels with an exported dashboard.

function inline(text: string, key: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let n = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    if (match[1] && match[2]) {
      const href = match[2];
      const safe = href.startsWith('/') || /^https?:\/\//.test(href);
      parts.push(
        !safe ? (
          match[1]
        ) : href.startsWith('/') ? (
          <Link key={`${key}-${n++}`} href={href} className="text-signal underline-offset-2 hover:underline">
            {match[1]}
          </Link>
        ) : (
          <a key={`${key}-${n++}`} href={href} target="_blank" rel="noreferrer noopener" className="text-signal underline-offset-2 hover:underline">
            {match[1]}
          </a>
        ),
      );
    } else if (match[3]) {
      parts.push(
        <code key={`${key}-${n++}`} className="bg-surface-sunken px-1 font-mono text-[12px] text-text-primary">
          {match[3]}
        </code>,
      );
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function render(text: string) {
  return text.split('\n').map((line, i) => {
    const key = `l${i}`;
    if (line.startsWith('# ')) return <h4 key={key} className="mt-2 font-mono text-[12px] font-medium tracking-wide text-text-secondary uppercase first:mt-0">{inline(line.slice(2), key)}</h4>;
    if (line.startsWith('- ')) return <li key={key} className="ml-4 list-disc text-body-regular text-text-primary">{inline(line.slice(2), key)}</li>;
    if (!line.trim()) return <div key={key} className="h-2" />;
    return <p key={key} className="text-body-regular text-text-primary">{inline(line, key)}</p>;
  });
}

const EXAMPLE = '# On call\n- Primary: @alex (until 18:00 UTC)\n# Runbooks\n- [Node unreachable](/attention)\n- [Capacity what-if](/capacity/scenarios)\n`bcd 1.4.3` rollout paused — waiting on vendor fix';

export function NotesWidget({ settings, updateSettings, editing: arranging }: WidgetProps) {
  const text = String(settings.text ?? '');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editing) setDraft(text);
  }, [text, editing]);
  useEffect(() => {
    if (editing) area.current?.focus();
  }, [editing]);

  const save = () => {
    updateSettings?.({ text: draft });
    setEditing(false);
  };

  return (
    <div className="relative flex h-full flex-col">
      {updateSettings && !arranging && (
        <div className="absolute top-1 right-1 z-[1]">
          <ToolButton icon={editing ? RiEyeLine : RiEdit2Line} label={editing ? 'Done editing' : 'Edit notes'} onPress={() => (editing ? save() : setEditing(true))} />
        </div>
      )}
      {editing ? (
        <textarea
          ref={area}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setDraft(text);
              setEditing(false);
            } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save();
          }}
          placeholder={EXAMPLE}
          aria-label="Notes"
          className="h-full w-full resize-none bg-surface-sunken p-3 pr-10 font-mono text-[12px] leading-5 text-text-primary outline-none placeholder:text-text-placeholder"
        />
      ) : text ? (
        <div className="h-full overflow-y-auto p-3 pr-10" onDoubleClick={() => updateSettings && setEditing(true)}>
          {render(text)}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => updateSettings && setEditing(true)}
          className="grid h-full place-items-center p-4 text-center text-caption-1-regular text-text-tertiary hover:text-text-secondary"
        >
          Handover notes, runbook links, who is on call.
          <br />
          Click to write; - bullets, # headings, [label](/path) links.
        </button>
      )}
    </div>
  );
}
