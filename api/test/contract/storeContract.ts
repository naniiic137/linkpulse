import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { UniqueViolation } from '../../src/domain/errors.js';
import type { ClickRecord, LinkRecord, User } from '../../src/domain/types.js';
import { DAY, HOUR } from '../../src/lib/time.js';
import type { Infrastructure } from '../../src/stores/types.js';

/**
 * Behavioural contract every backend must satisfy. Run against the in-memory
 * implementation locally and against PostgreSQL + Redis in CI, so the fake
 * can't drift from the real thing.
 */
export function storeContract(name: string, make: () => Promise<Infrastructure>, enabled = true) {
  const T = Date.UTC(2026, 8, 1, 0, 0, 0);

  const user = (): User => ({
    id: randomUUID(),
    email: `c-${randomUUID()}@example.com`,
    name: 'Contract',
    passwordHash: 'x',
    createdAt: new Date(T),
  });
  let nextId = 5_000_000 + Math.floor(Math.random() * 1_000_000);
  const link = (ownerId: string, over: Partial<LinkRecord> = {}): LinkRecord => {
    const id = String(nextId++);
    return {
      id, code: `c${id}`, ownerId, url: 'https://example.com', title: null, faviconUrl: null, isCustom: false,
      passwordHash: null, expiresAt: null, maxClicks: null, disabled: false, publicStats: false, clickCount: 0,
      createdAt: new Date(T), updatedAt: new Date(T), ...over,
    };
  };
  const click = (linkId: string, ts: number, over: Partial<ClickRecord> = {}): ClickRecord => ({
    id: randomUUID(), linkId, ts: new Date(ts), visitorHash: 'v', referrer: 'direct', country: 'TN',
    device: 'desktop', browser: 'Chrome', os: 'Windows', isBot: false, ...over,
  });

  describe.skipIf(!enabled)(`store contract: ${name}`, () => {
    it('users: unique email (case-insensitive) and lookups', async () => {
      const infra = await make();
      try {
        const u = user();
        await infra.store.createUser(u);
        expect((await infra.store.findUserByEmail(u.email.toUpperCase()))?.id).toBe(u.id);
        expect((await infra.store.findUserById(u.id))?.email).toBe(u.email);
        await expect(infra.store.createUser({ ...user(), email: u.email.toUpperCase() })).rejects.toBeInstanceOf(UniqueViolation);
      } finally {
        await infra.close();
      }
    });

    it('links: unique code, update, cursor pagination, delete cascades clicks', async () => {
      const infra = await make();
      try {
        const u = user();
        await infra.store.createUser(u);
        const a = link(u.id, { createdAt: new Date(T), title: 'Alpha' });
        const b = link(u.id, { createdAt: new Date(T + 1000) });
        await infra.store.insertLink(a);
        await infra.store.insertLink(b);
        await expect(infra.store.insertLink({ ...link(u.id), code: a.code })).rejects.toBeInstanceOf(UniqueViolation);

        expect((await infra.store.findLinkByCode(a.code))?.id).toBe(a.id);
        const first = await infra.store.listLinks(u.id, { limit: 1 });
        expect(first.map((l) => l.id)).toEqual([b.id]);
        const next = await infra.store.listLinks(u.id, { limit: 5, cursor: { createdAt: b.createdAt, id: b.id } });
        expect(next.map((l) => l.id)).toEqual([a.id]);
        expect((await infra.store.listLinks(u.id, { limit: 5, q: 'alph' })).map((l) => l.id)).toEqual([a.id]);

        const updated = await infra.store.updateLink(a.id, { disabled: true, maxClicks: 10, expiresAt: null }, new Date(T + 5000));
        expect(updated).toMatchObject({ disabled: true, maxClicks: 10, expiresAt: null });
        expect(updated?.updatedAt.getTime()).toBe(T + 5000);
        expect(await infra.store.countLinks(u.id, new Date(T))).toEqual({ total: 2, active: 1 });

        await infra.store.insertClicks([click(a.id, T)]);
        expect(await infra.store.deleteLink(a.id)).toBe(true);
        expect(await infra.store.findLinkById(a.id)).toBeNull();
        expect(await infra.store.exportClicks(a.id, { from: new Date(T - DAY), to: new Date(T + DAY) }, 10)).toEqual([]);
      } finally {
        await infra.close();
      }
    });

    it('id blocks are strictly increasing', async () => {
      const infra = await make();
      try {
        const a = await infra.store.nextIdBlock();
        const b = await infra.store.nextIdBlock();
        expect(b).toBeGreaterThan(a);
      } finally {
        await infra.close();
      }
    });

    it('clicks: idempotent inserts, human counter, aggregation by bucket and dimension', async () => {
      const infra = await make();
      try {
        const u = user();
        await infra.store.createUser(u);
        const l = link(u.id);
        await infra.store.insertLink(l);
        const c1 = click(l.id, T + 10 * 60_000, { referrer: 'x.com', country: 'FR', device: 'mobile', browser: 'Safari', os: 'iOS' });
        const batch = [
          c1,
          click(l.id, T + 20 * 60_000),
          click(l.id, T + 2 * HOUR + 5),
          click(l.id, T + 2 * HOUR + 6, { isBot: true, device: 'bot' }),
          click('999999999', T), // unknown link: skipped, not an error
        ];
        expect(await infra.store.insertClicks(batch)).toBe(4);
        expect(await infra.store.insertClicks([c1])).toBe(0); // redelivery
        expect((await infra.store.findLinkById(l.id))?.clickCount).toBe(3);

        const agg = await infra.store.aggregateClicks(l.id, { from: new Date(T), to: new Date(T + 3 * HOUR) }, 'hour');
        expect(agg.clicks).toBe(3);
        expect(agg.bots).toBe(1);
        expect(agg.series.map((s) => [s.t.getTime(), s.clicks])).toEqual([[T, 2], [T + 2 * HOUR, 1]]);
        expect(agg.referrers).toEqual([{ name: 'direct', clicks: 2 }, { name: 'x.com', clicks: 1 }]);
        expect(agg.countries).toEqual([{ name: 'TN', clicks: 2 }, { name: 'FR', clicks: 1 }]);
        expect(agg.devices).toEqual([{ name: 'desktop', clicks: 2 }, { name: 'mobile', clicks: 1 }]);
        expect(agg.os).toEqual([{ name: 'Windows', clicks: 2 }, { name: 'iOS', clicks: 1 }]);

        const daily = await infra.store.aggregateClicks(l.id, { from: new Date(T), to: new Date(T + DAY) }, 'day');
        expect(daily.series).toEqual([{ t: new Date(T), clicks: 3 }]);

        const owner = await infra.store.aggregateOwner(u.id, { from: new Date(T), to: new Date(T + DAY) }, 5);
        expect(owner.clicks).toBe(3);
        expect(owner.topLinks).toEqual([{ linkId: l.id, clicks: 3 }]);

        const rows = await infra.store.exportClicks(l.id, { from: new Date(T), to: new Date(T + DAY) }, 10);
        expect(rows).toHaveLength(4);
        expect(rows[0]!.ts.getTime()).toBe(T + 10 * 60_000);
      } finally {
        await infra.close();
      }
    });

    it('api keys: lookup by hash, scoped delete, touch', async () => {
      const infra = await make();
      try {
        const u = user();
        const other = user();
        await infra.store.createUser(u);
        await infra.store.createUser(other);
        const key = { id: randomUUID(), userId: u.id, name: 'k', prefix: 'lp_live_abcd', keyHash: randomUUID(), createdAt: new Date(T), lastUsedAt: null };
        await infra.store.createApiKey(key);
        expect((await infra.store.findApiKeyByHash(key.keyHash))?.id).toBe(key.id);
        await infra.store.touchApiKey(key.id, new Date(T + 1000));
        expect((await infra.store.listApiKeys(u.id))[0]?.lastUsedAt?.getTime()).toBe(T + 1000);
        expect(await infra.store.deleteApiKey(other.id, key.id)).toBe(false);
        expect(await infra.store.deleteApiKey(u.id, key.id)).toBe(true);
        expect(await infra.store.findApiKeyByHash(key.keyHash)).toBeNull();
      } finally {
        await infra.close();
      }
    });

    it('hot layer: cache TTL + delete, HyperLogLog union, atomic quota, rate limiter', async () => {
      const infra = await make();
      try {
        const k = `lp:test:${randomUUID()}`;
        await infra.cache.set(k, 'v', 60);
        expect(await infra.cache.get(k)).toBe('v');
        await infra.cache.del(k);
        expect(await infra.cache.get(k)).toBeNull();

        const tag = randomUUID();
        const d1 = `lp:uniq:{${tag}}:1`;
        const d2 = `lp:uniq:{${tag}}:2`;
        await infra.uniques.add(Array.from({ length: 300 }, (_, i) => ({ key: d1, member: `m${i}` })), 60);
        await infra.uniques.add(Array.from({ length: 300 }, (_, i) => ({ key: d2, member: `m${i + 150}` })), 60);
        const union = await infra.uniques.count([d1, d2]);
        expect(Math.abs(union - 450)).toBeLessThanOrEqual(10);
        expect(await infra.uniques.count([`lp:uniq:{${tag}}:none`])).toBe(0);

        const q = `lp:quota:{${randomUUID()}}`;
        const results = await Promise.all(Array.from({ length: 10 }, () => infra.quota.consume(q, 7, async () => 2)));
        expect(results.filter(Boolean)).toHaveLength(5); // seeded with 2 already used
        await infra.quota.reset(q);
        expect(await infra.quota.consume(q, 7, async () => 0)).toBe(true);

        const rk = `test:${randomUUID()}`;
        const now = 1_000 * 60_000 + 1;
        const decisions = [];
        for (let i = 0; i < 4; i++) decisions.push(await infra.rateLimiter.hit(rk, 3, 60_000, now));
        expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, false]);
        expect(decisions[3]!.retryAfterMs).toBeGreaterThan(0);
      } finally {
        await infra.close();
      }
    });

    it('queue: take + ack round-trips events', async () => {
      const infra = await make();
      try {
        // Drain leftovers from other tests first.
        for (let i = 0; i < 20; i++) {
          const { clicks, ack } = await infra.queue.take(1000);
          await ack();
          if (!clicks.length) break;
        }
        const id = randomUUID();
        infra.queue.enqueue({ id, linkId: '1', ownerId: 'o', ts: T, visitorHash: 'v', userAgent: 'ua', referrer: null, country: null, isBot: false });
        let got: string[] = [];
        for (let i = 0; i < 20 && !got.length; i++) {
          const { clicks, ack } = await infra.queue.take(10);
          got = clicks.map((c) => c.id);
          await ack();
          if (!got.length) await new Promise((r) => setTimeout(r, 25));
        }
        expect(got).toEqual([id]);
      } finally {
        await infra.close();
      }
    });
  });
}
