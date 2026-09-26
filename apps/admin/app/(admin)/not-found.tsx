'use client';

import { usePathname } from 'next/navigation';
import { NotFound } from '@/components/shell/not-found';

export default function AdminNotFound() {
  return <NotFound path={usePathname()} />;
}
