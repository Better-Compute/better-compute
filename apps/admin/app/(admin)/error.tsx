'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { RiBugLine, RiRefreshLine } from 'react-icons/ri';
import { Button } from '@/components/base/buttons/button';

/** A page that crashed: the shell stays, the error is said plainly, and the operator can retry or leave. */
export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="mx-auto flex max-w-xl flex-col items-start gap-4 py-16">
      <span className="grid size-10 place-items-center border border-red-500/50 bg-red-500/10">
        <RiBugLine className="size-5 text-red-500" aria-hidden />
      </span>
      <div>
        <h1 className="font-mono text-[20px] font-medium text-text-primary">This page failed to render</h1>
        <p className="mt-1 text-body-regular text-text-secondary">
          The rest of the panel still works. Retry, or go back to the Overview; if it keeps happening, the message below is what to
          report.
        </p>
      </div>
      <pre className="w-full overflow-auto border border-separator-border bg-surface-sunken p-3 font-mono text-[12px] text-text-error-primary">
        {error.message}
        {error.digest ? `\ndigest ${error.digest}` : ''}
      </pre>
      <div className="flex gap-2">
        <Button size="small" leadingIcon={RiRefreshLine} onClick={reset}>
          Retry
        </Button>
        <Link href="/" className="inline-flex h-8 items-center border border-border-button-default px-3 text-body-medium text-text-primary hover:border-border-button-hover">
          Overview
        </Link>
      </div>
    </div>
  );
}
