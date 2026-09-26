'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components';
import { RiCloseLine } from 'react-icons/ri';
import { Button } from '@/components/base/buttons/button';
import { cx } from '@/utils/cx';
import { Led, type Status } from './signal';

// Feedback for actions: toasts that say what happened (with an optional undo or link), and a confirm dialog that
// every destructive action goes through. `typeToConfirm` makes the operator type a name for irreversible ones.

export interface Toast {
  id: number;
  title: string;
  detail?: string;
  status?: Status;
  action?: { label: string; onAction: () => void };
  /** ms before it goes; 0 keeps it until dismissed. Default 5000. */
  timeout?: number;
}

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** The operator must type this exactly (a node id, a pool name) before confirming. */
  typeToConfirm?: string;
}

interface Feedback {
  toast(toast: Omit<Toast, 'id'>): void;
  confirm(options: ConfirmOptions): Promise<boolean>;
}

const FeedbackContext = createContext<Feedback | null>(null);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pending, setPending] = useState<(ConfirmOptions & { resolve(ok: boolean): void }) | null>(null);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const toast = useCallback((input: Omit<Toast, 'id'>) => {
    const id = next.current++;
    setToasts((all) => [...all.slice(-3), { ...input, id }]);
  }, []);
  const confirm = useCallback(
    (options: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ ...options, resolve })),
    [],
  );
  const value = useMemo(() => ({ toast, confirm }), [toast, confirm]);

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-[80] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
      <ConfirmDialog
        options={pending}
        onClose={(ok) => {
          pending?.resolve(ok);
          setPending(null);
        }}
      />
    </FeedbackContext.Provider>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss(): void }) {
  useEffect(() => {
    const timeout = toast.timeout ?? 5000;
    if (!timeout) return;
    const timer = window.setTimeout(onDismiss, timeout);
    return () => window.clearTimeout(timer);
  }, [toast.timeout, onDismiss]);
  return (
    <div
      role="status"
      className="pointer-events-auto flex gap-3 border border-separator-border bg-surface-raised px-3 py-2.5 shadow-dropdown motion-safe:animate-[slide-in-right_180ms_ease-out]"
    >
      <Led status={toast.status ?? 'live'} className="mt-1.5" />
      <div className="min-w-0 flex-1">
        <div className="text-body-medium text-text-primary">{toast.title}</div>
        {toast.detail && <div className="text-caption-1-regular text-text-secondary">{toast.detail}</div>}
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action!.onAction();
              onDismiss();
            }}
            className="mt-1 font-mono text-[11px] text-signal hover:underline"
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="self-start text-text-tertiary hover:text-text-primary">
        <RiCloseLine className="size-4" aria-hidden />
      </button>
    </div>
  );
}

function ConfirmDialog({ options, onClose }: { options: ConfirmOptions | null; onClose(ok: boolean): void }) {
  const [typed, setTyped] = useState('');
  useEffect(() => setTyped(''), [options]);
  const blocked = Boolean(options?.typeToConfirm) && typed !== options?.typeToConfirm;
  return (
    <ModalOverlay
      isOpen={Boolean(options)}
      onOpenChange={(open) => !open && onClose(false)}
      isDismissable
      className="fixed inset-0 z-[70] grid place-items-center bg-neutral-950/50 p-4 entering:animate-[fade-in_120ms_ease-out]"
    >
      <Modal className="w-[460px] max-w-full border border-separator-border bg-surface-raised shadow-lg outline-none entering:animate-[pop-in_140ms_ease-out]">
        <Dialog role="alertdialog" className="outline-none">
          {options && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!blocked) onClose(true);
              }}
            >
              <div className={cx('border-b px-4 py-3', options.danger ? 'border-red-500/40' : 'border-separator-border')}>
                <Heading slot="title" className="font-mono text-[14px] font-medium text-text-primary">
                  {options.title}
                </Heading>
              </div>
              <div className="flex flex-col gap-3 px-4 py-4 text-body-regular text-text-secondary">
                {options.body}
                {options.typeToConfirm && (
                  <label className="flex flex-col gap-1.5">
                    <span className="text-caption-1-regular">
                      Type <span className="font-mono text-text-primary">{options.typeToConfirm}</span> to confirm.
                    </span>
                    <input
                      autoFocus
                      value={typed}
                      onChange={(event) => setTyped(event.target.value)}
                      spellCheck={false}
                      className="h-9 border border-border-button-default bg-background-primary-default px-2 font-mono text-[13px] text-text-primary outline-none focus:ring-2 focus:ring-border-focus-ring"
                    />
                  </label>
                )}
              </div>
              <div className="flex justify-end gap-2 border-t border-separator-border px-4 py-3">
                <Button variant="secondary" size="small" onClick={() => onClose(false)}>
                  Cancel
                </Button>
                <Button type="submit" variant={options.danger ? 'danger' : 'primary'} size="small" disabled={blocked} autoFocus={!options.typeToConfirm}>
                  {options.confirmLabel ?? 'Confirm'}
                </Button>
              </div>
            </form>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/** `const { toast, confirm } = useFeedback()`; `if (await confirm({ title, danger: true })) …`. */
export function useFeedback(): Feedback {
  const feedback = useContext(FeedbackContext);
  if (!feedback) throw new Error('useFeedback() outside <FeedbackProvider>');
  return feedback;
}
