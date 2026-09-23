import type { Analytics } from '../api/types';
import { capitalize, countryName, formatCount } from '../lib/format';
import { Breakdown, ClicksChart } from './Charts';
import { Skeleton } from './ui';

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat">
      <p className="stat__label">{label}</p>
      <p className="stat__value">{value}</p>
      {hint && <p className="stat__hint">{hint}</p>}
    </div>
  );
}

function Referrer({ name }: { name: string }) {
  const direct = name === 'direct' || name === '(direct)' || name === '';
  return (
    <span className="ref">
      <span className="ref__dot" aria-hidden="true">
        {direct ? '↗' : name.replace(/^www\./, '').charAt(0).toUpperCase()}
      </span>
      {direct ? 'Direct / none' : name}
    </span>
  );
}

function Country({ name }: { name: string }) {
  return (
    <span className="ref">
      <span className="cc" aria-hidden="true">
        {/^[A-Za-z]{2}$/.test(name) ? name.toUpperCase() : '??'}
      </span>
      {countryName(name)}
    </span>
  );
}

export function AnalyticsSkeleton() {
  return (
    <div className="stack-lg" aria-busy="true" aria-label="Loading analytics">
      <div className="stats">
        {[0, 1, 2].map((i) => (
          <div key={i} className="stat">
            <Skeleton width={90} height={12} />
            <Skeleton width={70} height={28} />
          </div>
        ))}
      </div>
      <div className="card">
        <Skeleton height={260} className="skeleton--block" />
      </div>
      <div className="breakdowns">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="card">
            <Skeleton height={180} className="skeleton--block" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Shared by the private link page and the public stats page. */
export function AnalyticsView({ data, liveExtra = 0 }: { data: Analytics; liveExtra?: number }) {
  const { totals, range } = data;
  const clicks = totals.clicks + liveExtra;
  const humans = totals.clicks + totals.bots;
  return (
    <div className="stack-lg">
      <div className="stats">
        <Stat label="Clicks" value={formatCount(clicks)} hint={liveExtra > 0 ? `+${liveExtra} live since page load` : 'In selected range'} />
        <Stat label="Unique visitors" value={formatCount(totals.uniqueVisitors)} hint="HyperLogLog, ±0.8%" />
        <Stat
          label="Bots filtered"
          value={formatCount(totals.bots)}
          hint={humans > 0 ? `${Math.round((totals.bots / humans) * 100)}% of raw traffic` : 'Not counted as clicks'}
        />
      </div>
      <section className="card">
        <header className="card__head">
          <h2 className="card__title">Clicks over time</h2>
          <span className="card__meta">Per {range.bucket} · UTC</span>
        </header>
        <ClicksChart data={data.timeseries} bucket={range.bucket} />
      </section>
      <div className="breakdowns">
        <Breakdown title="Top referrers" items={data.referrers} renderName={(n) => <Referrer name={n} />} />
        <Breakdown title="Countries" items={data.countries} renderName={(n) => <Country name={n} />} />
        <Breakdown title="Devices" items={data.devices} renderName={capitalize} />
        <Breakdown title="Browsers" items={data.browsers} />
        <Breakdown title="Operating systems" items={data.os} />
      </div>
    </div>
  );
}
