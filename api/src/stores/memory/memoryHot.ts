import { EventEmitter } from 'node:events';
import type { RawClick } from '../../domain/types.js';
import { HyperLogLog } from '../../lib/hyperloglog.js';
import { decide, windowIndex, type RateDecision } from '../../lib/slidingWindow.js';
import type { Cache, ClickQueue, EventBus, LiveEvent, QuotaCounter, RateLimiter, UniqueCounter } from '../types.js';

type Clock = () => number;

/** TTL cache with lazy expiry and a size cap (oldest-inserted evicted first). */
export class MemoryCache implements Cache {
  private map = new Map<string, { value: string; expiresAt: number }>();
  constructor(private readonly now: Clock = Date.now, private readonly maxEntries = 100_000) {}

  async get(key: string): Promise<string | null> {
    const e = this.map.get(key);
    if (!e) return null;
    if (e.expiresAt <= this.now()) {
      this.map.delete(key);
      return null;
    }
    return e.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.map.delete(key);
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async del(...keys: string[]): Promise<void> {
    for (const k of keys) this.map.delete(k);
  }
}

export class MemoryRateLimiter implements RateLimiter {
  private windows = new Map<string, { index: number; prev: number; curr: number }>();
  private lastSweep = 0;

  constructor(private readonly clock: Clock = Date.now) {}

  async hit(key: string, limit: number, windowMs: number, now = this.clock()): Promise<RateDecision> {
    const index = windowIndex(now, windowMs);
    let w = this.windows.get(key);
    if (!w) {
      w = { index, prev: 0, curr: 0 };
      this.windows.set(key, w);
    } else if (w.index !== index) {
      // Roll forward: the old current window becomes "previous" only if it is adjacent.
      w.prev = w.index === index - 1 ? w.curr : 0;
      w.curr = 0;
      w.index = index;
    }
    const decision = decide({ prev: w.prev, curr: w.curr }, now, windowMs, limit);
    if (decision.allowed) w.curr += 1;
    this.sweep(now, windowMs);
    return decision;
  }

  /** Drop idle keys occasionally so memory stays bounded. */
  private sweep(now: number, windowMs: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    const index = windowIndex(now, windowMs);
    for (const [k, w] of this.windows) if (w.index < index - 1) this.windows.delete(k);
  }
}

/**
 * Bounded in-process queue. If the writer falls far behind, the oldest events
 * are dropped (and counted) rather than letting memory grow without bound:
 * losing a few analytics events is preferable to slowing redirects down.
 */
export class MemoryClickQueue implements ClickQueue {
  private items: RawClick[] = [];
  dropped = 0;

  constructor(private readonly maxSize = 100_000) {}

  enqueue(click: RawClick): void {
    if (this.items.length >= this.maxSize) {
      this.items.shift();
      this.dropped++;
    }
    this.items.push(click);
  }

  async take(max: number): Promise<{ clicks: RawClick[]; ack: () => Promise<void> }> {
    const clicks = this.items.splice(0, max);
    return {
      clicks,
      ack: async () => {},
    };
  }

  async depth(): Promise<number> {
    return this.items.length;
  }
}

export class MemoryUniqueCounter implements UniqueCounter {
  private hlls = new Map<string, HyperLogLog>();

  async add(entries: { key: string; member: string }[]): Promise<void> {
    for (const { key, member } of entries) {
      let h = this.hlls.get(key);
      if (!h) {
        h = new HyperLogLog();
        this.hlls.set(key, h);
      }
      h.add(member);
    }
  }

  async count(keys: string[]): Promise<number> {
    const present = keys.map((k) => this.hlls.get(k)).filter((h): h is HyperLogLog => !!h);
    if (present.length === 0) return 0;
    if (present.length === 1) return present[0]!.count();
    return HyperLogLog.union(present).count();
  }
}

export class MemoryQuotaCounter implements QuotaCounter {
  private counts = new Map<string, number>();

  async consume(key: string, max: number, seed: () => Promise<number>): Promise<boolean> {
    if (!this.counts.has(key)) {
      const initial = await seed();
      if (!this.counts.has(key)) this.counts.set(key, initial);
    }
    const used = this.counts.get(key)!;
    if (used >= max) return false;
    this.counts.set(key, used + 1);
    return true;
  }

  async reset(key: string): Promise<void> {
    this.counts.delete(key);
  }
}

export class MemoryEventBus implements EventBus {
  private emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(event: LiveEvent): void {
    this.emitter.emit(event.linkId, event);
  }

  subscribe(linkId: string, listener: (event: LiveEvent) => void): () => void {
    this.emitter.on(linkId, listener);
    return () => this.emitter.off(linkId, listener);
  }
}
