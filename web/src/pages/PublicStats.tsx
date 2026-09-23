import { Link as RouterLink, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { AnalyticsSkeleton, AnalyticsView } from '../components/AnalyticsView';
import { Icon } from '../components/Icon';
import { CopyButton, EmptyState, ErrorState, Logo } from '../components/ui';
import { useAsync } from '../hooks/useAsync';
import { formatDate, prettyUrl } from '../lib/format';

export function PublicStats() {
  const { code = '' } = useParams();
  const stats = useAsync((s) => api.publicStats(code, s), [code]);
  const d = stats.data;

  return (
    <div className="public">
      <header className="public__bar">
        <RouterLink to="/" aria-label="LinkPulse">
          <Logo />
        </RouterLink>
        <span className="public__tag">
          <Icon name="globe" size={14} /> Public stats
        </span>
      </header>
      <main id="main" className="public__main">
        {stats.error ? (
          stats.error.status === 404 ? (
            <EmptyState icon="eye" title="These stats are private">
              The owner of /{code} has not made its analytics public, or the link does not exist.
            </EmptyState>
          ) : (
            <ErrorState message={stats.error.message} onRetry={stats.reload} />
          )
        ) : !d ? (
          <AnalyticsSkeleton />
        ) : (
          <>
            <section className="public__head">
              <p className="eyebrow">Last 30 days</p>
              <h1 className="public__title">
                {prettyUrl(d.shortUrl)}
                <CopyButton text={d.shortUrl} />
              </h1>
              <p className="public__dest">
                {d.title ? <strong>{d.title}</strong> : null}
                {d.title ? ' · ' : ''}
                <a href={d.url} target="_blank" rel="noreferrer noopener">
                  {prettyUrl(d.url)}
                </a>
              </p>
              <p className="muted small">Created {formatDate(d.createdAt)} · Times in UTC · Bots excluded</p>
            </section>
            <AnalyticsView data={d.analytics} />
          </>
        )}
      </main>
      <footer className="public__foot">
        Analytics by <strong>LinkPulse</strong>. No cookies are set on visitors; IPs are hashed and never stored.
      </footer>
    </div>
  );
}
