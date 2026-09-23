import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
import type { Redis } from 'ioredis';
import type { RawClick } from '../../domain/types.js';
import { decide, windowIndex, type RateDecision } from '../../lib/slidingWindow.js';
import type { Cache, ClickQueue, EventBus, LiveEvent, QuotaCounter, RateLimiter, UniqueCounter } from '../types.js';

export class RedisCache implements Cache {
  constructor(private readonly redis: Redis) {}

  get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, 'EX', ttlSeconds);
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length) await this.redis.del(...keys);
  }
}

/**
 * Sliding-window counter in one atomic Lua script: read previous + current
 * window counts, decide, and INCR only when allowed. Keys share a hash tag so
 * the script is valid on Redis Cluster.
 */
const RATE_LIMIT_LUA = `
local curr = tonumber(redis.call('GET', KEYS[1]) or '0')
local prev = tonumber(redis.call('GET', KEYS[2]) or '0')
local elapsed = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local est = prev * (1 - elapsed / window) + curr
if est + 1 <= limit then
  redis.call('INCR', KEYS[1])
  redis.call('PEXPIRE', KEYS[1], window * 2)
  return {1, prev, curr}
end
return {0, prev, curr}
`;

export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly redis: Redis) {
    redis.defineCommand('lpRateLimit', { numberOfKeys: 2, lua: RATE_LIMIT_LUA });
  }

  async hit(key: string, limit: number, windowMs: number, now = Date.now()): Promise<RateDecision> {
    const index = windowIndex(now, windowMs);
    const elapsed = now - index * windowMs;
    const base = `lp:rl:{${key}}`;
    const [allowed, prev, curr] = (await (this.redis as unknown as RateLimitCommand).lpRateLimit(
      `${base}:${index}`,
      `${base}:${index - 1}`,
      elapsed,
      windowMs,
      limit,
    )) as [number, number, number];
    const decision = decide({ prev, curr }, now, windowMs, limit);
    // Lua made the authoritative (atomic) call; keep the headers consistent with it.
    if (allowed === 1 && !decision.allowed) return { ...decision, allowed: true, remaining: 0, retryAfterMs: 0 };
    return decision;
  }
}

interface RateLimitCommand {
  lpRateLimit(...args: (string | number)[]): Promise<unknown>;
}

const STREAM = 'lp:clicks';
const GROUP = 'lp-flushers';

/**
 * Redis Streams + consumer group: every API instance can XADD, any instance's
 * flusher can XREADGROUP. Entries stay pending until XACKed after the database
 * write, and entries left pending by a crashed consumer are reclaimed with
 * XAUTOCLAIM. Delivery is at-least-once; the store makes inserts idempotent.
 */
export class RedisClickQueue implements ClickQueue {
  private groupReady: Promise<void> | null = null;
  private readonly consumer = `${hostname()}-${process.pid}`;

