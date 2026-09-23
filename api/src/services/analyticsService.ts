import { badRequest } from '../domain/errors.js';
import type { Bucket, ClickRecord, LinkRecord, NamedCount } from '../domain/types.js';
import { autoBucket, bucketStarts, DAY, dayKeysBetween } from '../lib/time.js';
import type { Store, UniqueCounter } from '../stores/types.js';
import { linkUniqueKey, ownerUniqueKey } from './clickPipeline.js';

export interface AnalyticsDto {
  linkId: string;
  range: { from: string; to: string; bucket: Bucket };
  totals: { clicks: number; uniqueVisitors: number; bots: number };
  timeseries: { t: string; clicks: number }[];
  referrers: NamedCount[];
  countries: NamedCount[];
  browsers: NamedCount[];
  os: NamedCount[];
  devices: NamedCount[];
}

export interface OverviewDto {
  range: { from: string; to: string };
  totals: { links: number; activeLinks: number; clicks: number; uniqueVisitors: number };
  timeseries: { t: string; clicks: number }[];
  topLinks: { id: string; code: string; title: string | null; url: string; clicks: number }[];
}

const MAX_RANGE_DAYS = 366;
const MAX_POINTS = 2000;

export interface RangeQuery {
  from?: string;
  to?: string;
  bucket?: Bucket;
}

/** Parse and bound a user-supplied date range (default: last 30 days). */
export function resolveRange(q: RangeQuery, now: Date): { from: Date; to: Date; bucket: Bucket } {
  const to = q.to ? new Date(q.to) : now;
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * DAY);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw badRequest('validation_error', 'from/to must be ISO-8601 dates');
  }
  if (from.getTime() >= to.getTime()) throw badRequest('validation_error', '"from" must be before "to"');
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY) {
    throw badRequest('validation_error', `Range cannot exceed ${MAX_RANGE_DAYS} days`);
  }
  const bucket = q.bucket ?? autoBucket(from, to);
  if (bucketStarts(from, to, bucket).length > MAX_POINTS) {
    throw badRequest('validation_error', 'Too many points: use bucket=day for long ranges');
  }
  return { from, to, bucket };
}

function fill(from: Date, to: Date, bucket: Bucket, series: { t: Date; clicks: number }[]) {
  const byT = new Map(series.map((s) => [s.t.getTime(), s.clicks]));
  return bucketStarts(from, to, bucket).map((t) => ({ t: new Date(t).toISOString(), clicks: byT.get(t) ?? 0 }));
}

export class AnalyticsService {
  constructor(private readonly d: { store: Store; uniques: UniqueCounter }) {}

  async forLink(link: LinkRecord, range: { from: Date; to: Date; bucket: Bucket }): Promise<AnalyticsDto> {
    const [agg, uniqueVisitors] = await Promise.all([
      this.d.store.aggregateClicks(link.id, range, range.bucket),
      // Uniques are day-granular: PFCOUNT over the per-day HyperLogLogs merges them on the fly.
      this.d.uniques.count(dayKeysBetween(range.from, range.to).map((day) => linkUniqueKey(link.id, day))),
    ]);
    return {
      linkId: link.id,
      range: { from: range.from.toISOString(), to: range.to.toISOString(), bucket: range.bucket },
      // A HyperLogLog estimate can exceed the exact count by <1%; never show more uniques than clicks.
      totals: { clicks: agg.clicks, uniqueVisitors: Math.min(uniqueVisitors, agg.clicks), bots: agg.bots },
      timeseries: fill(range.from, range.to, range.bucket, agg.series),
      referrers: agg.referrers,
      countries: agg.countries,
      browsers: agg.browsers,
      os: agg.os,
      devices: agg.devices,
    };
  }

  async overview(ownerId: string, days: number, now: Date): Promise<OverviewDto> {
    // Whole UTC days: [start of the first day, start of tomorrow) so today's clicks are included.
    const tomorrow = Math.floor(now.getTime() / DAY) * DAY + DAY;
    const to = new Date(tomorrow);
    const from = new Date(tomorrow - days * DAY);
    const range = { from, to };
    const [counts, agg, uniques] = await Promise.all([
      this.d.store.countLinks(ownerId, now),
      this.d.store.aggregateOwner(ownerId, range, 5),
      this.d.uniques.count(dayKeysBetween(from, to).map((day) => ownerUniqueKey(ownerId, day))),
    ]);
    const top = await Promise.all(
      agg.topLinks.map(async (t) => {
        const link = await this.d.store.findLinkById(t.linkId);
        return link ? { id: link.id, code: link.code, title: link.title, url: link.url, clicks: t.clicks } : null;
      }),
    );
    return {
      range: { from: from.toISOString(), to: to.toISOString() },
      totals: {
        links: counts.total,
        activeLinks: counts.active,
        clicks: agg.clicks,
        uniqueVisitors: Math.min(uniques, agg.clicks),
      },
      timeseries: fill(from, to, 'day', agg.series),
      topLinks: top.filter((t): t is NonNullable<typeof t> => t !== null),
    };
  }

  exportRows(linkId: string, range: { from: Date; to: Date }): Promise<ClickRecord[]> {
    return this.d.store.exportClicks(linkId, range, 100_000);
  }
}

const CSV_HEADER = ['timestamp', 'referrer', 'country', 'device', 'browser', 'os', 'is_bot'];

/** RFC 4180 quoting, plus a leading quote on values that spreadsheets would treat as formulas. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows: ClickRecord[]): string {
  const lines = [CSV_HEADER.join(',')];
  for (const r of rows) {
    lines.push(
      [r.ts.toISOString(), r.referrer, r.country, r.device, r.browser, r.os, String(r.isBot)].map(csvCell).join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
