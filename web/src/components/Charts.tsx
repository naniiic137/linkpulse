import { useId, useMemo, useState, type ReactNode } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Bucket, NamedCount, TimePoint } from '../api/types';
import { formatBucket, formatCount, formatPercent } from '../lib/format';

interface ClicksChartProps {
  data: TimePoint[];
  bucket: Bucket;
  height?: number;
  label?: string;
}

interface TooltipPayload {
  active?: boolean;
  payload?: { value: number; payload: TimePoint }[];
  bucket: Bucket;
}

function ChartTooltip({ active, payload, bucket }: TooltipPayload) {
  const point = payload?.[0];
  if (!active || !point) return null;
  const d = new Date(point.payload.t);
  const when =
    bucket === 'hour'
      ? d.toLocaleString('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' });
  return (
    <div className="chart-tip">
      <span className="chart-tip__when">{when}</span>
      <span className="chart-tip__value">
        <strong>{formatCount(point.value)}</strong> {point.value === 1 ? 'click' : 'clicks'}
      </span>
    </div>
  );
}

/** Single-series area chart of clicks per bucket. The accessible summary sits in a visually hidden caption. */
export function ClicksChart({ data, bucket, height = 260, label = 'Clicks over time' }: ClicksChartProps) {
  const gradientId = useId().replace(/:/g, '');
  const total = data.reduce((s, p) => s + p.clicks, 0);
  const peak = data.reduce<TimePoint | null>((best, p) => (!best || p.clicks > best.clicks ? p : best), null);
  const summary =
    `${label}: ${formatCount(total)} clicks across ${data.length} ${bucket === 'hour' ? 'hours' : 'days'}` +
    (peak && peak.clicks > 0 ? `, peaking at ${formatCount(peak.clicks)} on ${formatBucket(peak.t, bucket)}.` : '.');

  return (
    <figure className="chart" style={{ height }}>
      <figcaption className="sr-only">{summary}</figcaption>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.28} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis
            dataKey="t"
            tickFormatter={(t: string) => formatBucket(t, bucket)}
            tick={{ fill: 'var(--text-3)', fontSize: 12 }}
            axisLine={false}
            tickLine={false}
            minTickGap={28}
            tickMargin={8}
          />
          <YAxis
            allowDecimals={false}
            tickFormatter={(v: number) => formatCount(v)}
            tick={{ fill: 'var(--text-3)', fontSize: 12 }}
            axisLine={false}
            tickLine={false}
            width={48}
          />
          <Tooltip
            content={<ChartTooltip bucket={bucket} />}
            cursor={{ stroke: 'var(--accent)', strokeOpacity: 0.35, strokeDasharray: '4 4' }}
          />
          <Area
            type="monotone"
            dataKey="clicks"
            stroke="var(--accent)"
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)', fill: 'var(--accent)' }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </figure>
  );
}

interface BreakdownProps {
  title: string;
  items: NamedCount[];
  total?: number;
  renderName?: (name: string) => ReactNode;
  limit?: number;
  emptyText?: string;
}

/** Ranked horizontal bar list (the classic analytics "top N" table). */
export function Breakdown({ title, items, total, renderName, limit = 6, emptyText = 'No data in this range.' }: BreakdownProps) {
  const [expanded, setExpanded] = useState(false);
  const sum = total ?? items.reduce((s, i) => s + i.clicks, 0);
  const max = useMemo(() => items.reduce((m, i) => Math.max(m, i.clicks), 0), [items]);
  const shown = expanded ? items : items.slice(0, limit);

  return (
    <section className="card breakdown" aria-label={title}>
      <header className="breakdown__head">
        <h3 className="card__title">{title}</h3>
        <span className="breakdown__col">Clicks</span>
      </header>
      {items.length === 0 ? (
        <p className="breakdown__empty">{emptyText}</p>
      ) : (
        <ol className="breakdown__list">
          {shown.map((item) => (
            <li key={item.name} className="breakdown__row">
              <span className="breakdown__bar" style={{ width: `${max ? (item.clicks / max) * 100 : 0}%` }} aria-hidden="true" />
              <span className="breakdown__name">{renderName ? renderName(item.name) : item.name}</span>
              <span className="breakdown__value">
                {formatCount(item.clicks)}
                <span className="breakdown__pct">{formatPercent(item.clicks, sum)}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
      {items.length > limit && (
        <button type="button" className="link-btn breakdown__more" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
          {expanded ? 'Show less' : `Show all ${items.length}`}
        </button>
      )}
    </section>
  );
}

export function Sparkline({ data }: { data: TimePoint[] }) {
  if (data.length < 2) return null;
  const w = 96;
  const h = 28;
  const max = Math.max(1, ...data.map((d) => d.clicks));
  const step = w / (data.length - 1);
  const pts = data.map((d, i) => `${(i * step).toFixed(1)},${(h - 2 - (d.clicks / max) * (h - 4)).toFixed(1)}`).join(' ');
  return (
    <svg className="sparkline" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
