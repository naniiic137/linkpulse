import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { LinkRecord, RawClick } from '../../src/domain/types.js';
import { DAY, HOUR } from '../../src/lib/time.js';
import { isBotAgent, normaliseCountry, parseAgent, referrerHost } from '../../src/lib/userAgent.js';
import { AnalyticsService, csvCell, resolveRange, toCsv } from '../../src/services/analyticsService.js';
import { ClickPipeline } from '../../src/services/clickPipeline.js';
import { createMemoryInfrastructure } from '../../src/stores/index.js';
import { BOT_UA, BROWSER_UA, IPHONE_UA } from '../helpers/testApp.js';

const T = Date.UTC(2026, 8, 10, 0, 0, 0);

function link(id: string, ownerId = 'owner-1'): LinkRecord {
  return {
    id, code: `code${id}`, ownerId, url: 'https://example.com', title: null, faviconUrl: null, isCustom: false,
    passwordHash: null, expiresAt: null, maxClicks: null, disabled: false, publicStats: false, clickCount: 0,
    createdAt: new Date(T - 10 * DAY), updatedAt: new Date(T - 10 * DAY),
  };
}

function raw(linkId: string, ts: number, over: Partial<RawClick> = {}): RawClick {
  return {
    id: randomUUID(), linkId, ownerId: 'owner-1', ts, visitorHash: 'v1', userAgent: BROWSER_UA,
    referrer: null, country: null, isBot: false, ...over,
  };
}

describe('enrichment helpers', () => {
  it('parses user agents into device / browser / OS', () => {
    expect(parseAgent(BROWSER_UA)).toEqual({ device: 'desktop', browser: 'Chrome', os: 'Windows' });
    expect(parseAgent(IPHONE_UA)).toEqual({ device: 'mobile', browser: 'Mobile Safari', os: 'iOS' });
  });

  it('detects bots, CLIs and empty agents', () => {
    expect(isBotAgent(BOT_UA)).toBe(true);
    expect(isBotAgent('Googlebot/2.1 (+http://www.google.com/bot.html)')).toBe(true);
    expect(isBotAgent('curl/8.4.0')).toBe(true);
    expect(isBotAgent('')).toBe(true);
    expect(isBotAgent(undefined)).toBe(true);
    expect(isBotAgent(BROWSER_UA)).toBe(false);
    expect(isBotAgent(IPHONE_UA)).toBe(false);
  });

  it('normalises referrers and country headers', () => {
    expect(referrerHost('https://www.linkedin.com/feed/?x=1')).toBe('linkedin.com');
    expect(referrerHost('android-app://com.slack')).toBe('com.slack');
    expect(referrerHost('garbage')).toBe('direct');
    expect(referrerHost(null)).toBe('direct');
    expect(normaliseCountry('tn')).toBe('TN');
    expect(normaliseCountry('XX')).toBeNull();
    expect(normaliseCountry('T1')).toBeNull();
    expect(normaliseCountry('France')).toBeNull();
    expect(normaliseCountry(undefined)).toBeNull();
  });
});

