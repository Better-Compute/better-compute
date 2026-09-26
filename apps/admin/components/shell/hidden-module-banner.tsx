'use client';

import { usePathname } from 'next/navigation';
import { RiEyeOffLine } from 'react-icons/ri';
import { isModuleHidden, moduleForPath, setModuleHidden } from '@/lib/modules';
import { useModuleVersion } from './use-modules';

/** Shown on a page whose module is hidden in this browser (opened from a link or the address bar). */
export function HiddenModuleBanner() {
  const pathname = usePathname();
  useModuleVersion();
  const module = moduleForPath(pathname);
  if (!module || !isModuleHidden(module.id)) return null;
  return (
    <div role="status" className="flex h-8 shrink-0 items-center gap-3 border-b border-separator-border bg-surface-sunken px-4 font-mono text-[12px] text-text-secondary">
      <RiEyeOffLine className="size-4 text-text-tertiary" aria-hidden />
      <span className="truncate">The {module.title} module is hidden in this browser: its pages, widgets and alerts are left out.</span>
      <button type="button" onClick={() => setModuleHidden(module.id, false)} className="ml-auto shrink-0 text-text-primary hover:underline">
        show it
      </button>
    </div>
  );
}
