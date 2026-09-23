import { randomUUID } from 'node:crypto';
import type { ClickRecord, LinkRecord, RawClick } from '../domain/types.js';
import type { AppContext } from '../http/context.js';
import { hashPassword, visitorHash } from '../lib/crypto.js';
import { DAY, dayKey, HOUR } from '../lib/time.js';
import { linkUniqueKey, ownerUniqueKey, UNIQUE_TTL_SECONDS } from '../services/clickPipeline.js';

/**
 * Deterministic, entirely fictional demo data: one account, a dozen links,
 * ~30 days of clicks with realistic shapes (weekday/diurnal cycles, a launch
 * spike, referrer/country/device mixes, a few percent bots).
 */

export const DEMO_EMAIL = 'demo@linkpulse.dev';
export const DEMO_PASSWORD = 'demo-password-123';

/** mulberry32: tiny seeded PRNG so every run produces the same dataset. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Weighted<T> = [T, number][];

function pick<T>(rand: () => number, items: Weighted<T>): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [item, w] of items) {
    r -= w;
    if (r <= 0) return item;
  }
  return items[items.length - 1]![0];
}

interface DemoLink {
  title: string;
  url: string;
  alias?: string;
  ageDays: number;
  /** Average human clicks per day. */
  daily: number;
  /** Day offset (days ago) of a traffic spike, if any. */
  spike?: number;
  referrers: Weighted<string>;
  disabled?: boolean;
  expiresInDays?: number;
  maxClicks?: number;
  password?: string;
  publicStats?: boolean;
}

const SOCIAL: Weighted<string> = [
  ['linkedin.com', 30], ['x.com', 22], ['direct', 20], ['news.ycombinator.com', 8], ['reddit.com', 7],
  ['google.com', 6], ['facebook.com', 4], ['github.com', 3],
];
const SEARCH: Weighted<string> = [['google.com', 45], ['direct', 25], ['bing.com', 10], ['duckduckgo.com', 8], ['linkedin.com', 7], ['x.com', 5]];
const EMAIL: Weighted<string> = [['direct', 55], ['mail.google.com', 20], ['outlook.live.com', 12], ['linkedin.com', 8], ['x.com', 5]];

const LINKS: DemoLink[] = [
  { title: 'LinkPulse · Spring launch', url: 'https://www.producthunt.com/products/linkpulse-demo', alias: 'launch', ageDays: 29, daily: 70, spike: 11, referrers: SOCIAL, publicStats: true },
  { title: 'Designing a URL shortener that survives a spike', url: 'https://medium.com/@linkpulse-demo/designing-a-url-shortener-that-survives-a-spike', ageDays: 24, daily: 46, spike: 6, referrers: [['news.ycombinator.com', 34], ['x.com', 18], ['linkedin.com', 16], ['direct', 14], ['reddit.com', 10], ['google.com', 8]], publicStats: true },
  { title: 'Product demo (4 min)', url: 'https://www.youtube.com/watch?v=Lp7xQ2mZr8A', alias: 'demo-video', ageDays: 27, daily: 38, spike: 11, referrers: SOCIAL },
  { title: 'LinkPulse on GitHub', url: 'https://github.com/naniiic137/linkpulse', alias: 'github', ageDays: 30, daily: 26, referrers: [['github.com', 20], ['direct', 25], ['news.ycombinator.com', 18], ['x.com', 15], ['linkedin.com', 12], ['google.com', 10]] },
  { title: 'Spring webinar · registration', url: 'https://www.eventbrite.com/e/linkpulse-spring-webinar-tickets-918273645', alias: 'webinar', ageDays: 18, daily: 22, spike: 4, referrers: EMAIL, maxClicks: 1000, expiresInDays: 12 },
  { title: 'Q3 customer survey', url: 'https://docs.google.com/forms/d/e/1FAIpQLSd-demo-linkpulse-survey/viewform', ageDays: 12, daily: 17, referrers: EMAIL, expiresInDays: 5 },
  { title: 'LinkPulse for iOS', url: 'https://apps.apple.com/app/id6470000001', ageDays: 21, daily: 14, referrers: SEARCH },
  { title: 'LinkPulse for Android', url: 'https://play.google.com/store/apps/details?id=dev.linkpulse.demo', ageDays: 21, daily: 16, referrers: SEARCH },
  { title: 'Hiring: junior frontend engineer', url: 'https://www.linkedin.com/jobs/view/3900000001', alias: 'jobs', ageDays: 9, daily: 12, referrers: [['linkedin.com', 60], ['direct', 20], ['x.com', 12], ['google.com', 8]] },
  { title: 'Design system (Figma)', url: 'https://www.figma.com/community/file/1300000000000000001', ageDays: 15, daily: 5, referrers: [['direct', 70], ['slack.com', 30]], password: 'pulse-team' },
  { title: 'Conference talk slides', url: 'https://speakerdeck.com/linkpulse-demo/read-heavy-systems', ageDays: 8, daily: 9, spike: 3, referrers: [['direct', 45], ['x.com', 25], ['linkedin.com', 20], ['google.com', 10]] },
  { title: 'Newsletter #41 · early-bird offer', url: 'https://newsletter.example.com/p/issue-41-early-bird', ageDays: 16, daily: 11, referrers: EMAIL, expiresInDays: -2 },
  { title: 'Beta invite · first 300 testers', url: 'https://testflight.apple.com/join/Lp7Demo1', alias: 'beta', ageDays: 14, daily: 26, referrers: SOCIAL, maxClicks: 300 },
  { title: 'Black Friday landing (archived)', url: 'https://shop.example.com/black-friday', alias: 'bf-archive', ageDays: 30, daily: 3, referrers: SEARCH, disabled: true },
];

