'use client';

import type { ReactNode } from 'react';

// Small shared pieces: an error line with the server's stable code, a status for loading stores, a stacked bar.

export function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  const failure = error as { code?: string; message?: string };
  return (
    <p className="error">
      {failure.code ? `${failure.code}: ` : ''}
      {failure.message ?? String(error)}
    </p>
  );
}

export function Loading({
  status,
  error,
  children,
}: {
  status: string;
  error?: unknown;
  children: ReactNode;
}) {
  if (status === 'idle' || (status === 'loading' && !children))
    return <p className="muted">Loading…</p>;
  return (
    <>
      {status === 'error' && <ErrorLine error={error} />}
      {children}
    </>
  );
}

export function StackedBar({
  parts,
  total,
}: {
  parts: { value: number; color: string; label: string }[];
  total: number;
}) {
  return (
    <div
      className="bar"
      role="img"
      aria-label={parts.map((part) => `${part.label} ${part.value}`).join(', ')}
    >
      {parts.map((part) => (
        <span
          key={part.label}
          title={`${part.label}: ${part.value}`}
          style={{ width: total ? `${(100 * part.value) / total}%` : 0, background: part.color }}
        />
      ))}
    </div>
  );
}

export const colors = {
  allocated: '#2563eb',
  reserved: '#7c3aed',
  available: '#16a34a',
  unavailable: '#9ca3af',
};
