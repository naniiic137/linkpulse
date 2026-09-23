import type { Bucket } from '../domain/types.js';

export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export function bucketMs(bucket: Bucket): number {
  return bucket === 'hour' ? HOUR : DAY;
}

/** Floor a timestamp to the start of its UTC hour/day. */
export function truncate(ts: number, bucket: Bucket): number {
  const size = bucketMs(bucket);
  return Math.floor(ts / size) * size;
}

/** All bucket starts covering [from, to), so charts get explicit zeros. */
export function bucketStarts(from: Date, to: Date, bucket: Bucket): number[] {
  const out: number[] = [];
  const size = bucketMs(bucket);
  for (let t = truncate(from.getTime(), bucket); t < to.getTime(); t += size) out.push(t);
  return out;
}

/** UTC day key (YYYYMMDD) used to name per-day HyperLogLog counters. */
export function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10).replace(/-/g, '');
}

export function dayKeysBetween(from: Date, to: Date): string[] {
  return bucketStarts(from, to, 'day').map(dayKey);
}

/** Pick a sensible bucket: hourly for ranges up to 3 days, daily beyond. */
export function autoBucket(from: Date, to: Date): Bucket {
  return to.getTime() - from.getTime() <= 3 * DAY ? 'hour' : 'day';
}
