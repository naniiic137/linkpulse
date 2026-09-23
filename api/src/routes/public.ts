import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError, notFound } from '../domain/errors.js';
import type { AppContext } from '../http/context.js';
import { gonePage, notFoundPage, passwordPage, rateLimitedPage } from '../http/pages.js';
import { AnalyticsSchema, ErrorSchema } from '../http/schemas.js';
import { DAY } from '../lib/time.js';
import { normaliseCountry } from '../lib/userAgent.js';
import type { RedirectOutcome, VisitContext } from '../services/redirectService.js';

const wantsHtml = (req: FastifyRequest) => (req.headers.accept ?? '').includes('text/html');

export function publicRoutes(ctx: AppContext): FastifyPluginAsyncTypebox {
  return async (app) => {
    const visit = (req: FastifyRequest): VisitContext => ({
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] ?? ''),
      referrer: (req.headers.referer as string | undefined) ?? null,
      country: normaliseCountry(req.headers[ctx.config.countryHeader] ?? req.headers['x-country']),
    });

    /** Browsers get small HTML pages; API clients get JSON errors. */
    const respond = (req: FastifyRequest, reply: FastifyReply, outcome: RedirectOutcome) => {
      switch (outcome.kind) {
        case 'redirect':
          return reply
            .code(outcome.status)
            .header('location', outcome.url)
            .header('cache-control', outcome.status === 301 ? 'public, max-age=86400' : 'private, max-age=0, no-store')
            .header('x-cache', outcome.cache.toUpperCase())
            .send();
        case 'password_required':
          return reply
            .code(outcome.error ? 401 : 200)
            .header('cache-control', 'no-store')
            .type('text/html; charset=utf-8')
            .send(passwordPage(outcome.code, outcome.error));
        case 'gone':
          if (wantsHtml(req)) return reply.code(410).type('text/html; charset=utf-8').send(gonePage(outcome.reason));
          throw new AppError(410, `link_${outcome.reason}`, `This link is ${outcome.reason.replace('_', ' ')}`);
        case 'not_found':
          if (wantsHtml(req)) return reply.code(404).type('text/html; charset=utf-8').send(notFoundPage());
          throw notFound('Short link not found');
      }
    };

    /** Rate-limit errors on the redirect domain render as a friendly page for browsers. */
    const limitOrPage = async (req: FastifyRequest, reply: FastifyReply, name: string, subject: string, rule = ctx.config.rateLimits.redirect) => {
      try {
        await ctx.limit(req, reply, name, rule, subject);
        return true;
      } catch (err) {
        if (err instanceof AppError && err.statusCode === 429) {
          // Answer directly instead of unwinding through the error handler: under a flood,
          // the 429 path must be at least as cheap as a redirect.
          const retry = Number(err.headers['retry-after'] ?? 60);
          reply.code(429).header('retry-after', String(retry));
          if (wantsHtml(req)) reply.type('text/html; charset=utf-8').send(rateLimitedPage(retry));
          else reply.send({ error: { code: err.code, message: err.message, details: err.details } });
          return false;
        }
        throw err;
      }
    };

    app.get(
      '/:code',
      {
        schema: {
          tags: ['Redirects'],
          summary: 'Follow a short link',
          description:
            '302 to the destination (301 if REDIRECT_STATUS=301). Cache-first lookup (Redis, then PostgreSQL); the click is queued and recorded asynchronously. ' +
            '404 unknown, 410 disabled/expired/limit reached, 200 HTML password form for protected links, 429 when rate limited.',
          params: Type.Object({ code: Type.String() }),
        },
      },
      async (req, reply) => {
        if (!(await limitOrPage(req, reply, 'redirect', `ip:${req.ip}`))) return reply;
        return respond(req, reply, await ctx.redirects.resolve(req.params.code, visit(req)));
      },
    );

    app.post(
      '/:code',
      {
        schema: {
          tags: ['Redirects'],
          summary: 'Unlock a password-protected link (HTML form post)',
          params: Type.Object({ code: Type.String() }),
          body: Type.Object({ password: Type.String({ maxLength: 200 }) }),
        },
      },
      async (req, reply) => {
        const code = req.params.code;
        // Tight per-IP-per-link limit: link passwords are short and guessable.
        if (!(await limitOrPage(req, reply, 'unlock', `ip:${req.ip}:${code}`, ctx.config.rateLimits.unlock))) return reply;
        return respond(req, reply, await ctx.redirects.unlock(code, req.body.password, visit(req)));
      },
    );

    app.get(
      '/api/public/stats/:code',
      {
        schema: {
          tags: ['Public'],
          summary: 'Public stats page data (only for links whose owner enabled publicStats)',
          params: Type.Object({ code: Type.String({ maxLength: 32 }) }),
          response: {
            200: Type.Object({
              code: Type.String(),
              shortUrl: Type.String(),
              title: Type.Union([Type.String(), Type.Null()]),
              url: Type.String(),
              createdAt: Type.String(),
              analytics: Type.Ref(AnalyticsSchema),
            }),
            404: Type.Ref(ErrorSchema),
            429: Type.Ref(ErrorSchema),
          },
        },
        preHandler: (req, reply) => ctx.limit(req, reply, 'public', ctx.config.rateLimits.api, `ip:${req.ip}`),
      },
      async (req) => {
        const link = await ctx.infra.store.findLinkByCode(req.params.code);
        // Password-protected links never expose stats (or their destination) publicly.
        if (!link || !link.publicStats || link.passwordHash) throw notFound('No public stats for this link');
        const now = ctx.now();
        const tomorrow = Math.floor(now.getTime() / DAY) * DAY + DAY;
        return {
          code: link.code,
          shortUrl: `${ctx.config.publicBaseUrl}/${link.code}`,
          title: link.title,
          url: link.url,
          createdAt: link.createdAt.toISOString(),
          analytics: await ctx.analytics.forLink(link, { from: new Date(tomorrow - 30 * DAY), to: new Date(tomorrow), bucket: 'day' }),
        };
      },
    );
  };
}
