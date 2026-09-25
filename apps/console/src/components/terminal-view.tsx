'use client';

import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  createScreen,
  keyInput,
  paletteColor,
  type CellStyle,
  type ScreenRun,
  type TerminalSession,
} from '@better-compute/console-kit';

// A key-mode terminal over a console-kit TerminalSession: output feeds a console-kit Screen (the VT100 / xterm
// subset), rendered as styled rows with scrollback and a cursor; keys and pastes go straight to the node.

const color = (value: number | string | undefined) =>
  value === undefined ? undefined : typeof value === 'number' ? paletteColor(value) : value;

function cellStyle(style: CellStyle): CSSProperties | undefined {
  if (style === undefined || Object.keys(style).length === 0) return undefined;
  let fg = color(style.fg);
  let bg = color(style.bg);
  if (style.inverse) [fg, bg] = [bg ?? 'var(--term-bg)', fg ?? 'var(--term-fg)'];
  if (style.bold && typeof style.fg === 'number' && style.fg < 8) fg = paletteColor(style.fg + 8);
  return {
    ...(fg ? { color: fg } : {}),
    ...(bg ? { background: bg } : {}),
    ...(style.bold ? { fontWeight: 700 } : {}),
    ...(style.dim ? { opacity: 0.7 } : {}),
    ...(style.italic ? { fontStyle: 'italic' } : {}),
    ...(style.underline ? { textDecoration: 'underline' } : {}),
  };
}

function Line({ runs }: { runs: ScreenRun[] }) {
  return (
    <div className="term-line">
      {runs.length === 0
        ? ' '
        : runs.map((run, index) => (
            <span key={index} style={cellStyle(run.style)}>
              {run.text}
            </span>
          ))}
    </div>
  );
}

export function TerminalView({
  session,
  onTitle,
}: {
  session: TerminalSession;
  onTitle?: (title: string) => void;
}) {
  const [screen] = useState(() => createScreen({ rows: 24, cols: 80, scrollback: 2000 }));
  const [, render] = useReducer((n: number) => n + 1, 0);
  const box = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const [cell, setCell] = useState({ width: 8, height: 17 });

  // Output → screen, re-rendering at most once per frame.
  useEffect(() => {
    const decoder = new TextDecoder();
    let frame = 0;
    const off = session.onOutput((data) => {
      screen.write(decoder.decode(data, { stream: true }));
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          render();
        });
    });
    return () => {
      off();
      cancelAnimationFrame(frame);
    };
  }, [session, screen]);

  // The character cell, from a probe span in the terminal font.
  useLayoutEffect(() => {
    const rect = probe.current?.getBoundingClientRect();
    if (rect && rect.width > 0) setCell({ width: rect.width / 10, height: rect.height });
  }, []);

  // Fit the screen to the box, and tell the node.
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    let sent = '';
    const fit = (force = false) => {
      const rows = Math.max(2, Math.floor((element.clientHeight - 16) / cell.height));
      const cols = Math.max(10, Math.floor((element.clientWidth - 16) / cell.width));
      if (!force && `${rows}x${cols}` === sent) return;
      screen.resize(rows, cols);
      // Sent only once open (the session drops it before); a reconnect sends it again.
      if (session.get().status === 'open') {
        session.resize(rows, cols);
        sent = `${rows}x${cols}`;
      }
      render();
    };
    fit();
    const observer = new ResizeObserver(() => fit());
    observer.observe(element);
    let status = session.get().status;
    const off = session.subscribe(() => {
      const next = session.get().status;
      if (next === status) return;
      status = next;
      if (next === 'opening') screen.reset();
      if (next === 'open') fit(true);
    });
    return () => {
      observer.disconnect();
      off();
    };
  }, [session, screen, cell]);

  const snapshot = screen.snapshot();
  useEffect(() => {
    if (snapshot.title) onTitle?.(snapshot.title);
  }, [snapshot.title, onTitle]);

  // Follow the output unless the reader scrolled up.
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const element = box.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  });

  const scrollbackRows = snapshot.alternate ? [] : snapshot.scrollback;
  return (
    <div
      ref={box}
      className="term"
      tabIndex={0}
      role="textbox"
      aria-label="Terminal"
      aria-multiline
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current =
          element.scrollTop + element.clientHeight >= element.scrollHeight - cell.height;
      }}
      onKeyDown={(event) => {
        // Keep the browser's copy shortcut when text is selected.
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key === 'c' &&
          window.getSelection()?.toString()
        )
          return;
        if ((event.ctrlKey || event.metaKey) && event.key === 'v') return; // paste arrives as onPaste
        const input = keyInput(event);
        if (input === undefined) return;
        event.preventDefault();
        pinned.current = true;
        session.write(input);
      }}
      onPaste={(event) => {
        event.preventDefault();
        const text = event.clipboardData.getData('text');
        // Bracketed paste is not negotiated; newlines are sent as carriage returns, as terminals do.
        if (text) session.write(text.replace(/\r?\n/g, '\r'));
      }}
    >
      <span ref={probe} className="term-probe" aria-hidden>
        0123456789
      </span>
      {scrollbackRows.map((runs, index) => (
        <Line key={`s${index}`} runs={runs} />
      ))}
      <div className="term-screen">
        {snapshot.lines.map((runs, index) => (
          <Line key={index} runs={runs} />
        ))}
        {snapshot.cursor.visible && (
          <span
            className="term-cursor"
            style={{
              top: snapshot.cursor.row * cell.height,
              left: snapshot.cursor.col * cell.width,
              width: cell.width,
              height: cell.height,
            }}
          />
        )}
      </div>
    </div>
  );
}
