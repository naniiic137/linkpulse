import { describe, expect, it } from 'vitest';
import { secondsLeft } from '../hooks/useCountdown';
import { countryName, flagEmoji, formatCount, formatPercent, prettyUrl, timeAgo } from '../lib/format';
import { customRange, presetRange } from '../lib/range';
import { emptyCreateForm, normalizeUrl, toCreateInput, validateCreateForm, validateUrl } from '../lib/validate';

describe('format helpers', () => {
  it('formats counts: exact below 10k, compact above', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(9_876)).toBe('9,876');
    expect(formatCount(12_345)).toBe('12.3K');
    expect(formatCount(2_500_000)).toBe('2.5M');
  });

  it('formats percentages, flagging tiny shares as <1%', () => {
    expect(formatPercent(1, 4)).toBe('25%');
    expect(formatPercent(1, 500)).toBe('<1%');
    expect(formatPercent(3, 0)).toBe('0%');
  });

  it('describes relative time', () => {
    const now = Date.parse('2026-09-23T12:00:00Z');
    expect(timeAgo('2026-09-23T11:59:30Z', now)).toBe('just now');
    expect(timeAgo('2026-09-23T09:00:00Z', now)).toBe('3 hours ago');
    expect(timeAgo('2026-09-21T12:00:00Z', now)).toBe('2 days ago');
  });

  it('builds flag emoji and country names from ISO codes', () => {
    expect(flagEmoji('tn')).toBe('\u{1F1F9}\u{1F1F3}');
    expect(flagEmoji('Unknown')).toBe('\u{1F310}');
    expect(countryName('TN')).toBe('Tunisia');
    expect(countryName('Unknown')).toBe('Unknown');
  });

  it('strips scheme and trailing slash for display', () => {
    expect(prettyUrl('https://lp.dev/abc/')).toBe('lp.dev/abc');
  });
});

describe('create-link validation', () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  const valid = { ...emptyCreateForm, url: 'https://example.com/launch' };

  it('accepts a minimal valid form', () => {
    expect(validateCreateForm(valid, now)).toEqual({});
  });

  it('adds https:// to bare domains', () => {
    expect(normalizeUrl('example.com/a')).toBe('https://example.com/a');
    expect(normalizeUrl('http://x.io')).toBe('http://x.io');
    expect(validateUrl('example.com')).toBeNull();
  });

  it('rejects dangerous or malformed URLs', () => {
    expect(validateUrl('javascript:alert(1)')).toMatch(/http and https/);
    expect(validateUrl('data:text/html,hi')).toMatch(/http and https/);
    expect(validateUrl('https://')).not.toBeNull();
    expect(validateUrl('')).toMatch(/Enter/);
  });

  it('validates aliases: charset, length and reserved words', () => {
    expect(validateCreateForm({ ...valid, alias: 'ab' }, now).alias).toBeDefined();
    expect(validateCreateForm({ ...valid, alias: 'has space' }, now).alias).toBeDefined();
    expect(validateCreateForm({ ...valid, alias: 'API' }, now).alias).toMatch(/reserved/);
    expect(validateCreateForm({ ...valid, alias: 'spring-sale_26' }, now).alias).toBeUndefined();
  });

  it('requires a future expiry, a positive integer click cap and a 6+ char password', () => {
    const errors = validateCreateForm({ ...valid, expiresAt: '2020-01-01T00:00', maxClicks: '2.5', password: '123' }, now);
    expect(Object.keys(errors).sort()).toEqual(['expiresAt', 'maxClicks', 'password']);
  });

  it('builds a minimal API payload, omitting empty optional fields', () => {
    expect(toCreateInput({ ...valid, url: 'example.com' })).toEqual({ url: 'https://example.com' });
    const full = toCreateInput({ ...valid, alias: ' promo ', maxClicks: '100', password: 'secret1', publicStats: true });
    expect(full).toEqual({ url: valid.url, alias: 'promo', maxClicks: 100, password: 'secret1', publicStats: true });
  });
});

describe('date ranges', () => {
  const now = Date.parse('2026-09-23T15:42:10Z');

  it('24h preset uses hourly buckets aligned to the hour', () => {
    const r = presetRange('24h', now);
    expect(r.bucket).toBe('hour');
    expect(r.from).toBe('2026-09-22T16:00:00.000Z');
  });

  it('day presets start at UTC midnight and include today', () => {
    const r = presetRange('7d', now);
    expect(r.bucket).toBe('day');
    expect(r.from).toBe('2026-09-17T00:00:00.000Z');
  });

  it('custom ranges reject reversed dates and pick hourly buckets for short spans', () => {
    expect(customRange('2026-09-10', '2026-09-01')).toBeNull();
    expect(customRange('2026-09-01', '2026-09-02')?.bucket).toBe('hour');
    expect(customRange('2026-08-01', '2026-09-01')?.bucket).toBe('day');
  });
});

describe('countdown', () => {
  it('rounds up and never goes negative', () => {
    expect(secondsLeft(10_500, 10_000)).toBe(1);
    expect(secondsLeft(10_000, 12_000)).toBe(0);
    expect(secondsLeft(null)).toBe(0);
  });
});
