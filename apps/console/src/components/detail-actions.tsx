'use client';

import type { Detail } from '@better-compute/console-kit';
import { useAction, useStore } from '@better-compute/console-kit/react';
import { ErrorLine } from './ui';

/**
 * One button per action on the item: disabled when its state does not allow it (the server still decides).
 * `confirm` names the actions that ask first (destructive ones), with the question.
 */
export function DetailActions({
  detail,
  only,
  confirm,
}: {
  detail: Detail;
  only?: readonly string[];
  confirm?: Readonly<Record<string, string>>;
}) {
  const state = useStore(detail);
  const actions = state.actions.filter((action) => !only || only.includes(action.path));
  return (
    <div className="row">
      {actions.map((action) => (
        <ActionButton
          key={action.path}
          detail={detail}
          path={action.path}
          label={action.method}
          enabled={action.applicable && action.allowed !== false}
          {...(confirm?.[action.path] ? { question: confirm[action.path] } : {})}
        />
      ))}
    </div>
  );
}

function ActionButton({
  detail,
  path,
  label,
  enabled,
  question,
}: {
  detail: Detail;
  path: string;
  label: string;
  enabled: boolean;
  question?: string;
}) {
  const action = useAction(detail, path);
  return (
    <span>
      <button
        disabled={!enabled || action.pending}
        onClick={() => {
          if (question && !window.confirm(question)) return;
          void action.run();
        }}
      >
        {label}
      </button>
      {action.outcome?.status === 'confirmation-required' && (
        <span className="warning"> awaiting approval ({action.outcome.confirmationId})</span>
      )}
      {action.error ? <ErrorLine error={action.error} /> : null}
    </span>
  );
}
