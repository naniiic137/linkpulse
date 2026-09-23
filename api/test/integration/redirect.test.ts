import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAY } from '../../src/lib/time.js';
import { BOT_UA, createTestApp, IPHONE_UA, signUp, visit, type TestApp } from '../helpers/testApp.js';

let t: TestApp;
let user: Awaited<ReturnType<typeof signUp>>;

beforeEach(async () => {
  t = await createTestApp();
  user = await signUp(t.app);
});
afterEach(async () => {
  await t.close();
});

async function create(body: Record<string, unknown>) {
  const res = await user.request('POST', '/api/links', body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; code: string; shortUrl: string; status: string };
}

describe('redirect flow', () => {
  it('302s to the destination with no-store caching, and serves later hits from cache', async () => {
    const link = await create({ url: 'https://example.com/landing?utm_source=test' });
    expect(link.code).toMatch(/^[0-9A-Za-z]{7}$/);
    expect(link.shortUrl).toBe(`http://lp.test/${link.code}`);

    const first = await visit(t.app, link.code);
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toBe('https://example.com/landing?utm_source=test');
    expect(first.headers['cache-control']).toContain('no-store');
    expect(first.headers['x-cache']).toBe('MISS');

    const second = await visit(t.app, link.code);
    expect(second.headers['x-cache']).toBe('HIT');
  });

  it('uses 301 when configured', async () => {
    await t.close();
    t = await createTestApp({ redirectStatus: 301 });
    user = await signUp(t.app);
    const link = await create({ url: 'https://example.com/permanent' });
    const res = await visit(t.app, link.code);
    expect(res.statusCode).toBe(301);
  });

  it('never waits for analytics: the click is queued, then persisted by the flusher', async () => {
    const link = await create({ url: 'https://example.com/a' });
    await visit(t.app, link.code, { ua: IPHONE_UA, referer: 'https://www.linkedin.com/feed/', country: 'TN' });
    // Redirect already answered, but nothing is persisted yet.
    expect((await user.request('GET', `/api/links/${link.id}`)).json().clickCount).toBe(0);
    await t.app.ctx.pipeline.flush();
    expect((await user.request('GET', `/api/links/${link.id}`)).json().clickCount).toBe(1);
  });

  it('returns 404 for unknown codes (JSON for APIs, HTML for browsers) and caches the miss', async () => {
    const api = await visit(t.app, 'nope123');
    expect(api.statusCode).toBe(404);
    expect(api.json().error.code).toBe('not_found');
    const browser = await visit(t.app, 'nope123', { html: true });
    expect(browser.statusCode).toBe(404);
    expect(browser.headers['content-type']).toContain('text/html');
    expect(browser.headers['x-cache']).toBeUndefined();
    // Junk that can't be a code is rejected before touching storage.
    expect((await visit(t.app, 'favicon.ico')).statusCode).toBe(404);
  });

  it('creating an alias clears a negatively cached miss for that code', async () => {
    expect((await visit(t.app, 'spring-sale')).statusCode).toBe(404); // now negatively cached
    await create({ url: 'https://example.com/sale', alias: 'spring-sale' });
    const res = await visit(t.app, 'spring-sale');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://example.com/sale');
  });

  it('editing the destination invalidates the cached entry', async () => {
    const link = await create({ url: 'https://example.com/old' });
    await visit(t.app, link.code); // warm the cache
    const patched = await user.request('PATCH', `/api/links/${link.id}`, { url: 'https://example.com/new' });
    expect(patched.statusCode).toBe(200);
    expect((await visit(t.app, link.code)).headers.location).toBe('https://example.com/new');
  });

  it('disabled links answer 410 and come back when re-enabled', async () => {
    const link = await create({ url: 'https://example.com/x' });
    await user.request('PATCH', `/api/links/${link.id}`, { disabled: true });
    const gone = await visit(t.app, link.code, { html: true });
    expect(gone.statusCode).toBe(410);
    expect(gone.body).toContain('Link disabled');
    await user.request('PATCH', `/api/links/${link.id}`, { disabled: false });
    expect((await visit(t.app, link.code)).statusCode).toBe(302);
  });

  it('expires links at expiresAt', async () => {
    const link = await create({ url: 'https://example.com/x', expiresAt: new Date(t.clock.ms + DAY).toISOString() });
    expect((await visit(t.app, link.code)).statusCode).toBe(302);
    t.clock.advance(DAY + 1);
    const res = await visit(t.app, link.code);
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('link_expired');
    expect((await user.request('GET', `/api/links/${link.id}`)).json().status).toBe('expired');
  });

  it('rejects an expiry in the past', async () => {
    const res = await user.request('POST', '/api/links', {
      url: 'https://example.com',
      expiresAt: new Date(t.clock.ms - 1000).toISOString(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('enforces max clicks atomically, and bots do not consume the quota', async () => {
    const link = await create({ url: 'https://example.com/x', maxClicks: 3 });
    // Link unfurlers (Slack, etc.) are redirected but not counted.
    for (let i = 0; i < 5; i++) expect((await visit(t.app, link.code, { ua: BOT_UA })).statusCode).toBe(302);
    const statuses = await Promise.all(Array.from({ length: 6 }, (_, i) => visit(t.app, link.code, { ip: `198.51.100.${i}` })));
    expect(statuses.filter((r) => r.statusCode === 302)).toHaveLength(3);
    const blocked = statuses.find((r) => r.statusCode === 410)!;
    expect(blocked.json().error.code).toBe('link_limit_reached');
    await t.app.ctx.pipeline.flush();
    const dto = (await user.request('GET', `/api/links/${link.id}`)).json();
    expect(dto.clickCount).toBe(3);
    expect(dto.status).toBe('limit_reached');
  });

  it('password-protected links show a form, reject wrong passwords, redirect on the right one', async () => {
    const link = await create({ url: 'https://example.com/secret', password: 'open-sesame' });
    const form = await visit(t.app, link.code, { html: true });
    expect(form.statusCode).toBe(200);
    expect(form.body).toContain('Enter the password');
    expect(form.headers.location).toBeUndefined();

    const post = (password: string) =>
      t.app.inject({
        method: 'POST',
        url: `/${link.code}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': IPHONE_UA },
        payload: `password=${encodeURIComponent(password)}`,
      });
    const wrong = await post('guess');
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).toContain('Incorrect password');
    const right = await post('open-sesame');
    expect(right.statusCode).toBe(303);
    expect(right.headers.location).toBe('https://example.com/secret');

    // The hash never leaves the server.
    const dto = (await user.request('GET', `/api/links/${link.id}`)).json();
    expect(dto.hasPassword).toBe(true);
    expect(JSON.stringify(dto)).not.toContain('argon2');
  });

  it('deleting a link makes it 404 immediately', async () => {
    const link = await create({ url: 'https://example.com/x' });
    await visit(t.app, link.code);
    expect((await user.request('DELETE', `/api/links/${link.id}`)).statusCode).toBe(204);
    expect((await visit(t.app, link.code)).statusCode).toBe(404);
  });
});

describe('link creation rules', () => {
  it('validates URLs, aliases and reserved words', async () => {
    const bad = async (body: Record<string, unknown>) => (await user.request('POST', '/api/links', body)).json().error.code;
    expect(await bad({ url: 'javascript:alert(1)' })).toBe('invalid_url');
    expect(await bad({ url: 'http://169.254.169.254/latest' })).toBe('invalid_url');
    expect(await bad({ url: 'https://lp.test/loop' })).toBe('invalid_url');
    expect(await bad({ url: 'https://example.com', alias: 'docs' })).toBe('reserved_alias');
    expect(await bad({ url: 'https://example.com', alias: 'no spaces' })).toBe('invalid_alias');
    expect(await bad({ url: 'https://example.com', maxClicks: 0 })).toBe('validation_error');
    expect(await bad({ url: 'https://example.com', unknownField: 1 })).toBe('validation_error');
  });

  it('refuses a taken alias with 409', async () => {
    await create({ url: 'https://example.com/1', alias: 'launch' });
    const res = await user.request('POST', '/api/links', { url: 'https://example.com/2', alias: 'launch' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('alias_taken');
  });

  it('skips a generated code that collides with an existing 7-char alias', async () => {
    const gen = t.app.ctx.codes;
    // Predict the next generated code and squat on it with a custom alias first.
    const probe = await create({ url: 'https://example.com/probe' });
    const nextCode = gen.codeFor(Number(probe.id) + 2); // +1 is consumed by the alias link itself
    await create({ url: 'https://example.com/squat', alias: nextCode });
    const link = await create({ url: 'https://example.com/generated' });
    expect(link.code).not.toBe(nextCode);
    expect(link.code).toMatch(/^[0-9A-Za-z]{7}$/);
  });
});
