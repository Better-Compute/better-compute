'use client';

import { useEffect, useState } from 'react';
import { RiRefreshLine } from 'react-icons/ri';
import { Button } from '@/components/base/buttons/button';
import { Switch } from '@/components/base/switch/switch';
import { Drawer, Select } from '@/components/ui/overlay';
import { widgetSettings, type WidgetDef } from '@/lib/modules';
import type { WidgetInstance } from './layout';
import { sites } from '@/lib/data';
import { isRangeKey, RANGES, ScopeOverrideProvider, type RangeKey, type ScopeOverride } from '@/components/shell/workspace';

type Values = Record<string, string | number | boolean>;

/** A widget instance's title and settings, with a live preview of the widget as configured. */
export function ConfigureWidget({
  def,
  instance,
  onSave,
  onClose,
}: {
  def: WidgetDef | null;
  instance: WidgetInstance | null;
  onSave(patch: { title?: string; settings: Values }): void;
  onClose(): void;
}) {
  const [title, setTitle] = useState('');
  const [values, setValues] = useState<Values>({});
  useEffect(() => {
    if (!def || !instance) return;
    setTitle(instance.title ?? '');
    setValues(widgetSettings(def, instance.settings));
  }, [def, instance]);

  const set = (id: string, value: string | number | boolean) => setValues((v) => ({ ...v, [id]: value }));

  return (
    <Drawer open={Boolean(def && instance)} onOpenChange={(open) => !open && onClose()} title={def ? `Configure ${def.title}` : ''} subtitle={def?.description} width={520}>
      {def && instance && (
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            onSave({ title: title.trim() || undefined, settings: values });
            onClose();
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Title</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={def.title}
              className="h-9 border border-border-button-default bg-background-primary-default px-2 text-body-regular text-text-primary outline-none placeholder:text-text-placeholder focus:ring-2 focus:ring-border-focus-ring"
            />
          </label>

          {(def.pins?.site !== false || def.pins?.range) && (
            <div className="grid gap-3 sm:grid-cols-2">
              {def.pins?.site !== false && (
                <div className="flex flex-col gap-1.5">
                  <span className="font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Site</span>
                  <Select
                    label="Site"
                    size="medium"
                    value={String(values.$site || '')}
                    onChange={(value) => set('$site', value)}
                    options={[
                      { id: '', label: 'Follow the workspace' },
                      { id: 'all', label: 'All sites, always' },
                      ...sites.map((site) => ({ id: site.id, label: `${site.id} · ${site.city}` })),
                    ]}
                  />
                </div>
              )}
              {def.pins?.range && (
                <div className="flex flex-col gap-1.5">
                  <span className="font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Time range</span>
                  <Select
                    label="Time range"
                    size="medium"
                    value={String(values.$range || '')}
                    onChange={(value) => set('$range', value)}
                    options={[{ id: '', label: 'Follow the workspace' }, ...(Object.keys(RANGES) as RangeKey[]).map((key) => ({ id: key, label: RANGES[key].label }))]}
                  />
                </div>
              )}
            </div>
          )}

          {def.settings?.map((setting) => (
            <div key={setting.id} className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] tracking-wide text-text-tertiary uppercase">{setting.label}</span>
              {setting.type === 'select' && (
                <Select
                  label={setting.label}
                  size="medium"
                  value={String(values[setting.id] ?? setting.default)}
                  onChange={(value) => set(setting.id, value)}
                  options={setting.options.map((o) => ({ id: o.value, label: o.label }))}
                />
              )}
              {setting.type === 'toggle' && (
                <Switch isSelected={Boolean(values[setting.id] ?? setting.default)} onChange={(on) => set(setting.id, on)}>
                  {setting.hint ?? setting.label}
                </Switch>
              )}
              {setting.type === 'number' && (
                <input
                  type="number"
                  min={setting.min}
                  max={setting.max}
                  step={setting.step ?? 1}
                  value={Number(values[setting.id] ?? setting.default)}
                  onChange={(event) => set(setting.id, Number(event.target.value))}
                  className="h-9 w-40 border border-border-button-default bg-background-primary-default px-2 font-mono text-[13px] text-text-primary outline-none focus:ring-2 focus:ring-border-focus-ring"
                />
              )}
              {setting.hint && setting.type !== 'toggle' && <span className="text-caption-1-regular text-text-tertiary">{setting.hint}</span>}
            </div>
          ))}

          <div>
            <span className="mb-1.5 block font-mono text-[11px] tracking-wide text-text-tertiary uppercase">Preview</span>
            <div className="h-72 overflow-hidden border border-separator-border bg-surface-raised">
              <ScopeOverrideProvider value={overrideFrom(values)}>
                <def.component size={{ w: 6, h: 4 }} editing={false} settings={values} />
              </ScopeOverrideProvider>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-separator-border pt-4">
            <Button type="button" variant="ghost" size="small" leadingIcon={RiRefreshLine} onClick={() => { setTitle(''); setValues(widgetSettings(def)); }}>
              Defaults
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" size="small" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" size="small">
                Save
              </Button>
            </div>
          </div>
        </form>
      )}
    </Drawer>
  );
}

/** The scope pins stored in an instance's settings ($site, $range) as a ScopeOverride. */
export function overrideFrom(saved?: Values): ScopeOverride {
  const site = saved?.$site;
  const range = saved?.$range;
  return {
    ...(typeof site === 'string' && site ? { siteId: site === 'all' ? null : site } : {}),
    ...(isRangeKey(range) ? { range } : {}),
  };
}

/** "gpu · fra1": the non-default setting values and pins, for the widget's title bar. */
export function settingsSummary(def: WidgetDef, saved?: Values): string | undefined {
  if (!saved) return undefined;
  const pins = [
    typeof saved.$site === 'string' && saved.$site ? (saved.$site === 'all' ? 'all sites' : saved.$site) : null,
    typeof saved.$range === 'string' && saved.$range ? saved.$range : null,
  ].filter((p): p is string => Boolean(p));
  if (!def.settings?.length) return pins.length ? pins.join(' · ') : undefined;
  const parts = def.settings.flatMap((setting) => {
    const value = saved[setting.id];
    if (value === undefined || value === setting.default) return [];
    if (setting.type === 'select') return [setting.options.find((o) => o.value === value)?.label ?? String(value)];
    if (setting.type === 'toggle') return [value ? setting.label.toLowerCase() : `no ${setting.label.toLowerCase()}`];
    return [`${setting.label.toLowerCase()} ${value}`];
  });
  const all = [...pins, ...parts];
  return all.length ? all.join(' · ') : undefined;
}
