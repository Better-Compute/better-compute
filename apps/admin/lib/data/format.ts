// Formatting shared by every module: numbers are set in Plex Mono with tabular figures, so these return plain
// strings and leave typography to the view.

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });

/** 1234 → "1,234"; 1_234_567 → "1.2M" when `short`. */
export function fmtNum(value: number, options: { short?: boolean; decimals?: number } = {}): string {
  if (!Number.isFinite(value)) return '—';
  if (options.short && Math.abs(value) >= 10_000) return compact.format(value);
  if (options.decimals !== undefined)
    return value.toLocaleString('en', {
      minimumFractionDigits: options.decimals,
      maximumFractionDigits: options.decimals,
    });
  return Math.abs(value) < 10 && !Number.isInteger(value) ? oneDecimal.format(value) : whole.format(value);
}

/** 0.4567 → "45.7%" (ratio in, percent out). */
export function fmtPct(ratio: number, decimals = 1): string {
  if (!Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(decimals)}%`;
}

/** Signed delta for KPI trends: +3.2%, −1.0%. */
export function fmtDelta(ratio: number, decimals = 1): string {
  const sign = ratio > 0 ? '+' : ratio < 0 ? '−' : '±';
  return `${sign}${Math.abs(ratio * 100).toFixed(decimals)}%`;
}

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
export function fmtBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${UNITS[unit]}`;
}

/** GiB in, human out: 81920 → "80 TiB". */
export const fmtGiB = (gib: number) => fmtBytes(gib * 1024 ** 3);

/** Milliseconds → "3d 4h", "12m 05s", "850 ms". */
export function fmtDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 1000) return `${Math.round(abs)} ms`;
  const s = Math.floor(abs / 1000);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

/** "3m ago", "in 2h", relative to `now` (the workspace clock). */
export function fmtRelative(t: number, now: number): string {
  const diff = t - now;
  const text = fmtDuration(Math.abs(diff)).split(' ')[0]!;
  if (Math.abs(diff) < 5_000) return 'now';
  return diff < 0 ? `${text} ago` : `in ${text}`;
}

const money = new Intl.NumberFormat('en', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const moneyCents = new Intl.NumberFormat('en', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
export function fmtMoney(value: number, options: { cents?: boolean; short?: boolean } = {}): string {
  if (options.short && Math.abs(value) >= 10_000) return `$${compact.format(value)}`;
  return (options.cents ? moneyCents : money).format(value);
}

/** UTC clock time "14:05:09" — operators read one timezone. */
export function fmtClock(t: number, seconds = true): string {
  const iso = new Date(t).toISOString();
  return seconds ? iso.slice(11, 19) : iso.slice(11, 16);
}

/** "Sep 26 14:05" in UTC. */
export function fmtStamp(t: number): string {
  const date = new Date(t);
  const month = date.toLocaleString('en', { month: 'short', timeZone: 'UTC' });
  return `${month} ${date.getUTCDate()} ${fmtClock(t, false)}`;
}

/** Pluralise: plural(3, 'node') → "3 nodes". */
export const plural = (n: number, word: string, many = `${word}s`) => `${fmtNum(n)} ${n === 1 ? word : many}`;
