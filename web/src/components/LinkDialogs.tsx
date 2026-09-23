import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { Link } from '../api/types';
import { prettyUrl } from '../lib/format';
import { toLocalInput, validateUrl, normalizeUrl } from '../lib/validate';
import { CreateLinkForm } from './CreateLinkForm';
import { Dialog } from './Dialog';
import { Icon } from './Icon';
import { QrCode } from './QrCode';
import { CopyButton } from './ui';

export function shortBase(links: Link[] | undefined): string {
  const first = links?.[0];
  if (first && first.shortUrl.endsWith(`/${first.code}`)) return first.shortUrl.slice(0, -first.code.length - 1);
  return (import.meta.env.VITE_SHORT_BASE_URL as string | undefined) ?? window.location.origin;
}

export function LinkResult({ link, onAnother }: { link: Link; onAnother: () => void }) {
  return (
    <div className="result">
      <div className="result__head">
        <span className="result__check" aria-hidden="true">
          <Icon name="check" size={18} />
        </span>
        <div>
          <p className="result__label">Your short link is live</p>
          <a className="result__url" href={link.shortUrl} target="_blank" rel="noreferrer">
            {prettyUrl(link.shortUrl)}
          </a>
          <p className="result__dest" title={link.url}>
            → {prettyUrl(link.url)}
          </p>
        </div>
      </div>
      <div className="result__body">
        <QrCode value={link.shortUrl} size={152} fileName={`linkpulse-${link.code}`} />
        <div className="result__actions">
          <CopyButton text={link.shortUrl} variant="button" label="Copy short link" />
          <RouterLink className="btn btn--secondary" to={`/app/links/${link.id}`}>
            <Icon name="chart" size={16} /> View analytics
          </RouterLink>
          <button type="button" className="btn btn--ghost" onClick={onAnother}>
            <Icon name="plus" size={16} /> Shorten another
          </button>
        </div>
      </div>
      <ul className="result__meta">
        {link.hasPassword && (
          <li>
            <Icon name="lock" size={14} /> Password protected
          </li>
        )}
        {link.expiresAt && (
          <li>
            <Icon name="clock" size={14} /> Expires {new Date(link.expiresAt).toLocaleString('en')}
          </li>
        )}
        {link.maxClicks !== null && (
          <li>
            <Icon name="cursor" size={14} /> Stops after {link.maxClicks} clicks
          </li>
        )}
        {link.publicStats && (
          <li>
            <Icon name="globe" size={14} /> Public stats on
          </li>
        )}
      </ul>
    </div>
  );
}

interface CreateDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (link: Link) => void;
  baseUrl: string;
}

export function CreateLinkDialog({ open, onClose, onCreated, baseUrl }: CreateDialogProps) {
  const [created, setCreated] = useState<Link | null>(null);
  const [formKey, setFormKey] = useState(0);

  useEffect(() => {
    if (open) {
      setCreated(null);
      setFormKey((k) => k + 1);
    }
  }, [open]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={created ? 'Link created' : 'Create a short link'}
      description={created ? undefined : 'Paste a long URL. Everything else is optional.'}
    >
      {created ? (
        <LinkResult
          link={created}
          onAnother={() => {
            setCreated(null);
            setFormKey((k) => k + 1);
          }}
        />
      ) : (
        <CreateLinkForm
          key={formKey}
          baseUrl={baseUrl}
          onCreate={api.createLink}
          onCreated={(link) => {
            setCreated(link);
            onCreated(link);
          }}
        />
      )}
    </Dialog>
  );
}

interface EditDialogProps {
  link: Link | null;
  onClose: () => void;
  onSaved: (link: Link) => void;
}

export function EditLinkDialog({ link, onClose, onSaved }: EditDialogProps) {
  return (
    <Dialog open={link !== null} onClose={onClose} title="Link settings" description={link ? prettyUrl(link.shortUrl) : undefined}>
      {link && <EditLinkForm link={link} onSaved={onSaved} onCancel={onClose} />}
    </Dialog>
  );
}

