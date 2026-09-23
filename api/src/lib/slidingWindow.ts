/**
 * Sliding-window-counter rate limiting (the approach popularised by Cloudflare).
 *
 * Instead of storing every request timestamp (sliding log, O(limit) memory),
 * keep two fixed-window counters - previous and current - and weight the
 * previous one by how much of it still overlaps the sliding window:
 *
 *     estimate = prev * (1 - elapsed / window) + curr
 *
 * O(1) memory per key, smooth at window boundaries (no 2x burst like a plain
 * fixed window), and trivially atomic in a Redis Lua script. This module holds
 * the pure math so the in-memory and Redis limiters make identical decisions.
 */

export interface WindowState {
  /** Requests counted in the previous fixed window. */
  prev: number;
  /** Requests counted in the current fixed window (before this request). */
  curr: number;
}

export interface RateDecision {
  allowed: boolean;
  limit: number;
  /** Requests still allowed right now (after this one, if it was allowed). */
  remaining: number;
  /** Milliseconds until a request would be allowed again (0 when allowed). */
  retryAfterMs: number;
  /** Milliseconds until the current fixed window rolls over. */
  resetMs: number;
}

export function windowIndex(now: number, windowMs: number): number {
  return Math.floor(now / windowMs);
}

export function estimate(state: WindowState, now: number, windowMs: number): number {
  const elapsed = now - windowIndex(now, windowMs) * windowMs;
  return state.prev * (1 - elapsed / windowMs) + state.curr;
}

export function decide(state: WindowState, now: number, windowMs: number, limit: number): RateDecision {
  const elapsed = now - windowIndex(now, windowMs) * windowMs;
  const toWindowEnd = windowMs - elapsed;
  const est = state.prev * (1 - elapsed / windowMs) + state.curr;
  const allowed = est + 1 <= limit;
  if (allowed) {
    return {
      allowed,
      limit,
      remaining: Math.max(0, Math.floor(limit - est - 1)),
      retryAfterMs: 0,
      resetMs: toWindowEnd,
    };
  }
  return { allowed, limit, remaining: 0, retryAfterMs: retryAfter(state, elapsed, windowMs, limit), resetMs: toWindowEnd };
}

/**
 * Smallest wait t such that a request at now + t would be allowed, i.e. the
 * weighted estimate has decayed enough for one more request to fit.
 */
function retryAfter(state: WindowState, elapsed: number, windowMs: number, limit: number): number {
  const room = limit - 1; // estimate must drop to <= limit - 1
  if (room < 0) return Number.POSITIVE_INFINITY;
  // Case 1: it frees up later in the current window (only prev decays).
  if (state.curr <= room && state.prev > 0) {
    const neededElapsed = windowMs * (1 - (room - state.curr) / state.prev);
    if (neededElapsed < windowMs) return Math.max(1, Math.ceil(neededElapsed - elapsed));
  }
  // Case 2: in the next window, today's `curr` becomes `prev` and decays from the start.
  const toWindowEnd = windowMs - elapsed;
  if (state.curr <= room) return Math.max(1, Math.ceil(toWindowEnd));
  const neededNext = windowMs * (1 - room / state.curr);
  return Math.max(1, Math.ceil(toWindowEnd + neededNext));
}
