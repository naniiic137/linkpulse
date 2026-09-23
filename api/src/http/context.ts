import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config, RateLimitRule } from '../config.js';
import type { CodeGenerator } from '../lib/codeGenerator.js';
import type { AnalyticsService } from '../services/analyticsService.js';
import type { AuthService } from '../services/authService.js';
import type { ClickPipeline } from '../services/clickPipeline.js';
import type { LinkService } from '../services/linkService.js';
import type { RedirectService } from '../services/redirectService.js';
import type { Infrastructure } from '../stores/types.js';

export interface Principal {
  userId: string;
  via: 'session' | 'apiKey';
  keyId?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

/** Everything route plugins need, wired once in buildApp(). */
export interface AppContext {
  config: Config;
  infra: Infrastructure;
  now: () => Date;
  auth: AuthService;
  links: LinkService;
  codes: CodeGenerator;
  redirects: RedirectService;
  analytics: AnalyticsService;
  pipeline: ClickPipeline;
  state: { shuttingDown: boolean };
  /** preHandler: resolves the session cookie or API key into request.principal (401 otherwise). */
  authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  limit: (req: FastifyRequest, reply: FastifyReply, name: string, rule: RateLimitRule, subject: string) => Promise<unknown>;
}

export const SESSION_COOKIE = 'lp_session';

export function principalOf(req: FastifyRequest): Principal {
  if (!req.principal) throw new Error('route is missing the authenticate preHandler');
  return req.principal;
}

/** Rate-limit subject for "per API key / per user" rules. */
export function principalKey(p: Principal): string {
  return p.via === 'apiKey' ? `key:${p.keyId}` : `user:${p.userId}`;
}
