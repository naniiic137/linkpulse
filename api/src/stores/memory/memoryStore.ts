import { UniqueViolation } from '../../domain/errors.js';
import type {
  ApiKeyRecord,
  Bucket,
  ClickAggregate,
  ClickRecord,
  LinkPatch,
  LinkRecord,
  NamedCount,
  OwnerAggregate,
  TimeRange,
  User,
} from '../../domain/types.js';
import { truncate } from '../../lib/time.js';
import type { Store } from '../types.js';

const clone = <T>(v: T): T => structuredClone(v);

function topCounts(values: Iterable<string>, limit = 10): NamedCount[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, clicks]) => ({ name, clicks }))
    .sort((a, b) => b.clicks - a.clicks || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * In-memory implementation of the source-of-truth Store. Same semantics as
 * the PostgreSQL store (unique constraints, idempotent click inserts, cascade
 * deletes), verified by the shared contract tests.
 */
export class MemoryStore implements Store {
  private users = new Map<string, User>();
  private emails = new Map<string, string>();
  private keys = new Map<string, ApiKeyRecord>();
  private links = new Map<string, LinkRecord>();
  private codes = new Map<string, string>();
  /** Clicks grouped by link for cheap per-link scans. */
  private clicks = new Map<string, ClickRecord[]>();
  private clickIds = new Set<string>();
  private block = 0;

  async createUser(user: User): Promise<void> {
    const email = user.email.toLowerCase();
    if (this.emails.has(email)) throw new UniqueViolation('email');
    this.users.set(user.id, clone(user));
    this.emails.set(email, user.id);
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const id = this.emails.get(email.toLowerCase());
    return id ? clone(this.users.get(id)!) : null;
  }

  async findUserById(id: string): Promise<User | null> {
    const u = this.users.get(id);
    return u ? clone(u) : null;
  }

  async createApiKey(key: ApiKeyRecord): Promise<void> {
    for (const k of this.keys.values()) if (k.keyHash === key.keyHash) throw new UniqueViolation('key_hash');
    this.keys.set(key.id, clone(key));
  }

  async listApiKeys(userId: string): Promise<ApiKeyRecord[]> {
    return [...this.keys.values()]
      .filter((k) => k.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(clone);
  }

  async findApiKeyByHash(hash: string): Promise<ApiKeyRecord | null> {
    for (const k of this.keys.values()) if (k.keyHash === hash) return clone(k);
    return null;
  }

  async deleteApiKey(userId: string, id: string): Promise<boolean> {
    const k = this.keys.get(id);
    if (!k || k.userId !== userId) return false;
    return this.keys.delete(id);
  }

  async touchApiKey(id: string, at: Date): Promise<void> {
    const k = this.keys.get(id);
    if (k) k.lastUsedAt = at;
  }

  async nextIdBlock(): Promise<number> {
    this.block += 1;
    return this.block;
  }

  async insertLink(link: LinkRecord): Promise<void> {
    if (this.codes.has(link.code)) throw new UniqueViolation('code');
    if (this.links.has(link.id)) throw new UniqueViolation('id');
    this.links.set(link.id, clone(link));
    this.codes.set(link.code, link.id);
  }

  async findLinkById(id: string): Promise<LinkRecord | null> {
    const l = this.links.get(id);
    return l ? clone(l) : null;
  }

  async findLinkByCode(code: string): Promise<LinkRecord | null> {
    const id = this.codes.get(code);
    return id ? clone(this.links.get(id)!) : null;
  }

  async listLinks(
    ownerId: string,
    opts: { limit: number; cursor?: { createdAt: Date; id: string }; q?: string },
  ): Promise<LinkRecord[]> {
    const q = opts.q?.toLowerCase();
    const cursor = opts.cursor;
    return [...this.links.values()]
      .filter((l) => l.ownerId === ownerId)
      .filter((l) => !q || l.code.toLowerCase().includes(q) || l.url.toLowerCase().includes(q) || (l.title ?? '').toLowerCase().includes(q))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || compareIdDesc(a.id, b.id))
      .filter((l) => {
        if (!cursor) return true;
        const t = l.createdAt.getTime();
        const c = cursor.createdAt.getTime();
        return t < c || (t === c && compareIdDesc(l.id, cursor.id) > 0);
      })
      .slice(0, opts.limit)
      .map(clone);
  }

  async countLinks(ownerId: string, now: Date): Promise<{ total: number; active: number }> {
    let total = 0;
    let active = 0;
    for (const l of this.links.values()) {
      if (l.ownerId !== ownerId) continue;
      total++;
      const expired = l.expiresAt !== null && l.expiresAt.getTime() <= now.getTime();
      const exhausted = l.maxClicks !== null && l.clickCount >= l.maxClicks;
      if (!l.disabled && !expired && !exhausted) active++;
    }
    return { total, active };
  }

  async updateLink(id: string, patch: LinkPatch, now: Date): Promise<LinkRecord | null> {
    const l = this.links.get(id);
    if (!l) return null;
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) (l as unknown as Record<string, unknown>)[k] = v;
    }
    l.updatedAt = now;
    return clone(l);
  }

  async deleteLink(id: string): Promise<boolean> {
    const l = this.links.get(id);
    if (!l) return false;
    this.links.delete(id);
    this.codes.delete(l.code);
    for (const c of this.clicks.get(id) ?? []) this.clickIds.delete(c.id);
    this.clicks.delete(id);
    return true;
  }

  async insertClicks(clicks: ClickRecord[]): Promise<number> {
    let inserted = 0;
    for (const c of clicks) {
      if (this.clickIds.has(c.id)) continue;
      const link = this.links.get(c.linkId);
      if (!link) continue; // link deleted while the event was queued (FK would reject it)
      this.clickIds.add(c.id);
      const list = this.clicks.get(c.linkId) ?? [];
      list.push(c); // records are built by the pipeline and never mutated afterwards
      this.clicks.set(c.linkId, list);
      if (!c.isBot) link.clickCount += 1;
      inserted++;
    }
    return inserted;
  }

  private inRange(linkId: string, range: TimeRange): ClickRecord[] {
    const from = range.from.getTime();
    const to = range.to.getTime();
    return (this.clicks.get(linkId) ?? []).filter((c) => c.ts.getTime() >= from && c.ts.getTime() < to);
  }

  async aggregateClicks(linkId: string, range: TimeRange, bucket: Bucket): Promise<ClickAggregate> {
    const all = this.inRange(linkId, range);
    const humans = all.filter((c) => !c.isBot);
    const series = new Map<number, number>();
    for (const c of humans) {
      const t = truncate(c.ts.getTime(), bucket);
      series.set(t, (series.get(t) ?? 0) + 1);
    }
    return {
      clicks: humans.length,
      bots: all.length - humans.length,
      series: [...series.entries()].sort((a, b) => a[0] - b[0]).map(([t, clicks]) => ({ t: new Date(t), clicks })),
      referrers: topCounts(humans.map((c) => c.referrer)),
      countries: topCounts(humans.map((c) => c.country)),
      browsers: topCounts(humans.map((c) => c.browser)),
      os: topCounts(humans.map((c) => c.os)),
      devices: topCounts(humans.map((c) => c.device)),
    };
  }

  async aggregateOwner(ownerId: string, range: TimeRange, topN: number): Promise<OwnerAggregate> {
    const series = new Map<number, number>();
    const perLink = new Map<string, number>();
    let clicks = 0;
    for (const link of this.links.values()) {
      if (link.ownerId !== ownerId) continue;
      for (const c of this.inRange(link.id, range)) {
        if (c.isBot) continue;
        clicks++;
        const t = truncate(c.ts.getTime(), 'day');
        series.set(t, (series.get(t) ?? 0) + 1);
        perLink.set(link.id, (perLink.get(link.id) ?? 0) + 1);
      }
    }
    return {
      clicks,
      series: [...series.entries()].sort((a, b) => a[0] - b[0]).map(([t, n]) => ({ t: new Date(t), clicks: n })),
      topLinks: [...perLink.entries()]
        .map(([linkId, n]) => ({ linkId, clicks: n }))
        .sort((a, b) => b.clicks - a.clicks)
        .slice(0, topN),
    };
  }

  async exportClicks(linkId: string, range: TimeRange, limit: number): Promise<ClickRecord[]> {
    return this.inRange(linkId, range)
      .sort((a, b) => a.ts.getTime() - b.ts.getTime())
      .slice(0, limit)
      .map(clone);
  }

  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

/** Numeric ids are decimal strings; compare as numbers, descending. */
function compareIdDesc(a: string, b: string): number {
  if (a.length !== b.length) return b.length - a.length;
  return a < b ? 1 : a > b ? -1 : 0;
}
