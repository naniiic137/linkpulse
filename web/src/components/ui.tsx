import { useState, type ReactNode } from 'react';
import type { LinkStatus } from '../api/types';
import { STATUS_LABEL } from '../lib/format';
import { Icon, type IconName } from './Icon';

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="logo">
      <svg className="logo__mark" viewBox="0 0 32 32" width={28} height={28} aria-hidden="true">
        <rect width="32" height="32" rx="8" fill="currentColor" />
        <path d="M5 17h5l3-7 5 13 3-6h6" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {!compact && <span className="logo__text">LinkPulse</span>}
    </span>
  );
}

export function StatusBadge({ status }: { status: LinkStatus }) {
  return (
    <span className={`badge badge--${status}`}>
      <span className="badge__dot" aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Skeleton({ width, height = 14, className }: { width?: number | string; height?: number; className?: string }) {
  return <span className={`skeleton ${className ?? ''}`} style={{ width, height }} aria-hidden="true" />;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

interface EmptyStateProps {
  icon: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ icon, title, children, action }: EmptyStateProps) {
  return (
    <div className="empty">
      <span className="empty__icon">
        <Icon name={icon} size={22} />
      </span>
      <h3 className="empty__title">{title}</h3>
      {children && <p className="empty__text">{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="empty empty--error" role="alert">
      <span className="empty__icon">
        <Icon name="alert" size={22} />
      </span>
      <h3 className="empty__title">Could not load this</h3>
      <p className="empty__text">{message}</p>
      {onRetry && (
        <button type="button" className="btn btn--secondary" onClick={onRetry}>
          <Icon name="refresh" size={16} /> Try again
        </button>
      )}
    </div>
  );
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts (plain http on a LAN IP).
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

interface CopyButtonProps {
  text: string;
  label?: string;
  variant?: 'icon' | 'button';
}

export function CopyButton({ text, label = 'Copy link', variant = 'icon' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    if (await writeClipboard(text)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  };
  if (variant === 'button') {
    return (
      <button type="button" className="btn btn--secondary" onClick={onCopy}>
        <Icon name={copied ? 'check' : 'copy'} size={16} />
        <span aria-live="polite">{copied ? 'Copied' : label}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      className={`icon-btn ${copied ? 'icon-btn--ok' : ''}`}
      onClick={onCopy}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
    >
      <Icon name={copied ? 'check' : 'copy'} size={16} />
    </button>
  );
}

export function Favicon({ url, faviconUrl, size = 20 }: { url: string; faviconUrl: string | null; size?: number }) {
  const [failed, setFailed] = useState(false);
  let letter = '?';
  try {
    letter = new URL(url).hostname.replace(/^www\./, '').charAt(0).toUpperCase();
  } catch {
    /* keep ? */
  }
  if (faviconUrl && !failed) {
    return (
      <img
        className="favicon"
        src={faviconUrl}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span className="favicon favicon--letter" style={{ width: size, height: size }} aria-hidden="true">
      {letter}
    </span>
  );
}
