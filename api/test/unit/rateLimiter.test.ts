import { describe, expect, it } from 'vitest';
import { decide, estimate } from '../../src/lib/slidingWindow.js';
import { MemoryRateLimiter } from '../../src/stores/memory/memoryHot.js';

const W = 60_000;
const T0 = 1_000 * W; // start of a window

describe('sliding window math', () => {
  it('weights the previous window by its remaining overlap', () => {
    // 25% into the current window: 75% of the previous window still overlaps.
    expect(estimate({ prev: 40, curr: 5 }, T0 + W / 4, W)).toBeCloseTo(40 * 0.75 + 5);
    expect(estimate({ prev: 40, curr: 5 }, T0, W)).toBe(45);
    expect(estimate({ prev: 40, curr: 5 }, T0 + W - 1, W)).toBeCloseTo(5, 2);
  });

  it('allows while estimate + 1 <= limit and reports remaining', () => {
    const d = decide({ prev: 0, curr: 7 }, T0 + 1000, W, 10);
    expect(d).toMatchObject({ allowed: true, remaining: 2, retryAfterMs: 0 });
    expect(decide({ prev: 0, curr: 9 }, T0, W, 10)).toMatchObject({ allowed: true, remaining: 0 });
    expect(decide({ prev: 0, curr: 10 }, T0, W, 10).allowed).toBe(false);
  });

  it('retryAfter is exact when the previous window decays within this window', () => {
    const state = { prev: 10, curr: 5 };
    const now = T0 + W / 10; // estimate = 10*0.9 + 5 = 14 > limit-1
    const d = decide(state, now, W, 10);
    expect(d.allowed).toBe(false);
    // Needs prev*(1-e/W)+5 <= 9  =>  e >= 0.6W, i.e. 0.5W from now.
    expect(d.retryAfterMs).toBe(W / 2);
    expect(decide(state, now + d.retryAfterMs, W, 10).allowed).toBe(true);
    expect(decide(state, now + d.retryAfterMs - 50, W, 10).allowed).toBe(false);
  });

  it('retryAfter spans into the next window when the current one is full', () => {
    const state = { prev: 0, curr: 20 };
    const now = T0 + W / 2;
    const d = decide(state, now, W, 10);
    // Next window: 20*(1-e/W) <= 9 => e >= 0.55W; plus 0.5W left in this window.
    expect(d.retryAfterMs).toBe(W / 2 + 0.55 * W);
    const later = now + d.retryAfterMs;
    expect(decide({ prev: 20, curr: 0 }, later, W, 10).allowed).toBe(true);
  });

  it('never allows a 2x burst at a window boundary (unlike a fixed window)', () => {
    // 10 requests at the very end of one window, then a burst right after the boundary.
    const d = decide({ prev: 10, curr: 0 }, T0 + 1, W, 10);
    expect(d.allowed).toBe(false);
  });
});

describe('MemoryRateLimiter', () => {
  it('lets exactly `limit` requests through, then blocks with Retry-After', async () => {
    let now = T0 + 5_000;
    const rl = new MemoryRateLimiter(() => now);
    const results = [];
    for (let i = 0; i < 12; i++) results.push(await rl.hit('ip:1', 10, W));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(results[9]).toMatchObject({ allowed: true, remaining: 0 });
    expect(results[10]).toMatchObject({ allowed: false, remaining: 0 });
    expect(results[10]!.retryAfterMs).toBeGreaterThan(0);

    // Blocked requests do not count: after the window rolls and decays enough we get in again.
    now += results[10]!.retryAfterMs;
    expect((await rl.hit('ip:1', 10, W)).allowed).toBe(true);
  });

  it('keeps keys independent', async () => {
    const rl = new MemoryRateLimiter(() => T0);
    for (let i = 0; i < 3; i++) await rl.hit('a', 3, W);
    expect((await rl.hit('a', 3, W)).allowed).toBe(false);
    expect((await rl.hit('b', 3, W)).allowed).toBe(true);
  });

  it('forgets a window that is more than one window old', async () => {
    let now = T0;
    const rl = new MemoryRateLimiter(() => now);
    for (let i = 0; i < 5; i++) await rl.hit('k', 5, W);
    now += 2 * W + 1;
    const d = await rl.hit('k', 5, W);
    expect(d).toMatchObject({ allowed: true, remaining: 4 });
  });
});
