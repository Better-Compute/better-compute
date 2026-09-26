'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/base/buttons/button';

// A first-run tour: a spotlight on the few controls that make the panel fast (search, scope, time travel,
// alerts, dashboards, pins, the status bar), one sentence each. Targets are marked with data-tour="…";
// a missing target (a collapsed sidebar, a phone) is skipped.

interface Step {
  target: string;
  title: string;
  body: string;
  /** The Overview hosts the dashboard steps. */
  page?: string;
}

const STEPS: Step[] = [
  { target: 'palette', title: 'Find anything', body: 'Pages, pools, nodes, reservations, tenants and actions, all in one box. ⌘K or / from anywhere; Shift+Enter peeks without leaving the page.' },
  { target: 'scope', title: 'Scope and range', body: 'Narrow every page to one site and pick the time window charts use. The choice sticks, and it is in the URL for sharing.' },
  { target: 'clock', title: 'Time travel', body: 'Everything is a function of this clock. Pause it (p) or scrub back up to 7 days to see the fleet as it was; , and . step 5 minutes.' },
  { target: 'bell', title: 'What needs you', body: 'Failures, approvals, quota pressure and forecasts from every module. Acknowledge here or on the Needs attention page.' },
  { target: 'dashboards', title: 'Your dashboards', body: 'Operations, Capacity, Fleet and On-call to start. Add your own with +, and switch between them here.', page: '/' },
  { target: 'arrange', title: 'Arrange and configure', body: 'Drag, resize, add and configure widgets (e). Each widget can be set up differently, and expanded full screen.', page: '/' },
  { target: 'sidebar', title: 'Pin what you use', body: 'Hover a page and pin it to the top of the sidebar. [ collapses the sidebar to a rail.' },
  { target: 'statusbar', title: 'Vitals, always on', body: 'Control-plane latency, sessions, alerts and module readouts at the bottom of every page. Click one to peek.' },
];

const DONE_KEY = 'bc-admin:tour-done';
export const TOUR_EVENT = 'bc-admin:start-tour';

type Rect = { top: number; left: number; width: number; height: number };

function findTarget(name: string): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`)];
  return all.find((el) => el.offsetParent !== null && el.getBoundingClientRect().width > 0) ?? null;
}

export function Tour() {
  const router = useRouter();
  const pathname = usePathname();
  const [index, setIndex] = useState<number | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);

  const finish = useCallback(() => {
    setIndex(null);
    try {
      window.localStorage.setItem(DONE_KEY, '1');
    } catch {
      // The tour may show again next time.
    }
  }, []);

  useEffect(() => {
    const start = () => setIndex(0);
    window.addEventListener(TOUR_EVENT, start);
    let first = false;
    try {
      first = !window.localStorage.getItem(DONE_KEY);
    } catch {
      first = false;
    }
    const timer = first ? window.setTimeout(start, 1200) : undefined;
    return () => {
      window.removeEventListener(TOUR_EVENT, start);
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  const step = index === null ? null : STEPS[index];

  // Go to the step's page, then find its target; skip steps whose target isn't on screen.
  useLayoutEffect(() => {
    if (!step || index === null) return;
    if (step.page && pathname !== step.page) {
      router.push(step.page);
      return;
    }
    let frame = 0;
    const started = Date.now();
    const locate = () => {
      const el = findTarget(step.target);
      if (!el) {
        // Give a slow first render 2 s before deciding the target isn't on this screen.
        if (Date.now() - started < 2000) frame = window.setTimeout(locate, 100);
        else setIndex((i) => (i !== null && i + 1 < STEPS.length ? i + 1 : null));
        return;
      }
      el.scrollIntoView({ block: 'nearest' });
      const box = el.getBoundingClientRect();
      setRect({ top: box.top, left: box.left, width: box.width, height: box.height });
    };
    locate();
    const onResize = () => locate();
    window.addEventListener('resize', onResize);
    return () => {
      window.clearTimeout(frame);
      window.removeEventListener('resize', onResize);
    };
  }, [step, index, pathname, router]);

  useEffect(() => {
    if (index === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish();
      else if (event.key === 'ArrowRight' || event.key === 'Enter') setIndex((i) => (i !== null && i + 1 < STEPS.length ? i + 1 : (finish(), null)));
      else if (event.key === 'ArrowLeft') setIndex((i) => (i ? i - 1 : i));
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [index, finish]);

  if (index === null || !step || !rect || typeof document === 'undefined') return null;

  const pad = 6;
  const hole = { top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 };
  const below = hole.top + hole.height + 180 < window.innerHeight;
  const cardLeft = Math.min(Math.max(12, hole.left), window.innerWidth - 352);
  const last = index === STEPS.length - 1;

  return createPortal(
    <div className="fixed inset-0 z-[90]" role="dialog" aria-modal="true" aria-label={`Tour: ${step.title}`}>
      <div className="absolute inset-0" onClick={finish} />
      <div
        aria-hidden
        className="pointer-events-none absolute border border-signal-fill transition-all duration-300 ease-out"
        style={{ ...hole, boxShadow: '0 0 0 9999px rgb(11 12 15 / 0.62)' }}
      />
      <div
        className="absolute w-[340px] border border-separator-border bg-surface-raised p-4 shadow-lg motion-safe:animate-[pop-in_160ms_ease-out]"
        style={below ? { top: hole.top + hole.height + 10, left: cardLeft } : { top: Math.max(12, hole.top - 190), left: cardLeft }}
      >
        <div className="mb-1 flex items-center justify-between">
          <span className="font-mono text-[10px] tracking-[0.14em] text-signal uppercase">
            {index + 1} / {STEPS.length}
          </span>
          <button type="button" onClick={finish} className="font-mono text-[11px] text-text-tertiary hover:text-text-primary">
            skip tour
          </button>
        </div>
        <h2 className="font-mono text-[15px] font-medium text-text-primary">{step.title}</h2>
        <p className="mt-1 text-body-regular text-text-secondary">{step.body}</p>
        <div className="mt-3 flex items-center gap-1">
          {STEPS.map((s, i) => (
            <span key={s.target} className={i === index ? 'h-1 w-4 bg-signal-fill' : 'h-1 w-1.5 bg-separator-border-strong'} />
          ))}
          <div className="ml-auto flex gap-2">
            {index > 0 && (
              <Button size="xs" variant="secondary" onClick={() => setIndex(index - 1)}>
                Back
              </Button>
            )}
            <Button size="xs" onClick={() => (last ? finish() : setIndex(index + 1))}>
              {last ? 'Done' : 'Next'}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
