import type { CreateLinkInput } from '../api/types';

/** Mirrors the API's reserved words so users get instant feedback; the API stays authoritative. */
export const RESERVED_ALIASES = new Set([
  'api', 'app', 'admin', 'assets', 'docs', 'health', 'ready', 'login', 'logout', 'signup',
  'stats', 'static', 'favicon.ico', 'robots.txt', 'settings', 'dashboard', 'keys', 'metrics',
]);

export const ALIAS_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;

export interface CreateFormValues {
  url: string;
  alias: string;
  expiresAt: string; // value of <input type="datetime-local">, may be empty
  maxClicks: string;
  password: string;
  publicStats: boolean;
}

export type FormErrors = Partial<Record<keyof CreateFormValues, string>>;

export const emptyCreateForm: CreateFormValues = {
  url: '',
  alias: '',
  expiresAt: '',
  maxClicks: '',
  password: '',
  publicStats: false,
};

/** Adds https:// when the user typed a bare domain such as "example.com/path". */
export function normalizeUrl(raw: string): string {
  const v = raw.trim();
  if (!v) return v;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return v;
  return `https://${v}`;
}

export function validateUrl(raw: string): string | null {
  const v = normalizeUrl(raw);
  if (!v) return 'Enter the destination URL.';
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return 'That does not look like a valid URL.';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Only http and https links can be shortened.';
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') return 'Use a full domain name, like example.com.';
  if (v.length > 2048) return 'URLs are limited to 2048 characters.';
  return null;
}

export function validateCreateForm(values: CreateFormValues, now: number = Date.now()): FormErrors {
  const errors: FormErrors = {};
  const urlError = validateUrl(values.url);
  if (urlError) errors.url = urlError;

  const alias = values.alias.trim();
  if (alias) {
    if (!ALIAS_PATTERN.test(alias)) errors.alias = 'Use 3–32 letters, numbers, dashes or underscores.';
    else if (RESERVED_ALIASES.has(alias.toLowerCase())) errors.alias = `"${alias}" is reserved.`;
  }

  if (values.expiresAt) {
    const t = new Date(values.expiresAt).getTime();
    if (Number.isNaN(t)) errors.expiresAt = 'Pick a valid date and time.';
    else if (t <= now) errors.expiresAt = 'Expiry must be in the future.';
  }

  if (values.maxClicks.trim()) {
    const n = Number(values.maxClicks);
    if (!Number.isInteger(n) || n < 1) errors.maxClicks = 'Use a whole number of at least 1.';
    else if (n > 1_000_000_000) errors.maxClicks = 'That is a lot of clicks. Keep it under one billion.';
  }

  if (values.password && values.password.length < 6) errors.password = 'Use at least 6 characters.';
  return errors;
}

export function toCreateInput(values: CreateFormValues): CreateLinkInput {
  const input: CreateLinkInput = { url: normalizeUrl(values.url) };
  if (values.alias.trim()) input.alias = values.alias.trim();
  if (values.expiresAt) input.expiresAt = new Date(values.expiresAt).toISOString();
  if (values.maxClicks.trim()) input.maxClicks = Number(values.maxClicks);
  if (values.password) input.password = values.password;
  if (values.publicStats) input.publicStats = true;
  return input;
}

/** ISO string -> value usable by <input type="datetime-local"> in local time. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
