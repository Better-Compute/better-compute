import Link from 'next/link';
import {
  RiBookOpenLine,
  RiGlobalLine,
  RiLock2Line,
  RiLockUnlockLine,
  RiServerLine,
  RiTimeLine,
} from 'react-icons/ri';
import { CopyText } from '@/components/copy-text';
import { apiGroup, apiMethod, authorizationText, type ApiMethodInfo } from '@/lib/api-catalog';
import { apiUsage } from '@/lib/api-usage';
import { cx } from '@/utils/cx';

/** Every method is `POST /api/compute/{group}/{method}` (the server's `endpoint.basePath`). */
const basePath = '/api/compute';

interface Badge {
  icon: typeof RiLock2Line;
  label: string;
  title: string;
  className: string;
}

/**
 * How a call is authorized and whether it is served yet, told apart by weight: an IAM action is solid ink, a public
 * method is outlined, and a planned method is dashed and muted.
 */
function badges(info: ApiMethodInfo | undefined): Badge[] {
  if (!info) return [];
  const list: Badge[] = [
    info.action === null
      ? {
          icon: RiLockUnlockLine,
          label: 'Public',
          title: 'Callable without a credential',
          className: 'border border-text-primary text-text-primary',
        }
      : {
          icon: RiLock2Line,
          label: info.action,
          title: `One Better IAM decision on ${authorizationText(info)}`,
          className: 'bg-text-primary font-mono text-background-full',
        },
  ];
  if (info.status === 'planned')
    list.push({
      icon: RiTimeLine,
      label: `Planned ${info.phase ?? ''}`.trim(),
      title: `Designed in PLAN.md §9.2${info.phase ? ` for ${info.phase}` : ''}; not served by this release`,
      className: 'border border-dashed border-border-button-default text-text-secondary',
    });
  return list;
}

/**
 * The HTTP route, the server and browser-client calls, and the authorization of one API method, read from the
 * generated catalog (`generated/api.json`), plus the guides that use it (found by scanning every guide for calls
 * and reference links; see `lib/api-usage.ts`).
 */
export async function ApiEndpoint({ group, method }: { group: string; method: string }) {
  const info = apiMethod(group, method);
  const path = info ? info.route.replace(/^POST /, '') : `${basePath}/${group}/${method}`;
  const guides = (await apiUsage()).get(`${group}.${method}`) ?? [];
  return (
    <>
      <div className="not-prose my-4 flex flex-col gap-2 rounded-2xl border border-border-button-default bg-surface-sunken p-2 text-body-regular">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-border-button-default bg-background-primary-default px-2 py-1.5 shadow-xs">
            <span className="rounded-md bg-text-primary px-1.5 py-0.5 font-mono text-[0.7rem] font-semibold text-background-full">
              POST
            </span>
            <code className="min-w-0 flex-1 truncate font-mono text-[0.8rem]">{path}</code>
            <CopyText text={path} label="Copy route" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {badges(info).map((badge) => (
              <span
                key={badge.label}
                title={badge.title}
                className={cx(
                  'inline-flex items-center gap-1 rounded-lg px-2 py-1 text-caption-1-medium',
                  badge.className,
                )}
              >
                <badge.icon className="size-3.5" aria-hidden />
                {badge.label}
              </span>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-1 pb-0.5">
          <Call
            icon={RiServerLine}
            title="Server call"
            code={`compute.api.${group}.${method}(credential, input)`}
          />
          <Call
            icon={RiGlobalLine}
            title="Browser client call"
            code={`client.${group}.${method}(input)`}
          />
        </div>
      </div>
      {guides.length ? (
        <p className="not-prose -mt-2 mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption-1-regular text-text-secondary">
          <RiBookOpenLine className="size-3.5" aria-hidden />
          <span>Used in</span>
          {guides.slice(0, 6).map((guide, index) => (
            <span key={guide.url}>
              <Link
                href={guide.url}
                className="text-text-primary underline-offset-2 hover:underline"
              >
                {guide.title}
              </Link>
              {index < Math.min(guides.length, 6) - 1 ? ',' : ''}
            </span>
          ))}
          {guides.length > 6 ? <span>and {guides.length - 6} more</span> : null}
        </p>
      ) : null}
    </>
  );
}

function Call({
  icon: Icon,
  title,
  code,
}: {
  icon: typeof RiServerLine;
  title: string;
  code: string;
}) {
  return (
    <span
      title={title}
      className="inline-flex min-w-0 items-center gap-1.5 rounded-lg border border-border-button-default bg-background-primary-default px-2 py-1 font-mono text-[0.75rem] text-text-secondary"
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{code}</span>
    </span>
  );
}

/** The top of a group's reference page: how many methods it has, how many are served, and how to call them. */
export function ApiGroupSummary({ group }: { group: string }) {
  const entry = apiGroup(group);
  const methods = entry?.methods.length ?? 0;
  const served = entry?.methods.filter((method) => method.status === 'registered').length ?? 0;
  const items = [
    { icon: RiServerLine, label: 'Server', value: `compute.api.${group}` },
    { icon: RiGlobalLine, label: 'Client', value: `client.${group}` },
    { icon: RiGlobalLine, label: 'HTTP', value: `POST ${basePath}/${group}/*` },
  ];
  return (
    <div className="not-prose my-6 grid gap-px overflow-hidden rounded-2xl border border-border-button-default bg-separator-border sm:grid-cols-4">
      <div className="flex flex-col gap-1 bg-background-primary-default p-3">
        <span className="text-caption-1-regular text-text-secondary">Methods</span>
        <span className="text-title-2-semibold tabular-nums">
          {served}
          {served < methods ? (
            <span className="text-body-regular text-text-secondary"> of {methods} served</span>
          ) : null}
        </span>
      </div>
      {items.map((item) => (
        <div
          key={item.label}
          className="flex min-w-0 flex-col gap-1 bg-background-primary-default p-3"
        >
          <span className="inline-flex items-center gap-1 text-caption-1-regular text-text-secondary">
            <item.icon className="size-3.5" aria-hidden />
            {item.label}
          </span>
          <code className="truncate font-mono text-[0.8rem]">{item.value}</code>
        </div>
      ))}
    </div>
  );
}
