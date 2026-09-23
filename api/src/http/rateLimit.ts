import type { FastifyReply, FastifyRequest } from 'fastify';
import type { RateLimitRule } from '../config.js';
import { AppError } from '../domain/errors.js';
import type { RateDecision } from '../lib/slidingWindow.js';
import type { RateLimiter } from '../stores/types.js';

/**
 * Applies one sliding-window rule and writes the IETF RateLimit headers
 * (draft-ietf-httpapi-ratelimit-headers) plus Retry-After on 429s. When several
 * rules apply to one request (per-IP and per-API-key), the headers describe
 * the most restrictive one.
 */
export async function enforce(
  limiter: RateLimiter,
  enabled: boolean,
  req: FastifyRequest,
  reply: FastifyReply,
  name: string,
  rule: RateLimitRule,
  subject: string,
): Promise<RateDecision | null> {
  if (!enabled || rule.limit <= 0) return null;
  let decision: RateDecision;
  try {
    decision = await limiter.hit(`${name}:${subject}`, rule.limit, rule.windowMs);
  } catch (err) {
    // Fail open: a limiter outage must not take redirects down with it.
    req.log.warn({ err }, 'rate limiter unavailable, failing open');
    return null;
  }
  const current = Number(reply.getHeader('ratelimit-remaining') ?? Number.POSITIVE_INFINITY);
  if (!decision.allowed || decision.remaining <= current) {
    reply.header('ratelimit-limit', String(decision.limit));
    reply.header('ratelimit-remaining', String(decision.remaining));
    reply.header('ratelimit-reset', String(Math.ceil((decision.allowed ? decision.resetMs : decision.retryAfterMs) / 1000)));
    reply.header('ratelimit-policy', `${decision.limit};w=${Math.round(rule.windowMs / 1000)}`);
  }
  if (!decision.allowed) {
    const retryAfter = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
    throw new AppError(429, 'rate_limited', `Too many requests. Try again in ${retryAfter} s.`, { retryAfter, policy: name }, {
      'retry-after': String(retryAfter),
    });
  }
  return decision;
}