export function EditLinkForm({ link, onSaved, onCancel }: { link: Link; onSaved: (l: Link) => void; onCancel?: () => void }) {
  const [url, setUrl] = useState(link.url);
  const [expiresAt, setExpiresAt] = useState(toLocalInput(link.expiresAt));
  const [maxClicks, setMaxClicks] = useState(link.maxClicks?.toString() ?? '');
  const [passwordMode, setPasswordMode] = useState<'keep' | 'set' | 'remove'>('keep');
  const [password, setPassword] = useState('');
  const [publicStats, setPublicStats] = useState(link.publicStats);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const uid = useId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const urlErr = validateUrl(url);
    if (urlErr) return setError(urlErr);
    const mc = maxClicks.trim() ? Number(maxClicks) : null;
    if (mc !== null && (!Number.isInteger(mc) || mc < 1)) return setError('Max clicks must be a whole number of at least 1.');
    if (passwordMode === 'set' && password.length < 6) return setError('Passwords need at least 6 characters.');
    setError(null);
    setSaving(true);
    try {
      const updated = await api.updateLink(link.id, {
        url: normalizeUrl(url),
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        maxClicks: mc,
        publicStats,
        ...(passwordMode === 'set' ? { password } : passwordMode === 'remove' ? { password: null } : {}),
      });
      onSaved(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save changes.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="form" onSubmit={submit} noValidate>
      {error && (
        <div className="banner banner--error" role="alert">
          <Icon name="alert" size={18} />
          <div>
            <p>{error}</p>
          </div>
        </div>
      )}
      <div className="field">
        <label htmlFor={`${uid}-url`}>Destination URL</label>
        <input id={`${uid}-url`} type="url" value={url} onChange={(e) => setUrl(e.target.value)} data-autofocus />
      </div>
      <div className="form__row">
        <div className="field">
          <label htmlFor={`${uid}-exp`}>Expires at</label>
          <input id={`${uid}-exp`} type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${uid}-max`}>Max clicks</label>
          <input
            id={`${uid}-max`}
            type="number"
            min={1}
            inputMode="numeric"
            placeholder="Unlimited"
            value={maxClicks}
            onChange={(e) => setMaxClicks(e.target.value)}
          />
        </div>
      </div>
      <fieldset className="field fieldset">
        <legend>Password</legend>
        <div className="segmented" role="radiogroup" aria-label="Password">
          {(link.hasPassword ? (['keep', 'set', 'remove'] as const) : (['keep', 'set'] as const)).map((m) => (
            <label key={m} className="segmented__opt">
              <input type="radio" name={`${uid}-pw`} value={m} checked={passwordMode === m} onChange={() => setPasswordMode(m)} />
              <span>{m === 'keep' ? (link.hasPassword ? 'Keep current' : 'None') : m === 'set' ? (link.hasPassword ? 'Change' : 'Add password') : 'Remove'}</span>
            </label>
          ))}
        </div>
        {passwordMode === 'set' && (
          <input
            aria-label="New password"
            type="password"
            autoComplete="new-password"
            placeholder="New password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        )}
      </fieldset>
      <label className="switch">
        <input type="checkbox" checked={publicStats} onChange={(e) => setPublicStats(e.target.checked)} />
        <span className="switch__track" aria-hidden="true" />
        <span>
          <span className="switch__label">Public stats page</span>
          <span className="switch__hint">Share aggregate analytics at /stats/{link.code}</span>
        </span>
      </label>
      <div className="form__actions form__actions--split">
        {onCancel && (
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn btn--primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}

interface ConfirmProps {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}

export function ConfirmDialog({ open, title, body, confirmLabel, onConfirm, onClose }: ConfirmProps) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onClose={onClose} title={title} size="sm">
      <p className="dialog__text">{body}</p>
      <div className="form__actions form__actions--split">
        <button type="button" className="btn btn--ghost" onClick={onClose} data-autofocus>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
