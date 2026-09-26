'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { RiLoginBoxLine, RiLogoutBoxRLine, RiUserLine } from 'react-icons/ri';
import { Menu, ToolButton } from '@/components/ui/overlay';
import { useFeedback } from '@/components/ui/feedback';
import { adminHeaders, rotateSessionKey } from '@/lib/session-key';
import { useConnection } from './connection';

/**
 * Who the admin acts as against the live API: the signed-in operator (changes allowed as far as their
 * policies go) or nobody (the shared connection reads only). Hidden when no API is configured.
 */
export function OperatorMenu() {
  const { status, refresh } = useConnection();
  const pathname = usePathname();
  const { toast } = useFeedback();
  if (!status?.configured) return null;
  const operator = status.operator;
  if (!operator)
    return (
      <Link
        href={`/signin?next=${encodeURIComponent(pathname)}`}
        title="The live connection is read-only until you sign in"
        className="hidden h-8 items-center gap-1.5 border border-separator-border px-2 font-mono text-[11px] text-text-secondary hover:border-signal-fill hover:text-signal md:inline-flex"
      >
        <RiLoginBoxLine className="size-3.5" aria-hidden />
        sign in
      </Link>
    );
  const signOut = async () => {
    const out = (await fetch('/api/session', { method: 'DELETE', headers: adminHeaders() })
      .then((response) => response.json())
      .catch(() => ({ warning: 'The admin server did not answer; your session may still be active.' }))) as { warning?: string };
    rotateSessionKey();
    refresh();
    toast(
      out.warning
        ? { title: 'Signed out of the admin', detail: out.warning, status: 'warn' }
        : { title: 'Signed out', detail: 'The live connection is read-only again.', status: 'ok' },
    );
  };
  return (
    <Menu
      label="Operator"
      trigger={
        <ToolButton icon={RiUserLine} label={`Signed in as ${operator.name ?? operator.email ?? operator.identityId}`}>
          <span className="hidden max-w-32 truncate font-mono text-[11px] lg:inline">{operator.name ?? operator.email ?? 'operator'}</span>
        </ToolButton>
      }
      items={[
        { id: 'who', label: `${operator.email ?? operator.identityId} · ${status.tenantId ?? ''}`, disabled: true },
        { id: 'out', label: 'Sign out', icon: RiLogoutBoxRLine, separator: true, onAction: () => void signOut() },
      ]}
    />
  );
}