const COUNTRIES: Weighted<string> = [
  ['TN', 18], ['FR', 16], ['US', 15], ['DE', 8], ['GB', 7], ['CA', 5], ['MA', 5], ['DZ', 4], ['NL', 4], ['IT', 3],
  ['ES', 3], ['BE', 3], ['IN', 3], ['BR', 2], ['Unknown', 4],
];
const AGENTS: Weighted<[device: string, browser: string, os: string]> = [
  [['desktop', 'Chrome', 'Windows'], 26], [['desktop', 'Chrome', 'macOS'], 9], [['desktop', 'Safari', 'macOS'], 8],
  [['desktop', 'Edge', 'Windows'], 7], [['desktop', 'Firefox', 'Windows'], 4], [['desktop', 'Firefox', 'Linux'], 3],
  [['mobile', 'Mobile Safari', 'iOS'], 17], [['mobile', 'Chrome', 'Android'], 16], [['mobile', 'Samsung Browser', 'Android'], 4],
  [['tablet', 'Mobile Safari', 'iOS'], 4], [['mobile', 'Chrome', 'iOS'], 2],
];
/** Local-time-ish diurnal curve (UTC+1 audience): quiet nights, morning and evening peaks. */
const HOURLY = [2, 1, 1, 1, 1, 2, 4, 7, 10, 12, 12, 11, 10, 10, 10, 9, 9, 10, 11, 12, 11, 8, 5, 3];