  constructor(
    private readonly redis: Redis,
    private readonly maxLen = 1_000_000,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  private ensureGroup(): Promise<void> {
    this.groupReady ??= this.redis
      .xgroup('CREATE', STREAM, GROUP, '0', 'MKSTREAM')
      .then(() => undefined)
      .catch((err: Error) => {
        if (!String(err.message).includes('BUSYGROUP')) {
          this.groupReady = null;
          throw err;
        }
      });
    return this.groupReady;
  }

  enqueue(click: RawClick): void {
    this.redis
      .xadd(STREAM, 'MAXLEN', '~', String(this.maxLen), '*', 'c', JSON.stringify(click))
      .catch(this.onError);
  }

  async take(max: number): Promise<{ clicks: RawClick[]; ack: () => Promise<void> }> {
    await this.ensureGroup();
    // Reclaim anything another (dead) consumer left pending for over a minute.
    const claimed = (await this.redis.xautoclaim(STREAM, GROUP, this.consumer, 60_000, '0-0', 'COUNT', max)) as [
      string,
      [string, string[]][],
    ];
    let entries = claimed[1] ?? [];
    if (entries.length === 0) {
      const res = (await this.redis.xreadgroup('GROUP', GROUP, this.consumer, 'COUNT', max, 'STREAMS', STREAM, '>')) as
        | [string, [string, string[]][]][]
        | null;
      entries = res?.[0]?.[1] ?? [];
    }
    const ids: string[] = [];
    const clicks: RawClick[] = [];
    for (const [id, fields] of entries) {
      ids.push(id);
      const idx = fields?.indexOf('c') ?? -1;
      if (idx >= 0 && fields[idx + 1]) {
        try {
          clicks.push(JSON.parse(fields[idx + 1]!) as RawClick);
        } catch {
          // poison message: ack and skip
        }
      }
    }
    return {
      clicks,
      ack: async () => {
        if (ids.length) await this.redis.xack(STREAM, GROUP, ...ids);
      },
    };
  }

  async depth(): Promise<number> {
    await this.ensureGroup();
    const groups = (await this.redis.xinfo('GROUPS', STREAM)) as unknown[][];
    for (const g of groups) {
      const map = new Map<string, unknown>();
      for (let i = 0; i < g.length; i += 2) map.set(String(g[i]), g[i + 1]);
      if (map.get('name') === GROUP) return Number(map.get('pending') ?? 0) + Number(map.get('lag') ?? 0);
    }
    return 0;
  }
}

export class RedisUniqueCounter implements UniqueCounter {
  constructor(private readonly redis: Redis) {}

  async add(entries: { key: string; member: string }[], ttlSeconds: number): Promise<void> {
    if (!entries.length) return;
    const byKey = new Map<string, string[]>();
    for (const { key, member } of entries) byKey.set(key, [...(byKey.get(key) ?? []), member]);
    const pipeline = this.redis.pipeline();
    for (const [key, members] of byKey) {
      pipeline.pfadd(key, ...members);
      pipeline.expire(key, ttlSeconds);
    }
    await pipeline.exec();
  }

  async count(keys: string[]): Promise<number> {
    if (!keys.length) return 0;
    return this.redis.pfcount(...keys);
  }
}

const QUOTA_LUA = `
local v = redis.call('GET', KEYS[1])
if not v then return -1 end
if tonumber(v) >= tonumber(ARGV[1]) then return 0 end
redis.call('INCR', KEYS[1])
return 1
`;

export class RedisQuotaCounter implements QuotaCounter {
  constructor(private readonly redis: Redis) {
    redis.defineCommand('lpQuota', { numberOfKeys: 1, lua: QUOTA_LUA });
  }

  async consume(key: string, max: number, seed: () => Promise<number>): Promise<boolean> {
    const run = () => (this.redis as unknown as { lpQuota(k: string, m: number): Promise<number> }).lpQuota(key, max);
    let r = await run();
    if (r === -1) {
      // Cold key: seed from the persisted click count. NX so concurrent seeders don't clobber increments.
      await this.redis.set(key, String(await seed()), 'EX', 30 * 86_400, 'NX');
      r = await run();
    }
    return r === 1;
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

const LIVE_CHANNEL = 'lp:live';

/** One Redis channel, fanned out locally so N SSE clients cost one subscription per instance. */
export class RedisEventBus implements EventBus {
  private emitter = new EventEmitter();
  private started = false;

  constructor(
    private readonly pub: Redis,
    private readonly sub: Redis,
  ) {
    this.emitter.setMaxListeners(0);
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    void this.sub.subscribe(LIVE_CHANNEL);
    this.sub.on('message', (channel: string, message: string) => {
      if (channel !== LIVE_CHANNEL) return;
      try {
        const event = JSON.parse(message) as LiveEvent;
        this.emitter.emit(event.linkId, event);
      } catch {
        /* ignore malformed */
      }
    });
  }

  publish(event: LiveEvent): void {
    void this.pub.publish(LIVE_CHANNEL, JSON.stringify(event)).catch(() => {});
  }

  subscribe(linkId: string, listener: (event: LiveEvent) => void): () => void {
    this.start();
    this.emitter.on(linkId, listener);
    return () => this.emitter.off(linkId, listener);
  }
}
