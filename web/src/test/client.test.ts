import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, parseRateLimit, qs, request } from '../api/client';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

afterEach(() => vi.restoreAllMocks());

describe('parseRateLimit', () => {
  it('reads delta-seconds Retry-After and RateLimit-* headers', () => {
    const h = new Headers({ 'Retry-After': '42', 'RateLimit-Limit': '30', 'RateLimit-Remaining': '0' });
    expect(parseRateLimit(h)).toEqual({ retryAfter: 42, limit: 30, remaining: 0 });
  });

  it('accepts an HTTP-date Retry-After', () => {
    const now = Date.parse('2026-09-23T10:00:00Z');
    const h = new Headers({ 'Retry-After': 'Wed, 23 Sep 2026 10:00:15 GMT' });
    expect(parseRateLimit(h, now).retryAfter).toBe(15);
  });

  it('falls back to RateLimit-Reset, then to 60 s', () => {
    expect(parseRateLimit(new Headers({ 'RateLimit-Reset': '7' })).retryAfter).toBe(7);
    expect(parseRateLimit(new Headers()).retryAfter).toBe(60);
  });

  it('rounds fractional seconds up so the client never retries early', () => {
    expect(parseRateLimit(new Headers({ 'Retry-After': '1.2' })).retryAfter).toBe(2);
  });
});

describe('request', () => {
  it('sends the CSRF header, credentials and a JSON body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(201, { id: '1' }));
    await request('/api/links', { method: 'POST', body: { url: 'https://example.com' } });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.credentials).toBe('include');
    expect((init?.headers as Record<string, string>)['X-Requested-With']).toBe('linkpulse');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init?.body).toBe('{"url":"https://example.com"}');
  });

  it('turns a 429 into an ApiError carrying the retry window', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(429, { error: { code: 'rate_limited', message: 'Too many requests' } }, { 'Retry-After': '12', 'RateLimit-Limit': '10' }),
    );
    const err = await api.createLink({ url: 'https://example.com' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.isRateLimited).toBe(true);
    expect(apiErr.code).toBe('rate_limited');
    expect(apiErr.rateLimit).toEqual({ retryAfter: 12, limit: 10, remaining: null });
  });

  it('keeps a sensible message when the error body is not JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }));
    const err = (await request('/api/x').catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(502);
    expect(err.code).toBe('http_502');
    expect(err.message).toMatch(/502/);
  });

  it('returns undefined for 204 No Content', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    await expect(api.deleteLink('7')).resolves.toBeUndefined();
  });

  it('reports network failures as a network_error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const err = (await request('/api/x').catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('network_error');
  });
});

describe('qs', () => {
  it('drops empty values and encodes the rest', () => {
    expect(qs({ q: 'a b', limit: 20, cursor: null, empty: '' })).toBe('?q=a+b&limit=20');
    expect(qs({})).toBe('');
  });
});
