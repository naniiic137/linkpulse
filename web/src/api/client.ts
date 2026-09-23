import type {
  Analytics,
  ApiKey,
  Bucket,
  CreateLinkInput,
  Link,
  Overview,
  Page,
  PublicStats,
  UpdateLinkInput,
  User,
} from './types';

export interface RateLimitInfo {
  /** Seconds until the client may retry. */
  retryAfter: number;
  limit: number | null;
  remaining: number | null;
}

/** Error thrown for any non-2xx response. Carries the API's error envelope. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly rateLimit: RateLimitInfo | null;

  constructor(status: number, code: string, message: string, details?: unknown, rateLimit: RateLimitInfo | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.rateLimit = rateLimit;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

function toInt(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.ceil(n)) : null;
}

/**
 * Reads rate-limit headers. Retry-After may be delta-seconds or an HTTP date;
 * falls back to RateLimit-Reset, then to a conservative 60 s.
 */
export function parseRateLimit(headers: Headers, now: number = Date.now()): RateLimitInfo {
  const raw = headers.get('retry-after');
  let retryAfter = toInt(raw);
  if (retryAfter === null && raw) {
    const date = Date.parse(raw);
    if (!Number.isNaN(date)) retryAfter = Math.max(0, Math.ceil((date - now) / 1000));
  }
  if (retryAfter === null) retryAfter = toInt(headers.get('ratelimit-reset'));
  return {
    retryAfter: retryAfter ?? 60,
    limit: toInt(headers.get('ratelimit-limit')),
    remaining: toInt(headers.get('ratelimit-remaining')),
  };
}

const STATUS_MESSAGES: Record<number, string> = {
  400: 'The request was invalid.',
  401: 'Please sign in to continue.',
  403: 'You do not have access to this resource.',
  404: 'Not found.',
  409: 'That conflicts with an existing resource.',
  429: 'Too many requests. Please slow down.',
  500: 'Something went wrong on our side.',
};

export async function toApiError(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`;
  let message = STATUS_MESSAGES[res.status] ?? `Request failed (${res.status}).`;
  let details: unknown;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } } | null;
    if (body?.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
      details = body.error.details;
    }
  } catch {
    /* non-JSON body: keep the defaults */
  }
  const rateLimit = res.status === 429 ? parseRateLimit(res.headers) : null;
  return new ApiError(res.status, code, message, details, rateLimit);
}

type Json = Record<string, unknown> | unknown[];

export async function request<T>(
  path: string,
  init: { method?: string; body?: Json; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'linkpulse', Accept: 'application/json' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? 'GET',
      credentials: 'include',
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', 'Could not reach the LinkPulse API. Is it running?');
  }
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export interface RangeQuery {
  from: string;
  to: string;
  bucket: Bucket;
}

const enc = encodeURIComponent;

export const api = {
  me: (signal?: AbortSignal) => request<{ user: User }>('/api/auth/me', { signal }),
  login: (email: string, password: string) =>
    request<{ user: User }>('/api/auth/login', { method: 'POST', body: { email, password } }),
  signup: (name: string, email: string, password: string) =>
    request<{ user: User }>('/api/auth/signup', { method: 'POST', body: { name, email, password } }),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),

  listLinks: (params: { q?: string; limit?: number; cursor?: string | null } = {}, signal?: AbortSignal) =>
    request<Page<Link>>(`/api/links${qs({ q: params.q, limit: params.limit ?? 20, cursor: params.cursor })}`, { signal }),
  getLink: (id: string, signal?: AbortSignal) => request<Link>(`/api/links/${enc(id)}`, { signal }),
  createLink: (input: CreateLinkInput) => request<Link>('/api/links', { method: 'POST', body: { ...input } }),
  updateLink: (id: string, patch: UpdateLinkInput) =>
    request<Link>(`/api/links/${enc(id)}`, { method: 'PATCH', body: { ...patch } }),
  deleteLink: (id: string) => request<void>(`/api/links/${enc(id)}`, { method: 'DELETE' }),

  analytics: (id: string, range: RangeQuery, signal?: AbortSignal) =>
    request<Analytics>(`/api/links/${enc(id)}/analytics${qs({ ...range })}`, { signal }),
  analyticsCsvUrl: (id: string, range: Pick<RangeQuery, 'from' | 'to'>) =>
    `/api/links/${enc(id)}/analytics.csv${qs({ ...range })}`,
  eventsUrl: (id: string) => `/api/links/${enc(id)}/events`,
  overview: (days = 30, signal?: AbortSignal) => request<Overview>(`/api/overview${qs({ days })}`, { signal }),
  publicStats: (code: string, signal?: AbortSignal) => request<PublicStats>(`/api/public/stats/${enc(code)}`, { signal }),

  listKeys: (signal?: AbortSignal) => request<{ items: ApiKey[] }>('/api/keys', { signal }),
  createKey: (name: string) => request<{ key: ApiKey; secret: string }>('/api/keys', { method: 'POST', body: { name } }),
  deleteKey: (id: string) => request<void>(`/api/keys/${enc(id)}`, { method: 'DELETE' }),
};
