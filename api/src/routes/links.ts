import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import QRCode from 'qrcode';
import { principalKey, principalOf, type AppContext } from '../http/context.js';
import {
  AnalyticsSchema,
  CreateLinkBody,
  ErrorSchema,
  errorResponses,
  IdParams,
  LinkSchema,
  RangeQuery,
  UpdateLinkBody,
} from '../http/schemas.js';
import { resolveRange, toCsv } from '../services/analyticsService.js';

export function linkRoutes(ctx: AppContext): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.addHook('preHandler', ctx.authenticate);
    const security: Record<string, string[]>[] = [{ sessionCookie: [] }, { apiKey: [] }];
    const tags = ['Links'];

    app.get(
      '/api/links',
      {
        schema: {
          tags,
          summary: 'List your links (newest first, keyset pagination)',
          security,
          querystring: Type.Object({
            q: Type.Optional(Type.String({ maxLength: 100, description: 'Search code, destination or title' })),
            limit: Type.Integer({ minimum: 1, maximum: 100, default: 20 }),
            cursor: Type.Optional(Type.String({ maxLength: 200 })),
          }),
          response: {
            200: Type.Object({ items: Type.Array(Type.Ref(LinkSchema)), nextCursor: Type.Union([Type.String(), Type.Null()]) }),
            ...errorResponses,
          },
        },
      },
      async (req) => {
        const page = await ctx.links.list(principalOf(req).userId, req.query);
        return { items: page.items.map((l) => ctx.links.toDto(l)), nextCursor: page.nextCursor };
      },
    );

    app.post(
      '/api/links',
      {
        schema: {
          tags,
          summary: 'Shorten a URL',
          description:
            'Generated codes are 7 base62 characters from a counter passed through a keyed Feistel permutation (collision-free by construction). ' +
            'Rate limited per IP and per user/API key.',
          security,
          body: CreateLinkBody,
          response: { 201: Type.Ref(LinkSchema), 409: Type.Ref(ErrorSchema), ...errorResponses },
        },
        preHandler: async (req, reply) => {
          const p = principalOf(req);
          await ctx.limit(req, reply, 'create-ip', ctx.config.rateLimits.createPerIp, `ip:${req.ip}`);
          await ctx.limit(req, reply, 'create', ctx.config.rateLimits.createPerPrincipal, principalKey(p));
        },
      },
      async (req, reply) => {
        const link = await ctx.links.create(principalOf(req).userId, req.body);
        return reply.code(201).send(ctx.links.toDto(link));
      },
    );

    app.get(
      '/api/links/:id',
      { schema: { tags, summary: 'Get one link', security, params: IdParams, response: { 200: Type.Ref(LinkSchema), ...errorResponses } } },
      async (req) => ctx.links.toDto(await ctx.links.getOwned(principalOf(req).userId, req.params.id)),
    );

    app.patch(
      '/api/links/:id',
      {
        schema: {
          tags,
          summary: 'Update destination, expiry, max clicks, password, public stats, or enable/disable',
          description: 'Send `null` to clear expiresAt, maxClicks or password. The cached redirect entry is invalidated.',
          security,
          params: IdParams,
          body: UpdateLinkBody,
          response: { 200: Type.Ref(LinkSchema), ...errorResponses },
        },
      },
      async (req) => ctx.links.toDto(await ctx.links.update(principalOf(req).userId, req.params.id, req.body)),
    );

    app.delete(
      '/api/links/:id',
      { schema: { tags, summary: 'Delete a link and its analytics', security, params: IdParams, response: { 204: Type.Null(), ...errorResponses } } },
      async (req, reply) => {
        await ctx.links.remove(principalOf(req).userId, req.params.id);
        return reply.code(204).send(null);
      },
    );

    app.get(
      '/api/links/:id/qr.svg',
      {
        schema: {
          tags,
          summary: 'QR code for the short URL (SVG, or PNG with ?format=png)',
          security,
          params: IdParams,
          querystring: Type.Object({
            format: Type.Union([Type.Literal('svg'), Type.Literal('png')], { default: 'svg' }),
            size: Type.Integer({ minimum: 64, maximum: 2048, default: 512 }),
          }),
        },
      },
      async (req, reply) => {
        const link = await ctx.links.getOwned(principalOf(req).userId, req.params.id);
        const text = ctx.links.toDto(link).shortUrl;
        const opts = { margin: 1, width: req.query.size, errorCorrectionLevel: 'M' as const };
        reply.header('cache-control', 'private, max-age=3600');
        if (req.query.format === 'png') {
          return reply.type('image/png').send(await QRCode.toBuffer(text, opts));
        }
        return reply.type('image/svg+xml').send(await QRCode.toString(text, { ...opts, type: 'svg' }));
      },
    );

    app.get(
      '/api/links/:id/analytics',
      {
        schema: {
          tags: ['Analytics'],
          summary: 'Clicks over time, uniques (HyperLogLog), referrers, countries, devices, browsers, OS',
          description: 'Bots are excluded from every figure except `totals.bots`. Default range: last 30 days; bucket defaults to hour for ranges up to 3 days.',
          security,
          params: IdParams,
          querystring: RangeQuery,
          response: { 200: Type.Ref(AnalyticsSchema), ...errorResponses },
        },
      },
      async (req) => {
        const link = await ctx.links.getOwned(principalOf(req).userId, req.params.id);
        return ctx.analytics.forLink(link, resolveRange(req.query, ctx.now()));
      },
    );

    app.get(
      '/api/links/:id/analytics.csv',
      {
        schema: {
          tags: ['Analytics'],
          summary: 'Raw click export as CSV (max 100k rows; no IPs, which are never stored)',
          security,
          params: IdParams,
          querystring: RangeQuery,
        },
      },
      async (req, reply) => {
        const link = await ctx.links.getOwned(principalOf(req).userId, req.params.id);
        const range = resolveRange(req.query, ctx.now());
        const rows = await ctx.analytics.exportRows(link.id, range);
        const day = (d: Date) => d.toISOString().slice(0, 10);
        return reply
          .type('text/csv; charset=utf-8')
          .header('content-disposition', `attachment; filename="linkpulse-${link.code}-${day(range.from)}_${day(range.to)}.csv"`)
          .send(toCsv(rows));
      },
    );

    app.get(
      '/api/links/:id/events',
      {
        schema: {
          tags: ['Analytics'],
          summary: 'Live click notifications (Server-Sent Events: `event: click`)',
          security,
          params: IdParams,
        },
      },
      async (req, reply) => {
        const link = await ctx.links.getOwned(principalOf(req).userId, req.params.id);
        reply.hijack();
        const res = reply.raw;
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write(`retry: 5000\nevent: ready\ndata: ${JSON.stringify({ linkId: link.id })}\n\n`);
        const unsubscribe = ctx.infra.bus.subscribe(link.id, (event) => {
          res.write(`event: click\ndata: ${JSON.stringify(event)}\n\n`);
        });
        const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
        heartbeat.unref();
        const close = () => {
          clearInterval(heartbeat);
          unsubscribe();
        };
        req.raw.on('close', close);
      },
    );

    app.get(
      '/api/overview',
      {
        schema: {
          tags: ['Analytics'],
          summary: 'Account-wide dashboard summary',
          security,
          querystring: Type.Object({ days: Type.Integer({ minimum: 1, maximum: 90, default: 30 }) }),
          response: {
            200: Type.Object({
              range: Type.Object({ from: Type.String(), to: Type.String() }),
              totals: Type.Object({
                links: Type.Integer(),
                activeLinks: Type.Integer(),
                clicks: Type.Integer(),
                uniqueVisitors: Type.Integer(),
              }),
              timeseries: Type.Array(Type.Object({ t: Type.String(), clicks: Type.Integer() })),
              topLinks: Type.Array(
                Type.Object({
                  id: Type.String(),
                  code: Type.String(),
                  title: Type.Union([Type.String(), Type.Null()]),
                  url: Type.String(),
                  clicks: Type.Integer(),
                }),
              ),
            }),
          },
        },
      },
      async (req) => ctx.analytics.overview(principalOf(req).userId, req.query.days, ctx.now()),
    );
  };
}
