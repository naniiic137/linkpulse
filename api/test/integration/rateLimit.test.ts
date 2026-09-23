import { afterEach, describe, expect, it } from 'vitest';
import { testConfig } from '../../src/config.js';
import { createTestApp, signUp, visit, type TestApp } from '../helpers/testApp.js';

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

const limits = (over: Partial<ReturnType<typeof testConfig>['rateLimits']>) => ({
  rateLimits: { ...testConfig().rateLimits, ...over },
});

describe('rate limiting', () => {
  it('redirects: 429 with Retry-After and RateLimit headers once an IP exceeds its budget', async () => {
    t = await createTestApp(limits({ redirect: { limit: 5, windowMs: 60_000 } }), { realClock: true });
    const user = await signUp(t.app);
    const { code } = (await user.request('POST', '/api/links', { url: 'https://example.com' })).json();

    const responses = [];
    for (let i = 0; i < 7; i++) responses.push(await visit(t.app, code, { ip: '203.0.113.50' }));
    expect(responses.map((r) => r.statusCode)).toEqual([302, 302, 302, 302, 302, 429, 429]);
    expect(responses[0]!.headers['ratelimit-limit']).toBe('5');
    expect(responses[0]!.headers['ratelimit-remaining']).toBe('4');
    expect(responses[4]!.headers['ratelimit-remaining']).toBe('0');

    const limited = responses[5]!;
    const retryAfter = Number(limited.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(120);
    expect(limited.headers['ratelimit-remaining']).toBe('0');
    expect(limited.json()).toMatchObject({ error: { code: 'rate_limited', details: { retryAfter } } });

    // Browsers get a friendly page; other IPs are unaffected.
    const page = await visit(t.app, code, { ip: '203.0.113.50', html: true });
    expect(page.statusCode).toBe(429);
    expect(page.body).toContain('Slow down');
    expect((await visit(t.app, code, { ip: '203.0.113.51' })).statusCode).toBe(302);
  });

  it('login: brute-force protection per IP', async () => {
    t = await createTestApp(limits({ auth: { limit: 3, windowMs: 60_000 } }), { realClock: true });
    const attempt = () =>
      t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '198.51.100.9',
        payload: { email: 'victim@example.com', password: 'wrong-password' },
      });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await attempt()).statusCode);
    expect(codes).toEqual([401, 401, 401, 429, 429]);
  });

  it('link creation: limited per API key, independently of other keys', async () => {
    t = await createTestApp(limits({ createPerPrincipal: { limit: 2, windowMs: 60_000 } }), { realClock: true });
    const user = await signUp(t.app);
    const k1 = (await user.request('POST', '/api/keys', { name: 'ci' })).json().secret as string;
    const k2 = (await user.request('POST', '/api/keys', { name: 'zapier' })).json().secret as string;
    const create = (key: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/links',
        headers: { authorization: `Bearer ${key}` },
        payload: { url: 'https://example.com' },
      });
    expect((await create(k1)).statusCode).toBe(201);
    expect((await create(k1)).statusCode).toBe(201);
    const third = await create(k1);
    expect(third.statusCode).toBe(429);
    expect(third.headers['retry-after']).toBeDefined();
    expect((await create(k2)).statusCode).toBe(201);
  });

  it('can be disabled by configuration', async () => {
    t = await createTestApp({ rateLimits: { ...testConfig().rateLimits, enabled: false, redirect: { limit: 1, windowMs: 60_000 } } });
    const user = await signUp(t.app);
    const { code } = (await user.request('POST', '/api/links', { url: 'https://example.com' })).json();
    for (let i = 0; i < 5; i++) expect((await visit(t.app, code)).statusCode).toBe(302);
  });
});
