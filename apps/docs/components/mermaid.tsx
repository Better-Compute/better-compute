'use client';

import { use, useEffect, useId, useState } from 'react';
import { useTheme } from 'next-themes';

type MermaidModule = (typeof import('mermaid'))['default'];

let mermaidPromise: Promise<MermaidModule> | undefined;
const loadMermaid = () => (mermaidPromise ??= import('mermaid').then((mod) => mod.default));

const cache = new Map<string, Promise<string>>();

function renderChart(id: string, chart: string, theme: 'dark' | 'default'): Promise<string> {
  const key = `${theme}:${chart}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = loadMermaid().then(async (mermaid) => {
      // Mermaid's `base` theme takes every color from these variables: graphite panels in Plex Mono, with the
      // signal amber only on the wires (edges and message arrows), like a schematic of live connections.
      const dark = theme === 'dark';
      const ink = dark ? '#eff1f3' : '#0b0c0f';
      const node = dark ? '#17191d' : '#ffffff';
      const edge = dark ? '#31363d' : '#c5cad1';
      const muted = dark ? '#101215' : '#eff1f3';
      const border = dark ? '#6d747e' : '#31363d';
      const wire = dark ? '#ff9838' : '#bd5006';
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        fontFamily: 'var(--font-plex-mono), ui-monospace, monospace',
        theme: 'base',
        themeVariables: {
          darkMode: dark,
          background: 'transparent',
          primaryColor: node,
          primaryBorderColor: border,
          primaryTextColor: ink,
          secondaryColor: muted,
          secondaryBorderColor: edge,
          secondaryTextColor: ink,
          tertiaryColor: muted,
          tertiaryBorderColor: edge,
          tertiaryTextColor: ink,
          lineColor: wire,
          textColor: ink,
          mainBkg: node,
          nodeBorder: border,
          clusterBkg: muted,
          clusterBorder: edge,
          edgeLabelBackground: dark ? '#0b0c0f' : '#f3f4f6',
          actorBkg: node,
          actorBorder: border,
          actorTextColor: ink,
          signalColor: wire,
          signalTextColor: ink,
          noteBkgColor: muted,
          noteBorderColor: edge,
          noteTextColor: ink,
          labelBoxBkgColor: node,
          labelBoxBorderColor: edge,
          labelTextColor: ink,
          loopTextColor: ink,
          activationBkgColor: muted,
          activationBorderColor: edge,
        },
      });
      const { svg } = await mermaid.render(id, chart.replaceAll('\\n', '\n'));
      return svg;
    });
    cache.set(key, pending);
  }
  return pending;
}

function Chart({ id, chart, theme }: { id: string; chart: string; theme: 'dark' | 'default' }) {
  const svg = use(renderChart(id, chart, theme));
  return (
    <div
      className="not-prose grid-lines-full my-6 flex justify-center overflow-x-auto border border-border-button-default bg-surface-sunken p-4 [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** Renders a Mermaid diagram produced by `remarkMdxMermaid` from ```mermaid code blocks. */
export function Mermaid({ chart }: { chart: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [mounted, setMounted] = useState(false);
  const { resolvedTheme } = useTheme();

  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <div
        className="not-prose my-6 h-48 animate-pulse border border-border-button-default bg-surface-sunken"
        aria-hidden
      />
    );
  }
  return (
    <Chart
      id={`mermaid-${id}`}
      chart={chart}
      theme={resolvedTheme === 'dark' ? 'dark' : 'default'}
    />
  );
}
