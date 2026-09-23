import { randomUUID } from 'node:crypto';
import type { RawClick, RedirectEntry } from '../domain/types.js';
import { verifyPassword, visitorHash } from '../lib/crypto.js';
import { CODE_PATTERN } from '../lib/urlSafety.js';
import { isBotAgent } from '../lib/userAgent.js';
import type { Cache, ClickQueue, QuotaCounter, Store } from '../stores/types.js';
import { linkCacheKey, quotaKey, toRedirectEntry } from './linkService.js';

export interface VisitContext {
  ip: string;
  userAgent: string;
  referrer: string | null;
  country: string | null;
}

export type RedirectOutcome =
  | { kind: 'redirect'; url: string; status: 301 | 302 | 303; cache: 'hit' | 'miss' }
  | { kind: 'not_found' }
  | { kind: 'gone'; reason: 'disabled' | 'expired' | 'limit_reached' }
  | { kind: 'password_required'; code: string; error?: string };

/** Sentinel cached for unknown codes so scanners can't hammer the database. */
const NEGATIVE = '0';

export interface RedirectDeps {
  store: Store;
  cache: Cache;
  queue: ClickQueue;
  quota: QuotaCounter;
  now: () => number;
  redirectStatus: 301 | 302;
  visitorSalt: string;
  cacheTtlSeconds: number;
  negativeTtlSeconds: number;
  onCacheError?: (err: unknown) => void;
}

/**
 * The read-heavy hot path. For a warm link a redirect is:
 *   1 cache GET  ->  in-process checks  ->  fire-and-forget enqueue  ->  302
 * (+1 atomic quota call only for links with a max-clicks limit).
 * Nothing on this path waits for analytics or touches PostgreSQL.
 */
export class RedirectService {
  constructor(private readonly d: RedirectDeps) {}

  /** Cache-aside lookup with TTL jitter and negative caching. */
  async lookup(code: string): Promise<{ entry: RedirectEntry | null; cache: 'hit' | 'miss' }> {
    const key = linkCacheKey(code);
    try {
      const cached = await this.d.cache.get(key);
      if (cached === NEGATIVE) return { entry: null, cache: 'hit' };
      if (cached) return { entry: JSON.parse(cached) as RedirectEntry, cache: 'hit' };
    } catch (err) {
      // Cache down: degrade to the database instead of failing redirects.
      this.d.onCacheError?.(err);
    }
    const link = await this.d.store.findLinkByCode(code);
    const entry = link ? toRedirectEntry(link) : null;
    // +-10% jitter so keys written together don't all expire together (thundering herd).
    const ttl = entry
      ? Math.round(this.d.cacheTtlSeconds * (0.9 + Math.random() * 0.2))
      : this.d.negativeTtlSeconds;
    this.d.cache.set(key, entry ? JSON.stringify(entry) : NEGATIVE, ttl).catch((err) => this.d.onCacheError?.(err));
    return { entry, cache: 'miss' };
  }

  async resolve(code: string, ctx: VisitContext): Promise<RedirectOutcome> {
    if (!CODE_PATTERN.test(code)) return { kind: 'not_found' };
    const { entry, cache } = await this.lookup(code);
    if (!entry) return { kind: 'not_found' };
    const blocked = this.check(entry);
    if (blocked) return blocked;
    if (entry.hasPassword) return { kind: 'password_required', code };
    return this.admit(entry, ctx, this.d.redirectStatus, cache);
  }

  /** Password form submission. Always reads the hash from the source of truth (it is never cached). */
  async unlock(code: string, password: string, ctx: VisitContext): Promise<RedirectOutcome> {
    if (!CODE_PATTERN.test(code)) return { kind: 'not_found' };
    const link = await this.d.store.findLinkByCode(code);
    if (!link) return { kind: 'not_found' };
    const entry = toRedirectEntry(link);
    const blocked = this.check(entry);
    if (blocked) return blocked;
    if (link.passwordHash && !(await verifyPassword(link.passwordHash, password))) {
      return { kind: 'password_required', code, error: 'Incorrect password' };
    }
    // 303 See Other: the browser follows with a GET to the destination.
    return this.admit(entry, ctx, 303, 'miss');
  }

  private check(entry: RedirectEntry): RedirectOutcome | null {
    if (entry.disabled) return { kind: 'gone', reason: 'disabled' };
    if (entry.expiresAt !== null && entry.expiresAt <= this.d.now()) return { kind: 'gone', reason: 'expired' };
    return null;
  }

  private async admit(
    entry: RedirectEntry,
    ctx: VisitContext,
    status: 301 | 302 | 303,
    cache: 'hit' | 'miss',
  ): Promise<RedirectOutcome> {
    const isBot = isBotAgent(ctx.userAgent);
    // Max-clicks is a correctness rule, not analytics, so it is enforced synchronously and atomically.
    // Bots (link unfurlers, crawlers) are redirected but never consume the quota.
    if (entry.maxClicks !== null && !isBot) {
      const ok = await this.d.quota.consume(quotaKey(entry.id), entry.maxClicks, async () => {
        const link = await this.d.store.findLinkById(entry.id);
        return link?.clickCount ?? 0;
      });
      if (!ok) return { kind: 'gone', reason: 'limit_reached' };
    }
    const click: RawClick = {
      id: randomUUID(),
      linkId: entry.id,
      ownerId: entry.ownerId,
      ts: this.d.now(),
      visitorHash: visitorHash(this.d.visitorSalt, ctx.ip, ctx.userAgent),
      userAgent: ctx.userAgent.slice(0, 512),
      referrer: ctx.referrer ? ctx.referrer.slice(0, 512) : null,
      country: ctx.country,
      isBot,
    };
    this.d.queue.enqueue(click); // not awaited: analytics never delay the redirect
    return { kind: 'redirect', url: entry.url, status, cache };
  }
}
