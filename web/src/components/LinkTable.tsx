import { Link as RouterLink, useNavigate } from 'react-router-dom';
import type { Link } from '../api/types';
import { formatCount, formatDate, prettyUrl, timeAgo } from '../lib/format';
import { Icon } from './Icon';
import { Menu } from './Menu';
import { CopyButton, Favicon, Skeleton, StatusBadge } from './ui';

interface Props {
  links: Link[];
  onEdit: (link: Link) => void;
  onToggle: (link: Link) => void;
  onDelete: (link: Link) => void;
}

export function LinkTableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="link-table" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="link-row link-row--skeleton">
          <div className="link-row__main">
            <Skeleton width={24} height={24} />
            <div className="stack-xs">
              <Skeleton width={140} />
              <Skeleton width={220} height={12} />
            </div>
          </div>
          <Skeleton width={48} />
          <Skeleton width={64} height={20} />
          <Skeleton width={72} />
          <span />
        </div>
      ))}
    </div>
  );
}

/**
 * Responsive link list. It is a real table for screen readers (role=table),
 * laid out with CSS grid so rows can collapse into cards on phones.
 */
export function LinkTable({ links, onEdit, onToggle, onDelete }: Props) {
  const navigate = useNavigate();
  return (
    <div className="link-table" role="table" aria-label="Your links">
      <div className="link-row link-row--head" role="row">
        <span role="columnheader">Link</span>
        <span role="columnheader" className="num">
          Clicks
        </span>
        <span role="columnheader">Status</span>
        <span role="columnheader">Created</span>
        <span role="columnheader">
          <span className="sr-only">Actions</span>
        </span>
      </div>
      {links.map((link) => (
        <div key={link.id} className="link-row" role="row">
          <div className="link-row__main" role="cell">
            <Favicon url={link.url} faviconUrl={link.faviconUrl} size={24} />
            <div className="link-row__text">
              <div className="link-row__short">
                <RouterLink to={`/app/links/${link.id}`} className="link-row__code">
                  {prettyUrl(link.shortUrl)}
                </RouterLink>
                {link.hasPassword && <Icon name="lock" size={13} className="muted" label="Password protected" />}
                {link.expiresAt && <Icon name="clock" size={13} className="muted" label={`Expires ${formatDate(link.expiresAt)}`} />}
                <CopyButton text={link.shortUrl} label={`Copy ${link.shortUrl}`} />
              </div>
              <p className="link-row__dest" title={link.url}>
                {link.title ? <span className="link-row__title">{link.title} · </span> : null}
                {prettyUrl(link.url)}
              </p>
            </div>
          </div>
          <div role="cell" className="num link-row__clicks">
            <strong>{formatCount(link.clickCount)}</strong>
            {link.maxClicks !== null && <span className="muted"> / {formatCount(link.maxClicks)}</span>}
            <span className="link-row__mobile-label"> clicks</span>
          </div>
          <div role="cell">
            <StatusBadge status={link.status} />
          </div>
          <div role="cell" className="muted link-row__created" title={new Date(link.createdAt).toLocaleString('en')}>
            {timeAgo(link.createdAt)}
          </div>
          <div role="cell" className="link-row__actions">
            <Menu
              label={`Actions for ${link.code}`}
              items={[
                { label: 'View analytics', icon: 'chart', onSelect: () => navigate(`/app/links/${link.id}`) },
                { label: 'Edit settings', icon: 'edit', onSelect: () => onEdit(link) },
                link.disabled
                  ? { label: 'Enable link', icon: 'play', onSelect: () => onToggle(link) }
                  : { label: 'Disable link', icon: 'pause', onSelect: () => onToggle(link) },
                { label: 'Delete', icon: 'trash', onSelect: () => onDelete(link), danger: true },
              ]}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
