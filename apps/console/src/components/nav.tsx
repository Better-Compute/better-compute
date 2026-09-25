'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LiveBadge } from './console-provider';

const areas = [
  { href: '/', label: 'Overview' },
  { href: '/reservations', label: 'Reservations' },
  { href: '/instances', label: 'Instances' },
  { href: '/sandboxes', label: 'Sandboxes' },
  { href: '/nodes', label: 'Nodes' },
  { href: '/pools', label: 'Pools & capacity' },
  { href: '/quotas', label: 'Quotas' },
  { href: '/usage', label: 'Usage & spend' },
  { href: '/activity', label: 'Activity' },
  { href: '/webhooks', label: 'Webhooks' },
];
const admin = [
  { href: '/admin/rollouts', label: 'Rollouts' },
  { href: '/admin/fleet', label: 'Fleet drift' },
];

export function Nav({
  root,
  who,
  signOut,
}: {
  root: boolean;
  who: string;
  signOut: () => Promise<never>;
}) {
  const path = usePathname();
  const link = (item: { href: string; label: string }) => (
    <Link
      key={item.href}
      href={item.href}
      aria-current={
        (item.href === '/' ? path === '/' : path.startsWith(item.href)) ? 'page' : undefined
      }
    >
      {item.label}
    </Link>
  );
  return (
    <nav className="nav">
      <h1>
        better-compute <LiveBadge />
      </h1>
      {areas.map(link)}
      {root && (
        <>
          <div className="section">Platform</div>
          {admin.map(link)}
        </>
      )}
      <div className="section">{who}</div>
      <form action={signOut}>
        <button type="submit">Sign out</button>
      </form>
    </nav>
  );
}
