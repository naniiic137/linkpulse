import { useId, useState, type FormEvent } from 'react';
import { ApiError, type RateLimitInfo } from '../api/client';
import type { CreateLinkInput, Link } from '../api/types';
import {
  emptyCreateForm,
  toCreateInput,
  validateCreateForm,
  type CreateFormValues,
  type FormErrors,
} from '../lib/validate';
import { Icon } from './Icon';
import { RateLimitBanner } from './RateLimitBanner';
import { useCountdown } from '../hooks/useCountdown';

interface Props {
  onCreate: (input: CreateLinkInput) => Promise<Link>;
  onCreated: (link: Link) => void;
  baseUrl?: string;
}

/** Maps API error codes onto the field they concern so the message lands next to the input. */
function fieldForError(err: ApiError): keyof CreateFormValues | null {
  switch (err.code) {
    case 'invalid_url':
    case 'blocked_url':
      return 'url';
    case 'alias_taken':
    case 'reserved_alias':
    case 'invalid_alias':
      return 'alias';
    default:
      return null;
  }
}

export function CreateLinkForm({ onCreate, onCreated, baseUrl }: Props) {
  const [values, setValues] = useState<CreateFormValues>(emptyCreateForm);
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [limited, setLimited] = useState<{ until: number; info: RateLimitInfo } | null>(null);
  const cooldown = useCountdown(limited?.until ?? null);
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;

  const set = <K extends keyof CreateFormValues>(key: K, value: CreateFormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const found = validateCreateForm(values);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      const first = Object.keys(found)[0];
      if (first && first !== 'url' && first !== 'alias') setAdvanced(true);
      document.getElementById(id(first ?? 'url'))?.focus();
      return;
    }
    setSubmitting(true);
    try {
      const link = await onCreate(toCreateInput(values));
      setLimited(null);
      onCreated(link);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.isRateLimited && err.rateLimit) {
          setLimited({ until: Date.now() + err.rateLimit.retryAfter * 1000, info: err.rateLimit });
        } else {
          const field = fieldForError(err);
          if (field) setErrors((prev) => ({ ...prev, [field]: err.message }));
          else setFormError(err.message);
        }
      } else {
        setFormError('Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const blocked = limited !== null && cooldown > 0;
  const describedBy = (name: keyof CreateFormValues, hint?: boolean) =>
    [errors[name] ? id(`${name}-error`) : null, hint ? id(`${name}-hint`) : null].filter(Boolean).join(' ') || undefined;

  return (
    <form className="form" onSubmit={submit} noValidate aria-busy={submitting}>
      {limited && <RateLimitBanner until={limited.until} info={limited.info} />}
      {formError && (
        <div className="banner banner--error" role="alert">
          <Icon name="alert" size={18} />
          <div>
            <strong>Could not create the link</strong>
            <p>{formError}</p>
          </div>
        </div>
      )}

      <div className="field">
        <label htmlFor={id('url')}>Destination URL</label>
        <input
          id={id('url')}
          name="url"
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder="https://example.com/a/very/long/path"
          value={values.url}
          onChange={(e) => set('url', e.target.value)}
          aria-invalid={!!errors.url}
          aria-describedby={describedBy('url')}
          data-autofocus
        />
        {errors.url && (
          <p className="field__error" id={id('url-error')}>
            {errors.url}
          </p>
        )}
      </div>

      <div className="field">
        <label htmlFor={id('alias')}>
          Custom alias <span className="field__optional">optional</span>
        </label>
        <div className="input-prefix">
          <span className="input-prefix__text" aria-hidden="true">
            {(baseUrl ?? '').replace(/^https?:\/\//, '')}/
          </span>
          <input
            id={id('alias')}
            name="alias"
            autoComplete="off"
            spellCheck={false}
            placeholder="spring-sale"
            value={values.alias}
            onChange={(e) => set('alias', e.target.value)}
            aria-invalid={!!errors.alias}
            aria-describedby={describedBy('alias', true)}
          />
        </div>
        {errors.alias ? (
          <p className="field__error" id={id('alias-error')}>
            {errors.alias}
          </p>
        ) : null}
        <p className="field__hint" id={id('alias-hint')}>
          Leave empty for a generated 7-character code.
        </p>
      </div>

      <button
        type="button"
        className="disclosure"
        aria-expanded={advanced}
        aria-controls={id('advanced')}
        onClick={() => setAdvanced((a) => !a)}
      >
        <Icon name="shield" size={16} />
        Limits and protection
        <span className="disclosure__chev" aria-hidden="true" />
      </button>

      <div id={id('advanced')} className="form__advanced" hidden={!advanced}>
        <div className="form__row">
          <div className="field">
            <label htmlFor={id('expiresAt')}>Expires at</label>
            <input
              id={id('expiresAt')}
              name="expiresAt"
              type="datetime-local"
              value={values.expiresAt}
              onChange={(e) => set('expiresAt', e.target.value)}
              aria-invalid={!!errors.expiresAt}
              aria-describedby={describedBy('expiresAt')}
            />
            {errors.expiresAt && (
              <p className="field__error" id={id('expiresAt-error')}>
                {errors.expiresAt}
              </p>
            )}
          </div>
          <div className="field">
            <label htmlFor={id('maxClicks')}>Max clicks</label>
            <input
              id={id('maxClicks')}
              name="maxClicks"
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              placeholder="Unlimited"
              value={values.maxClicks}
              onChange={(e) => set('maxClicks', e.target.value)}
              aria-invalid={!!errors.maxClicks}
              aria-describedby={describedBy('maxClicks')}
            />
            {errors.maxClicks && (
              <p className="field__error" id={id('maxClicks-error')}>
                {errors.maxClicks}
              </p>
            )}
          </div>
        </div>
        <div className="field">
          <label htmlFor={id('password')}>Password</label>
          <input
            id={id('password')}
            name="password"
            type="password"
            autoComplete="new-password"
            placeholder="No password"
            value={values.password}
            onChange={(e) => set('password', e.target.value)}
            aria-invalid={!!errors.password}
            aria-describedby={describedBy('password', true)}
          />
          {errors.password && (
            <p className="field__error" id={id('password-error')}>
              {errors.password}
            </p>
          )}
          <p className="field__hint" id={id('password-hint')}>
            Visitors must enter it before being redirected. Stored as an Argon2 hash.
          </p>
        </div>
        <label className="switch">
          <input type="checkbox" checked={values.publicStats} onChange={(e) => set('publicStats', e.target.checked)} />
          <span className="switch__track" aria-hidden="true" />
          <span>
            <span className="switch__label">Public stats page</span>
            <span className="switch__hint">Anyone with the link can view aggregate analytics.</span>
          </span>
        </label>
      </div>

      <div className="form__actions">
        <button type="submit" className="btn btn--primary btn--block" disabled={submitting || blocked}>
          {submitting ? <span className="spinner spinner--light" aria-hidden="true" /> : <Icon name="link" size={16} />}
          {blocked ? `Try again in ${cooldown}s` : submitting ? 'Shortening…' : 'Shorten link'}
        </button>
      </div>
    </form>
  );
}