export async function seedDemo(ctx: AppContext): Promise<{ links: number; clicks: number }> {
  const { store, uniques } = ctx.infra;
  if (await store.findUserByEmail(DEMO_EMAIL)) return { links: 0, clicks: 0 };

  const rand = prng(20260923);
  const now = ctx.now().getTime();
  const user = await ctx.auth.signup({ email: DEMO_EMAIL, password: DEMO_PASSWORD, name: 'Amira Haddad' });

  let clickTotal = 0;
  for (const [i, spec] of LINKS.entries()) {
    const id = await ctx.codes.nextId();
    const createdAt = new Date(now - spec.ageDays * DAY - Math.floor(rand() * 8 * HOUR));
    const link: LinkRecord = {
      id: String(id),
      code: spec.alias ?? ctx.codes.codeFor(id),
      ownerId: user.id,
      url: spec.url,
      title: spec.title,
      faviconUrl: new URL('/favicon.ico', spec.url).toString(),
      isCustom: spec.alias !== undefined,
      passwordHash: spec.password ? await hashPassword(spec.password) : null,
      expiresAt: spec.expiresInDays ? new Date(now + spec.expiresInDays * DAY) : null,
      maxClicks: spec.maxClicks ?? null,
      disabled: spec.disabled ?? false,
      publicStats: spec.publicStats ?? false,
      clickCount: 0,
      createdAt,
      updatedAt: createdAt,
    };
    await store.insertLink(link);

    const clicks: ClickRecord[] = [];
    let humanCount = 0;
    // A pool smaller than the click count gives realistic repeat visitors (~70% unique).
    const pool = Math.max(20, Math.round(spec.daily * spec.ageDays * 0.72));
    for (let d = spec.ageDays; d >= 0; d--) {
      const dayStart = Math.floor((now - d * DAY) / DAY) * DAY;
      const weekday = new Date(dayStart).getUTCDay();
      const weekFactor = weekday === 0 || weekday === 6 ? 0.62 : 1.08;
      const spikeFactor = spec.spike !== undefined ? 1 + 3.2 * Math.exp(-((d - spec.spike) ** 2) / 2.2) : 1;
      const ramp = Math.min(1, (spec.ageDays - d + 1) / 3);
      const n = Math.round(spec.daily * weekFactor * spikeFactor * ramp * (0.8 + rand() * 0.4));
      for (let k = 0; k < n; k++) {
        const hour = pick(rand, HOURLY.map((w, h) => [h, w] as [number, number]));
        const ts = dayStart + hour * HOUR + Math.floor(rand() * HOUR);
        if (ts > now || ts < createdAt.getTime()) continue;
        const bot = rand() < 0.04;
        if (!bot && spec.maxClicks !== undefined && humanCount >= spec.maxClicks) continue;
        if (spec.expiresInDays !== undefined && ts >= now + spec.expiresInDays * DAY) continue;
        if (!bot) humanCount++;
        const [device, browser, os] = pick(rand, AGENTS);
        clicks.push({
          id: randomUUID(),
          linkId: link.id,
          ts: new Date(ts),
          visitorHash: visitorHash('demo', `visitor-${i}-${Math.floor(rand() * pool)}`, ''),
          referrer: bot ? 'direct' : pick(rand, spec.referrers),
          country: pick(rand, COUNTRIES),
          device: bot ? 'bot' : device,
          browser: bot ? 'Googlebot' : browser,
          os: bot ? 'Other' : os,
          isBot: bot,
        });
      }
    }
    await store.insertClicks(clicks);
    const humans = clicks.filter((c) => !c.isBot);
    await uniques.add(
      humans.flatMap((c) => {
        const day = dayKey(c.ts.getTime());
        return [
          { key: linkUniqueKey(link.id, day), member: c.visitorHash },
          { key: ownerUniqueKey(user.id, day), member: c.visitorHash },
          { key: linkUniqueKey(link.id, 'all'), member: c.visitorHash },
        ];
      }),
      UNIQUE_TTL_SECONDS,
    );
    clickTotal += clicks.length;
  }
  return { links: LINKS.length, clicks: clickTotal };
}

/**
 * Optional "live" demo traffic: pushes a click through the real queue -> flusher
 * -> SSE path every few seconds so the dashboard's Live indicator moves.
 */
export function startDemoTraffic(ctx: AppContext, everyMs = 2500): () => void {
  const rand = prng(Date.now() & 0xffff);
  const timer = setInterval(async () => {
    const user = await ctx.infra.store.findUserByEmail(DEMO_EMAIL);
    if (!user) return;
    const links = (await ctx.infra.store.listLinks(user.id, { limit: 20 })).filter(
      (l) => !l.disabled && !l.passwordHash && !l.expiresAt && l.maxClicks === null,
    );
    if (!links.length) return;
    const link = links[Math.floor(rand() * Math.min(links.length, 6))]!;
    const picked = pick(rand, COUNTRIES);
    const country = picked === 'Unknown' ? null : picked;
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
    const click: RawClick = {
      id: randomUUID(),
      linkId: link.id,
      ownerId: link.ownerId,
      ts: Date.now(),
      visitorHash: visitorHash('demo', `live-${Math.floor(rand() * 5000)}`, ''),
      userAgent: ua,
      referrer: pick(rand, [['https://www.linkedin.com/', 3], ['https://x.com/', 2], [null, 3]] as Weighted<string | null>),
      country,
      isBot: false,
    };
    ctx.infra.queue.enqueue(click);
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
