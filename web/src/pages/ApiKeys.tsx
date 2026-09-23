import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import type { ApiKey } from '../api/types';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { ConfirmDialog } from '../components/LinkDialogs';
import { CopyButton, EmptyState, ErrorState, Skeleton } from '../components/ui';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import { formatDate, timeAgo } from '../lib/format';

export function ApiKeys() {
  const { toast } = useToast();
  const keys = useAsync((s) => api.listKeys(s), []);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ key: ApiKey; secret: string } | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  const origin = window.location.origin;
  const example = `curl -X POST ${origin}/api/links \\
  -H "Authorization: Bearer ${secret?.secret ?? 'lp_live_…'}" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com/launch","alias":"launch"}'`;

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (n.length < 2) return setNameError('Give the key a name of at least 2 characters, like "CI deploys".');
    setNameError(null);
    setCreating(true);
    try {
      const res = await api.createKey(n);
      setSecret(res);
      setName('');
      keys.setData((prev) => ({ items: [res.key, ...(prev?.items ?? [])] }));
    } catch (err) {
      setNameError(err instanceof ApiError ? err.message : 'Could not create the key.');
    } finally {
      setCreating(false);
    }
  };

  const revoke = async () => {
    if (!revoking) return;
    try {
      await api.deleteKey(revoking.id);
      keys.setData((prev) => prev && { items: prev.items.filter((k) => k.id !== revoking.id) });
      toast(`Revoked “${revoking.name}”. Requests using it now get 401.`);
      setRevoking(null);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not revoke the key.', 'error');
    }
  };

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">API keys</h1>
          <p className="page__sub">Create links from scripts and CI. Keys act as you, are rate limited per key, and are stored only as SHA-256 hashes.</p>
        </div>
      </header>

      <div className="grid-keys">
        <section className="card">
          <h2 className="card__title">Create a key</h2>
          <form className="inline-form" onSubmit={create} noValidate>
            <div className="field field--grow">
              <label htmlFor="key-name">Key name</label>
              <input
                id="key-name"
                value={name}
                placeholder="e.g. Newsletter automation"
                onChange={(e) => setName(e.target.value)}
                aria-invalid={!!nameError}
                aria-describedby={nameError ? 'key-name-error' : undefined}
                maxLength={60}
              />
            </div>
            <button type="submit" className="btn btn--primary" disabled={creating}>
              <Icon name="plus" size={16} /> {creating ? 'Creating…' : 'Create key'}
            </button>
          </form>
          {nameError && (
            <p className="field__error" id="key-name-error">
              {nameError}
            </p>
          )}

          <h3 className="card__subtitle">Usage</h3>
          <div className="code-block">
            <pre>
              <code>{example}</code>
            </pre>
            <CopyButton text={example} label="Copy example" />
          </div>
        </section>

        <section className="card card--flush" aria-labelledby="keys-heading">
          <header className="card__head card__head--pad">
            <h2 className="card__title" id="keys-heading">
              Active keys
            </h2>
            {keys.data && <span className="card__meta">{keys.data.items.length} total</span>}
          </header>
          {keys.error ? (
            <ErrorState message={keys.error.message} onRetry={keys.reload} />
          ) : !keys.data ? (
            <div className="stack-sm pad">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} height={44} className="skeleton--block" />
              ))}
            </div>
          ) : keys.data.items.length === 0 ? (
            <EmptyState icon="key" title="No API keys yet">
              Create one to call the API with an Authorization: Bearer header.
            </EmptyState>
          ) : (
            <ul className="key-list">
              {keys.data.items.map((k) => (
                <li key={k.id} className="key-row">
                  <span className="key-row__icon" aria-hidden="true">
                    <Icon name="key" size={16} />
                  </span>
                  <div className="key-row__text">
                    <p className="key-row__name">{k.name}</p>
                    <p className="key-row__meta">
                      <code>{k.prefix}…</code> · created {formatDate(k.createdAt)} ·{' '}
                      {k.lastUsedAt ? `last used ${timeAgo(k.lastUsedAt)}` : 'never used'}
                    </p>
                  </div>
                  <button type="button" className="btn btn--ghost btn--sm btn--danger-text" onClick={() => setRevoking(k)}>
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <Dialog
        open={secret !== null}
        onClose={() => setSecret(null)}
        title="Copy your new API key"
        description="This is the only time the full key is shown. We keep only its hash."
      >
        {secret && (
          <div className="stack-md">
            <div className="secret">
              <code className="secret__value">{secret.secret}</code>
              <CopyButton text={secret.secret} variant="button" label="Copy key" />
            </div>
            <div className="banner banner--info">
              <Icon name="shield" size={18} />
              <div>
                <p>Store it in a secret manager or CI secret. If it leaks, revoke it here and create a new one.</p>
              </div>
            </div>
            <div className="form__actions">
              <button type="button" className="btn btn--primary" onClick={() => setSecret(null)} data-autofocus>
                I have saved it
              </button>
            </div>
          </div>
        )}
      </Dialog>

      <ConfirmDialog
        open={revoking !== null}
        title={`Revoke “${revoking?.name ?? ''}”?`}
        body="Any script using this key will start receiving 401 Unauthorized immediately."
        confirmLabel="Revoke key"
        onConfirm={revoke}
        onClose={() => setRevoking(null)}
      />
    </div>
  );
}