describe('ClickPipeline + AnalyticsService', () => {
  async function setup() {
    const infra = createMemoryInfrastructure();
    await infra.store.insertLink(link('1001'));
    await infra.store.insertLink(link('1002'));
    const pipeline = new ClickPipeline({ ...infra, batchSize: 3, intervalMs: 1000 });
    const analytics = new AnalyticsService(infra);
    return { infra, pipeline, analytics };
  }

  it('drains the queue in batches and aggregates by bucket and dimension', async () => {
    const { infra, pipeline, analytics } = await setup();
    const events = [
      raw('1001', T + 1 * HOUR, { referrer: 'https://www.linkedin.com/feed', country: 'TN', visitorHash: 'a' }),
      raw('1001', T + 1 * HOUR + 60_000, { referrer: 'https://x.com/post/1', country: 'FR', visitorHash: 'b', userAgent: IPHONE_UA }),
      raw('1001', T + 3 * HOUR, { country: 'TN', visitorHash: 'a' }),
      raw('1001', T + 3 * HOUR, { isBot: true, userAgent: BOT_UA, visitorHash: 'bot' }),
      raw('1002', T + 2 * HOUR, { visitorHash: 'c' }),
    ];
    for (const e of events) infra.queue.enqueue(e);
    expect(await pipeline.flush()).toBe(5);
    expect(await infra.queue.depth()).toBe(0);

    const l = (await infra.store.findLinkById('1001'))!;
    expect(l.clickCount).toBe(3); // bots excluded from the counter

    const a = await analytics.forLink(l, { from: new Date(T), to: new Date(T + 6 * HOUR), bucket: 'hour' });
    expect(a.totals).toEqual({ clicks: 3, uniqueVisitors: 2, bots: 1 });
    expect(a.timeseries).toHaveLength(6); // zero-filled
    expect(a.timeseries.map((p) => p.clicks)).toEqual([0, 2, 0, 1, 0, 0]);
    expect(a.referrers).toEqual([
      { name: 'direct', clicks: 1 },
      { name: 'linkedin.com', clicks: 1 },
      { name: 'x.com', clicks: 1 },
    ]);
    expect(a.countries[0]).toEqual({ name: 'TN', clicks: 2 });
    expect(a.devices).toEqual([
      { name: 'desktop', clicks: 2 },
      { name: 'mobile', clicks: 1 },
    ]);
    expect(a.os.map((o) => o.name).sort()).toEqual(['Windows', 'iOS']);
  });

  it('is idempotent when the queue redelivers an event', async () => {
    const { infra, pipeline } = await setup();
    const e = raw('1001', T);
    infra.queue.enqueue(e);
    infra.queue.enqueue(e);
    await pipeline.flush();
    expect((await infra.store.findLinkById('1001'))!.clickCount).toBe(1);
  });

  it('publishes live events per link after persisting', async () => {
    const { infra, pipeline } = await setup();
    const seen: number[] = [];
    const off = infra.bus.subscribe('1001', (ev) => seen.push(ev.clicks));
    infra.queue.enqueue(raw('1001', T));
    infra.queue.enqueue(raw('1001', T));
    infra.queue.enqueue(raw('1002', T));
    await pipeline.flush();
    off();
    expect(seen).toEqual([2]);
  });

  it('builds the account overview with top links', async () => {
    const { infra, pipeline, analytics } = await setup();
    for (let i = 0; i < 4; i++) infra.queue.enqueue(raw('1002', T - DAY + i, { visitorHash: `x${i}` }));
    infra.queue.enqueue(raw('1001', T - DAY));
    await pipeline.flush();
    const o = await analytics.overview('owner-1', 7, new Date(T + HOUR));
    expect(o.totals).toMatchObject({ links: 2, activeLinks: 2, clicks: 5 });
    expect(o.timeseries).toHaveLength(7);
    expect(o.topLinks.map((t) => [t.id, t.clicks])).toEqual([['1002', 4], ['1001', 1]]);
  });
});

describe('ranges and CSV', () => {
  const now = new Date(T);

  it('defaults to 30 days and picks buckets automatically', () => {
    const r = resolveRange({}, now);
    expect(now.getTime() - r.from.getTime()).toBe(30 * DAY);
    expect(r.bucket).toBe('day');
    expect(resolveRange({ from: new Date(T - DAY).toISOString() }, now).bucket).toBe('hour');
  });

  it('rejects inverted, invalid, too-long and too-dense ranges', () => {
    expect(() => resolveRange({ from: new Date(T + 1).toISOString() }, now)).toThrow(/before/);
    expect(() => resolveRange({ from: 'yesterday' }, now)).toThrow(/ISO/);
    expect(() => resolveRange({ from: new Date(T - 400 * DAY).toISOString() }, now)).toThrow(/366/);
    expect(() => resolveRange({ from: new Date(T - 200 * DAY).toISOString(), bucket: 'hour' }, now)).toThrow(/Too many/);
  });

  it('escapes CSV cells and neutralises spreadsheet formulas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    const csv = toCsv([
      { id: '1', linkId: '1', ts: new Date(T), visitorHash: 'v', referrer: 'x.com', country: 'TN', device: 'mobile', browser: 'Chrome', os: 'Android', isBot: false },
    ]);
    expect(csv).toBe('timestamp,referrer,country,device,browser,os,is_bot\r\n2026-09-10T00:00:00.000Z,x.com,TN,mobile,Chrome,Android,false\r\n');
  });
});
