import type { Bucket } from '../api/types';

export type RangePreset = '24h' | '7d' | '30d' | '90d' | 'custom';

export interface DateRange {
  preset: RangePreset;
  from: string;
  to: string;
  bucket: Bucket;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const PRESETS: { id: Exclude<RangePreset, 'custom'>; label: string }[] = [
  { id: '24h', label: '24h' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
];

function startOfUtcDay(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Buckets are UTC on the server, so ranges are aligned to UTC hours / days. */
export function presetRange(preset: Exclude<RangePreset, 'custom'>, now: number = Date.now()): DateRange {
  const to = new Date(now).toISOString();
  if (preset === '24h') {
    const from = Math.floor(now / HOUR) * HOUR - 23 * HOUR;
    return { preset, from: new Date(from).toISOString(), to, bucket: 'hour' };
  }
  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 90;
  const from = startOfUtcDay(now) - (days - 1) * DAY;
  return { preset, from: new Date(from).toISOString(), to, bucket: 'day' };
}

/** Custom range from two YYYY-MM-DD inputs (inclusive). Short spans use hourly buckets. */
export function customRange(fromDate: string, toDate: string): DateRange | null {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const toStart = Date.parse(`${toDate}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(toStart) || toStart < from) return null;
  const to = Math.min(toStart + DAY - 1, Date.now());
  const bucket: Bucket = to - from <= 2 * DAY ? 'hour' : 'day';
  return { preset: 'custom', from: new Date(from).toISOString(), to: new Date(to).toISOString(), bucket };
}

export function isoDate(iso: string): string {
  return iso.slice(0, 10);
}
