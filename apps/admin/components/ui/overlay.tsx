'use client';

import type { ComponentType, ReactNode } from 'react';
import {
  Button as AriaButton,
  Dialog,
  Heading,
  ListBox,
  ListBoxItem,
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  MenuTrigger,
  Modal,
  ModalOverlay,
  Popover,
  Select as AriaSelect,
  SelectValue,
  Separator,
  type Key,
} from 'react-aria-components';
import { RiArrowDownSLine, RiCheckLine, RiCloseLine } from 'react-icons/ri';
import { cx } from '@/utils/cx';

type Icon = ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;

const popoverSurface =
  'border border-separator-border bg-surface-raised shadow-dropdown outline-none entering:animate-[pop-in_120ms_ease-out] exiting:animate-[pop-out_90ms_ease-in]';

/**
 * A right-hand sheet for details and forms: the list stays visible behind it. Escape and the backdrop close it;
 * focus is trapped and returned (react-aria Modal).
 */
export function Drawer({
  open,
  onOpenChange,
  title,
  subtitle,
  actions,
  width = 560,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  width?: number;
  children: ReactNode;
}) {
  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={onOpenChange}
      isDismissable
      className="fixed inset-0 z-50 bg-neutral-950/40 backdrop-blur-[1px] entering:animate-[fade-in_150ms_ease-out] exiting:animate-[fade-out_120ms_ease-in]"
    >
      <Modal
        className="fixed inset-y-0 right-0 flex max-w-full border-l border-separator-border bg-background-full shadow-lg outline-none entering:animate-[slide-in-right_200ms_cubic-bezier(0.2,0.8,0.2,1)] exiting:animate-[slide-out-right_150ms_ease-in]"
        style={{ width }}
      >
        <Dialog className="flex h-full w-full flex-col outline-none">
          {({ close }) => (
            <>
              <header className="flex items-start gap-3 border-b border-separator-border px-5 py-4">
                <div className="min-w-0 flex-1">
                  <Heading slot="title" className="truncate font-mono text-[15px] font-medium text-text-primary">
                    {title}
                  </Heading>
                  {subtitle && <div className="mt-0.5 text-caption-1-regular text-text-secondary">{subtitle}</div>}
                </div>
                {actions}
                <AriaButton
                  onPress={close}
                  aria-label="Close"
                  className="grid size-8 place-items-center text-text-secondary outline-none hover:bg-background-secondary-default hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
                >
                  <RiCloseLine className="size-4" aria-hidden />
                </AriaButton>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

export interface MenuAction {
  id: string;
  label: string;
  icon?: Icon;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onAction?: () => void;
  /** Start a new section before this item. */
  separator?: boolean;
}

/** A dropdown of actions on any trigger (react-aria: arrow keys, typeahead, Escape). */
export function Menu({
  trigger,
  items,
  label,
  placement = 'bottom end',
}: {
  trigger: ReactNode;
  items: MenuAction[];
  label: string;
  placement?: 'bottom end' | 'bottom start' | 'top end' | 'right top';
}) {
  return (
    <MenuTrigger>
      {trigger}
      <Popover placement={placement} offset={4} className={cx(popoverSurface, 'min-w-48 p-1')}>
        <AriaMenu
          aria-label={label}
          className="outline-none"
          onAction={(key: Key) => items.find((item) => item.id === key)?.onAction?.()}
          disabledKeys={items.filter((item) => item.disabled).map((item) => item.id)}
        >
          {items.flatMap((item) => [
            ...(item.separator ? [<Separator key={`${item.id}-sep`} className="my-1 border-t border-separator-border" />] : []),
            <AriaMenuItem
              key={item.id}
              id={item.id}
              textValue={item.label}
              className={cx(
                'flex h-8 cursor-default items-center gap-2 px-2 text-body-regular outline-none',
                'focus:bg-background-secondary-default disabled:opacity-40',
                item.danger ? 'text-text-error-primary' : 'text-text-primary',
              )}
            >
              {item.icon && <item.icon className="size-4 shrink-0 text-current opacity-70" aria-hidden />}
              <span className="flex-1 truncate">{item.label}</span>
              {item.shortcut && <kbd className="font-mono text-[10px] text-text-tertiary">{item.shortcut}</kbd>}
            </AriaMenuItem>,
          ])}
        </AriaMenu>
      </Popover>
    </MenuTrigger>
  );
}

/** A compact select for toolbars and filters. */
export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  icon: IconComponent,
  className,
  size = 'small',
}: {
  value: T;
  onChange(value: T): void;
  options: { id: T; label: string; description?: string }[];
  label: string;
  icon?: Icon;
  className?: string;
  size?: 'small' | 'medium';
}) {
  return (
    <AriaSelect
      aria-label={label}
      selectedKey={value}
      onSelectionChange={(key) => key !== null && onChange(key as T)}
      className={className}
    >
      <AriaButton
        className={cx(
          'inline-flex w-full items-center gap-1.5 border border-border-button-default bg-background-primary-default px-2 text-body-regular text-text-primary outline-none',
          'hover:border-border-button-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring',
          size === 'small' ? 'h-8' : 'h-9',
        )}
      >
        {IconComponent && <IconComponent className="size-4 shrink-0 text-text-tertiary" aria-hidden />}
        <SelectValue className="flex-1 truncate text-left" />
        <RiArrowDownSLine className="size-4 shrink-0 text-text-tertiary" aria-hidden />
      </AriaButton>
      <Popover offset={4} className={cx(popoverSurface, 'min-w-(--trigger-width) p-1')}>
        <ListBox className="max-h-80 overflow-y-auto outline-none">
          {options.map((option) => (
            <ListBoxItem
              key={option.id}
              id={option.id}
              textValue={option.label}
              className="group flex cursor-default items-center gap-2 px-2 py-1.5 text-body-regular text-text-primary outline-none focus:bg-background-secondary-default"
            >
              {({ isSelected }) => (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{option.label}</span>
                    {option.description && (
                      <span className="block truncate text-caption-1-regular text-text-tertiary">{option.description}</span>
                    )}
                  </span>
                  {isSelected && <RiCheckLine className="size-4 shrink-0 text-signal" aria-hidden />}
                </>
              )}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}

/** A plain square icon button for toolbars and panel headers (react-aria, so it works as a Menu trigger). */
export function ToolButton({
  icon: IconComponent,
  label,
  onPress,
  active,
  className,
  children,
}: {
  icon: Icon;
  label: string;
  onPress?: () => void;
  active?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <AriaButton
      aria-label={label}
      onPress={onPress}
      className={cx(
        'inline-flex h-7 min-w-7 items-center justify-center gap-1 px-1.5 text-text-secondary outline-none',
        'hover:bg-background-secondary-default hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring',
        'pressed:bg-background-secondary-hover',
        active && 'bg-signal-soft text-signal hover:bg-signal-soft hover:text-signal',
        className,
      )}
    >
      <IconComponent className="size-4 shrink-0" aria-hidden />
      {children && <span className="text-caption-1-medium">{children}</span>}
    </AriaButton>
  );
}
