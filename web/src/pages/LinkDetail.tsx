import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { Link } from '../api/types';
import { AnalyticsSkeleton, AnalyticsView } from '../components/AnalyticsView';
import { Icon } from '../components/Icon';
import { ConfirmDialog, EditLinkForm } from '../components/LinkDialogs';
import { QrCode } from '../components/QrCode';
import { RangePicker } from '../components/RangePicker';
import { CopyButton, EmptyState, ErrorState, Favicon, Skeleton, StatusBadge } from '../components/ui';
import { useAsync } from '../hooks/useAsync';
import { useLiveClicks } from '../hooks/useLiveClicks';
import { useToast } from '../hooks/useToast';
import { formatCount, formatDate, formatDateTime, prettyUrl } from '../lib/format';
import { presetRange, type DateRange } from '../lib/range';

function LivePill({ state, recent }: { state: 'connecting' | 'live' | 'offline'; recent: number }) {
  const text = state === 'live' ? 'Live' : state === 'connecting' ? 'Connecting' : 'Offline';
  return (
    <span className={`live live--${state}`} title="Clicks stream in over Server-Sent Events">
      <span className="live__dot" aria-hidden="true" />
      {text}
      {recent > 0 && <span className="live__count">+{recent}</span>}
      <span className="sr-only" aria-live="polite">
        {recent > 0 ? `${recent} new clicks since the page opened` : ''}
      </span>
    </span>
  );
}

