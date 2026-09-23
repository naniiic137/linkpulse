import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { Link, Overview } from '../api/types';
import { ClicksChart } from '../components/Charts';
import { Icon, type IconName } from '../components/Icon';
import { ConfirmDialog, CreateLinkDialog, EditLinkDialog, shortBase } from '../components/LinkDialogs';
import { LinkTable, LinkTableSkeleton } from '../components/LinkTable';
import { EmptyState, ErrorState, Skeleton } from '../components/ui';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import { formatCount, hostOf } from '../lib/format';

function Kpi({ icon, label, value, sub }: { icon: IconName; label: string; value: string | null; sub?: string }) {
  return (
    <div className="kpi">
      <span className="kpi__icon" aria-hidden="true">
        <Icon name={icon} size={17} />
      </span>
      <div>
        <p className="kpi__label">{label}</p>
        <p className="kpi__value">{value ?? <Skeleton width={72} height={26} />}</p>
        {sub && <p className="kpi__sub">{sub}</p>}
      </div>
    </div>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function Dashboard() {
  const { toast } = useToast();
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 250);
  const overview = useAsync<Overview>((s) => api.overview(30, s), []);
  const links = useAsync((s) => api.listLinks({ q, limit: 20 }, s), [q]);
  const [extra, setExtra] = useState<Link[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Link | null>(null);
  const [deleting, setDeleting] = useState<Link | null>(null);

  useEffect(() => {
    setExtra([]);
    setCursor(links.data?.nextCursor ?? null);
  }, [links.data]);

  const all = [...(links.data?.items ?? []), ...extra];
  const replace = (updated: Link) => {
    links.setData((prev) => prev && { ...prev, items: prev.items.map((l) => (l.id === updated.id ? updated : l)) });
    setExtra((xs) => xs.map((l) => (l.id === updated.id ? updated : l)));
  };

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await api.listLinks({ q, limit: 20, cursor });
      setExtra((xs) => [...xs, ...page.items]);
      setCursor(page.nextCursor);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load more links.', 'error');
    } finally {
      setLoadingMore(false);
    }
  };

  const toggle = async (link: Link) => {
    try {
      const updated = await api.updateLink(link.id, { disabled: !link.disabled });
      replace(updated);
      toast(updated.disabled ? `Disabled /${link.code}. Visitors now get a 410.` : `Enabled /${link.code}.`);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not update the link.', 'error');
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await api.deleteLink(deleting.id);
      links.setData((prev) => prev && { ...prev, items: prev.items.filter((l) => l.id !== deleting.id) });
      setExtra((xs) => xs.filter((l) => l.id !== deleting.id));
      toast(`Deleted /${deleting.code}.`);
      setDeleting(null);
      overview.reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not delete the link.', 'error');
    }
  };

  const ov = overview.data;
  const top = ov?.topLinks ?? [];
  const topMax = top.reduce((m, t) => Math.max(m, t.clicks), 0);

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Links</h1>
          <p className="page__sub">Every short link you own, and how it is performing over the last 30 days.</p>
        </div>
        <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={16} /> New link
        </button>
      </header>

      {overview.error ? (
        <ErrorState message={overview.error.message} onRetry={overview.reload} />
      ) : (
        <>
          <section className="kpis" aria-label="Summary, last 30 days">
            <Kpi icon="cursor" label="Clicks · 30 days" value={ov ? formatCount(ov.totals.clicks) : null} sub="Humans only, bots filtered" />
            <Kpi icon="users" label="Unique visitors" value={ov ? formatCount(ov.totals.uniqueVisitors) : null} sub="HyperLogLog estimate" />
            <Kpi
              icon="link"
              label="Active links"
              value={ov ? formatCount(ov.totals.activeLinks) : null}
              sub={ov ? `of ${formatCount(ov.totals.links)} total` : undefined}
            />
            <Kpi
              icon="activity"
              label="Avg. per day"
              value={ov ? formatCount(Math.round(ov.totals.clicks / Math.max(1, ov.timeseries.length))) : null}
              sub="Clicks, last 30 days"
            />
          </section>

          <div className="grid-2">
            <section className="card">
              <header className="card__head">
                <h2 className="card__title">Clicks over time</h2>
                <span className="card__meta">Last 30 days · UTC</span>
              </header>
              {ov ? <ClicksChart data={ov.timeseries} bucket="day" height={280} /> : <Skeleton height={260} className="skeleton--block" />}
            </section>
            <section className="card">
              <header className="card__head">
                <h2 className="card__title">Top links</h2>
                <span className="card__meta">30 days</span>
              </header>
              {!ov ? (
                <div className="stack-sm">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <Skeleton key={i} height={34} className="skeleton--block" />
                  ))}
                </div>
              ) : top.length === 0 ? (
                <p className="muted small">No clicks yet. Share a link to see it here.</p>
              ) : (
                <ol className="top-links">
                  {top.slice(0, 5).map((t, i) => (
                    <li key={t.id}>
                      <RouterLink to={`/app/links/${t.id}`} className="top-links__row">
                        <span className="top-links__rank">{i + 1}</span>
                        <span className="top-links__text">
                          <span className="top-links__code">/{t.code}</span>
                          <span className="top-links__dest">{t.title ?? hostOf(t.url)}</span>
                        </span>
                        <span className="top-links__value">{formatCount(t.clicks)}</span>
                        <span className="top-links__bar" style={{ width: `${topMax ? (t.clicks / topMax) * 100 : 0}%` }} aria-hidden="true" />
                      </RouterLink>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
        </>
      )}

      <section className="card card--flush" aria-labelledby="links-heading">
        <header className="card__head card__head--pad">
          <h2 className="card__title" id="links-heading">
            All links
          </h2>
          <div className="search">
            <Icon name="search" size={16} />
            <label htmlFor="link-search" className="sr-only">
              Search links
            </label>
            <input
              id="link-search"
              type="search"
              placeholder="Search by code, URL or title"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </header>
        {links.error ? (
          <ErrorState message={links.error.message} onRetry={links.reload} />
        ) : !links.data ? (
          <LinkTableSkeleton />
        ) : all.length === 0 ? (
          q ? (
            <EmptyState icon="search" title={`No links match “${q}”`}>
              Try a different code, domain or title.
            </EmptyState>
          ) : (
            <EmptyState
              icon="link"
              title="No links yet"
              action={
                <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
                  <Icon name="plus" size={16} /> Create your first link
                </button>
              }
            >
              Shorten a URL to start collecting real-time analytics.
            </EmptyState>
          )
        ) : (
          <>
            <LinkTable links={all} onEdit={setEditing} onToggle={toggle} onDelete={setDeleting} />
            {cursor && (
              <div className="load-more">
                <button type="button" className="btn btn--secondary" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}
      </section>

      <CreateLinkDialog
        open={creating}
        onClose={() => setCreating(false)}
        baseUrl={shortBase(links.data?.items)}
        onCreated={(link) => {
          links.setData((prev) => prev && { ...prev, items: [link, ...prev.items] });
          overview.reload();
        }}
      />
      <EditLinkDialog
        link={editing}
        onClose={() => setEditing(null)}
        onSaved={(l) => {
          replace(l);
          setEditing(null);
          toast('Link updated.');
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete /${deleting?.code ?? ''}?`}
        body="The short link stops working immediately and its analytics are removed. This cannot be undone."
        confirmLabel="Delete link"
        onConfirm={remove}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}
