import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOUR } from '../../src/lib/time.js';
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

describe('analytics API', () => {
  it('aggregates clicks, uniques, referrers, countries, devices; excludes bots', async () => {
    const link = (await user.request('POST', '/api/links', { url: 'https://example.com' })).json();
    const from = new Date(t.clock.ms - HOUR).toISOString();
    await visit(t.app, link.code, { ip: '203.0.113.1', referer: 'https://www.linkedin.com/feed/', country: 'TN' });
    await visit(t.app, link.code, { ip: '203.0.113.1', referer: 'https://www.linkedin.com/feed/', country: 'TN' }); // same visitor
    await visit(t.app, link.code, { ip: '203.0.113.2', ua: IPHONE_UA, country: 'FR' });
    await visit(t.app, link.code, { ip: '203.0.113.3', ua: BOT_UA });
    await t.app.ctx.pipeline.flush();

    const to = new Date(t.clock.ms + HOUR).toISOString();
    const res = await user.request('GET', `/api/links/${link.id}/analytics?from=${from}&to=${to}&bucket=hour`);
    expect(res.statusCode).toBe(200);
    const a = res.json();
    expect(a.totals).toEqual({ clicks: 3, uniqueVisitors: 2, bots: 1 });
    expect(a.timeseries).toHaveLength(2);
    expect(a.timeseries.reduce((s: number, p: { clicks: number }) => s + p.clicks, 0)).toBe(3);
    expect(a.referrers).toContainEqual({ name: 'linkedin.com', clicks: 2 });
    expect(a.countries).toEqual([{ name: 'TN', clicks: 2 }, { name: 'FR', clicks: 1 }]);
    expect(a.devices).toEqual([{ name: 'desktop', clicks: 2 }, { name: 'mobile', clicks: 1 }]);

    const csv = await user.request('GET', `/api/links/${link.id}/analytics.csv?from=${from}&to=${to}`);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain(`linkpulse-${link.code}`);
    const lines = csv.body.trim().split('\r\n');
    expect(lines[0]).toBe('timestamp,referrer,country,device,browser,os,is_bot');
    expect(lines).toHaveLength(5); // header + 4 raw clicks (bots included, flagged)
    expect(csv.body).not.toMatch(/203\.0\.113/); // IPs are never stored
  });

  it('dashboard overview sums across the account', async () => {
    const a = (await user.request('POST', '/api/links', { url: 'https://example.com/a' })).json();
    const b = (await user.request('POST', '/api/links', { url: 'https://example.com/b' })).json();
    await visit(t.app, a.code);
    await visit(t.app, b.code, { ip: '203.0.113.99' });
    await visit(t.app, b.code, { ip: '203.0.113.98' });
    await t.app.ctx.pipeline.flush();
    const o = (await user.request('GET', '/api/overview?days=7')).json();
    expect(o.totals).toMatchObject({ links: 2, activeLinks: 2, clicks: 3 });
    expect(o.topLinks[0]).toMatchObject({ id: b.id, clicks: 2 });
  });

  it('public stats are opt-in and never exposed for password-protected links', async () => {
    const link = (await user.request('POST', '/api/links', { url: 'https://example.com/pub' })).json();
    expect((await t.app.inject({ method: 'GET', url: `/api/public/stats/${link.code}` })).statusCode).toBe(404);
    await user.request('PATCH', `/api/links/${link.id}`, { publicStats: true });
    await visit(t.app, link.code);
    await t.app.ctx.pipeline.flush();
    const pub = await t.app.inject({ method: 'GET', url: `/api/public/stats/${link.code}` });
    expect(pub.statusCode).toBe(200);
    expect(pub.json()).toMatchObject({ code: link.code, analytics: { totals: { clicks: 1 } } });
    await user.request('PATCH', `/api/links/${link.id}`, { password: 'hunter22' });
    expect((await t.app.inject({ method: 'GET', url: `/api/public/stats/${link.code}` })).statusCode).toBe(404);
  });

  it('serves a QR code for the short URL', async () => {
    const link = (await user.request('POST', '/api/links', { url: 'https://example.com' })).json();
    const svg = await user.request('GET', `/api/links/${link.id}/qr.svg`);
    expect(svg.headers['content-type']).toContain('image/svg+xml');
    expect(svg.body).toContain('<svg');
    const png = await user.request('GET', `/api/links/${link.id}/qr.svg?format=png&size=128`);
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.rawPayload.subarray(1, 4).toString()).toBe('PNG');
  });
});

describe('ops endpoints', () => {
  it('health, readiness and OpenAPI docs', async () => {
    expect((await t.app.inject({ url: '/health' })).json()).toMatchObject({ status: 'ok' });
    const ready = await t.app.inject({ url: '/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: 'ready', checks: { store: 'ok', hot: 'ok' } });
    const spec = (await t.app.inject({ url: '/docs/json' })).json();
    expect(spec.openapi).toBe('3.0.3');
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/api/links', '/api/links/{id}/analytics', '/{code}']));
    expect((await t.app.inject({ url: '/docs' })).statusCode).toBeLessThan(400);
  });

  it('readiness flips to 503 while shutting down', async () => {
    t.app.ctx.state.shuttingDown = true;
    const ready = await t.app.inject({ url: '/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().status).toBe('shutting_down');
    t.app.ctx.state.shuttingDown = false;
  });

  it('drains queued clicks on close (graceful shutdown)', async () => {
    const link = (await user.request('POST', '/api/links', { url: 'https://example.com' })).json();
    await visit(t.app, link.code);
    const store = t.infra.store;
    const flushed = t.app.ctx.pipeline.stats;
    await t.close();
    expect(flushed.flushed).toBe(1);
    if (t.infra.kind === 'memory') expect((await store.findLinkById(link.id))?.clickCount).toBe(1);
    t = await createTestApp(); // afterEach closes again
  });
});