export function LinkDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [range, setRange] = useState<DateRange>(() => presetRange('30d'));
  const link = useAsync<Link>((s) => api.getLink(id, s), [id]);
  const analytics = useAsync((s) => api.analytics(id, { from: range.from, to: range.to, bucket: range.bucket }, s), [id, range]);
  const [live, setLive] = useState(0);
  const [tab, setTab] = useState<'analytics' | 'settings'>('analytics');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => setLive(0), [analytics.data]);

  const onClick = useCallback(
    (e: { clicks: number }) => {
      setLive((n) => n + e.clicks);
      link.setData((l) => l && { ...l, clickCount: l.clickCount + e.clicks });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const liveState = useLiveClicks(link.data ? id : undefined, onClick);

  if (link.error) {
    if (link.error.status === 404) {
      return (
        <div className="page">
          <EmptyState
            icon="link"
            title="Link not found"
            action={
              <RouterLink className="btn btn--secondary" to="/app">
                Back to links
              </RouterLink>
            }
          >
            It may have been deleted, or it belongs to another account.
          </EmptyState>
        </div>
      );
    }
    return (
      <div className="page">
        <ErrorState message={link.error.message} onRetry={link.reload} />
      </div>
    );
  }

  const l = link.data;

  const toggle = async () => {
    if (!l) return;
    try {
      const updated = await api.updateLink(l.id, { disabled: !l.disabled });
      link.setData(updated);
      toast(updated.disabled ? 'Link disabled.' : 'Link enabled.');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not update the link.', 'error');
    }
  };

  return (
    <div className="page">
      <RouterLink to="/app" className="back">
        <Icon name="arrowLeft" size={16} /> All links
      </RouterLink>

      <section className="card link-hero">
        {!l ? (
          <div className="stack-sm">
            <Skeleton width={260} height={26} />
            <Skeleton width={340} />
          </div>
        ) : (
          <>
            <div className="link-hero__info">
              <div className="link-hero__title-row">
                <Favicon url={l.url} faviconUrl={l.faviconUrl} size={28} />
                <h1 className="link-hero__short">
                  <a href={l.shortUrl} target="_blank" rel="noreferrer">
                    {prettyUrl(l.shortUrl)}
                  </a>
                </h1>
                <CopyButton text={l.shortUrl} />
                <StatusBadge status={l.status} />
              </div>
              {l.title && <p className="link-hero__page-title">{l.title}</p>}
              <p className="link-hero__dest">
                <Icon name="external" size={14} />
                <a href={l.url} target="_blank" rel="noreferrer noopener" title={l.url}>
                  {prettyUrl(l.url)}
                </a>
              </p>
              <ul className="link-hero__meta">
                <li>
                  <Icon name="calendar" size={14} /> Created {formatDate(l.createdAt)}
                </li>
                <li>
                  <Icon name="cursor" size={14} /> {formatCount(l.clickCount)} all-time clicks
                  {l.maxClicks !== null && ` of ${formatCount(l.maxClicks)}`}
                </li>
                {l.expiresAt && (
                  <li>
                    <Icon name="clock" size={14} /> {new Date(l.expiresAt).getTime() < Date.now() ? 'Expired' : 'Expires'}{' '}
                    {formatDateTime(l.expiresAt)}
                  </li>
                )}
                {l.hasPassword && (
                  <li>
                    <Icon name="lock" size={14} /> Password protected
                  </li>
                )}
                {l.publicStats && (
                  <li>
                    <Icon name="globe" size={14} />{' '}
                    <RouterLink to={`/stats/${l.code}`} target="_blank">
                      Public stats page
                    </RouterLink>
                  </li>
                )}
              </ul>
              <div className="link-hero__actions">
                <button type="button" className="btn btn--secondary btn--sm" onClick={toggle}>
                  <Icon name={l.disabled ? 'play' : 'pause'} size={15} /> {l.disabled ? 'Enable' : 'Disable'}
                </button>
                <button type="button" className="btn btn--ghost btn--sm btn--danger-text" onClick={() => setConfirmDelete(true)}>
                  <Icon name="trash" size={15} /> Delete
                </button>
              </div>
            </div>
            <div className="link-hero__qr">
              <QrCode value={l.shortUrl} size={132} fileName={`linkpulse-${l.code}`} />
            </div>
          </>
        )}
      </section>

      <div className="toolbar">
        <div
          className="tabs"
          role="tablist"
          aria-label="Link sections"
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            const next = tab === 'analytics' ? 'settings' : 'analytics';
            setTab(next);
            document.getElementById(`tab-${next}`)?.focus();
          }}
        >
          <button type="button" role="tab" id="tab-analytics" aria-selected={tab === 'analytics'} tabIndex={tab === 'analytics' ? 0 : -1} aria-controls="panel-analytics" className="tabs__tab" onClick={() => setTab('analytics')}>
            Analytics
          </button>
          <button type="button" role="tab" id="tab-settings" aria-selected={tab === 'settings'} tabIndex={tab === 'settings' ? 0 : -1} aria-controls="panel-settings" className="tabs__tab" onClick={() => setTab('settings')}>
            Settings
          </button>
        </div>
        {tab === 'analytics' && (
          <div className="toolbar__right">
            <LivePill state={liveState} recent={live} />
            <RangePicker value={range} onChange={setRange} />
            <a className="btn btn--secondary btn--sm" href={api.analyticsCsvUrl(id, range)} download={`linkpulse-${l?.code ?? id}.csv`}>
              <Icon name="download" size={15} /> CSV
            </a>
          </div>
        )}
      </div>

      {tab === 'analytics' ? (
        <div role="tabpanel" id="panel-analytics" aria-labelledby="tab-analytics">
          {analytics.error ? (
            <ErrorState message={analytics.error.message} onRetry={analytics.reload} />
          ) : !analytics.data ? (
            <AnalyticsSkeleton />
          ) : (
            <div className={analytics.loading ? 'is-refreshing' : undefined}>
              <AnalyticsView data={analytics.data} liveExtra={live} />
            </div>
          )}
        </div>
      ) : (
        <div role="tabpanel" id="panel-settings" aria-labelledby="tab-settings" className="card settings-card">
          {l && (
            <EditLinkForm
              key={l.updatedAt}
              link={l}
              onSaved={(u) => {
                link.setData(u);
                toast('Settings saved.');
              }}
            />
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete /${l?.code ?? ''}?`}
        body="The short link stops working immediately and its analytics are removed. This cannot be undone."
        confirmLabel="Delete link"
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          try {
            await api.deleteLink(id);
            toast('Link deleted.');
            navigate('/app');
          } catch (err) {
            toast(err instanceof ApiError ? err.message : 'Could not delete the link.', 'error');
          }
        }}
      />
    </div>
  );
}
