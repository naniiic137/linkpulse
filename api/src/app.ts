import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import jwt from '@fastify/jwt';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { AppError, forbidden, unauthorized } from './domain/errors.js';
import { principalKey, SESSION_COOKIE, type AppContext } from './http/context.js';
import { enforce } from './http/rateLimit.js';
import { AnalyticsSchema, ApiKeySchema, ErrorSchema, LinkSchema, UserSchema } from './http/schemas.js';
import { CodeGenerator } from './lib/codeGenerator.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { keyRoutes } from './routes/keys.js';
import { linkRoutes } from './routes/links.js';
import { publicRoutes } from './routes/public.js';
import { AnalyticsService } from './services/analyticsService.js';
import { AuthService } from './services/authService.js';
import { ClickPipeline } from './services/clickPipeline.js';
import { LinkService } from './services/linkService.js';
import { PreviewService } from './services/previewService.js';
import { RedirectService } from './services/redirectService.js';
import type { Infrastructure } from './stores/types.js';

export interface BuildOptions {
  config: Config;
  infra: Infrastructure;
  /** Injectable clock (tests move time forward to exercise expiry). */
  now?: () => Date;
  logger?: FastifyServerOptions['logger'];
  /** Start the background analytics flusher (tests usually flush manually). */
  startPipeline?: boolean;
}

export type App = FastifyInstance & { ctx: AppContext };

export async function buildApp(opts: BuildOptions): Promise<App> {
  const { config, infra } = opts;
  const now = opts.now ?? (() => new Date());

  const app = Fastify({
    logger: opts.logger ?? {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    },
    trustProxy: config.trustProxy,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && /^[\w.-]{1,64}$/.test(incoming) ? incoming : randomUUID();
    },
    disableRequestLogging: config.env === 'production' ? false : undefined,
    bodyLimit: 64 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array', useDefaults: true } },
  }).withTypeProvider<TypeBoxTypeProvider>();

  // ---- wiring: stores -> services -------------------------------------------------------
  const policy = { selfHosts: [new URL(config.publicBaseUrl).hostname], blockedDomains: config.blockedDomains };
  const codes = new CodeGenerator(() => infra.store.nextIdBlock(), config.codeSecret);
  const previews = new PreviewService({ store: infra.store, fetchOptions: { policy }, now, log: app.log });
  const auth = new AuthService(infra.store, now);
  const links = new LinkService({
    store: infra.store,
    cache: infra.cache,
    quota: infra.quota,
    codes,
    policy,
    publicBaseUrl: config.publicBaseUrl,
    now,
    onDestinationChanged: config.previewFetch ? (link) => previews.schedule(link) : undefined,
  });
  const redirects = new RedirectService({
    store: infra.store,
    cache: infra.cache,
    queue: infra.queue,
    quota: infra.quota,
    now: () => now().getTime(),
    redirectStatus: config.redirectStatus,
    visitorSalt: config.visitorSalt,
    cacheTtlSeconds: config.cache.ttlSeconds,
    negativeTtlSeconds: config.cache.negativeTtlSeconds,
    onCacheError: (err) => app.log.warn({ err }, 'cache unavailable, falling back to store'),
  });
  const analytics = new AnalyticsService({ store: infra.store, uniques: infra.uniques });
  const pipeline = new ClickPipeline({
    queue: infra.queue,
    store: infra.store,
    uniques: infra.uniques,
    bus: infra.bus,
    batchSize: config.analytics.batchSize,
    intervalMs: config.analytics.flushIntervalMs,
    log: app.log,
  });

  const state = { shuttingDown: false };
  const limit: AppContext['limit'] = (req, reply, name, rule, subject) =>
    enforce(infra.rateLimiter, config.rateLimits.enabled, req, reply, name, rule, subject);

  const ctx: AppContext = {
    config,
    infra,
    now,
    auth,
    links,
    codes,
    redirects,
    analytics,
    pipeline,
    state,
    limit,
    authenticate: async (req, reply) => {
      const header = req.headers.authorization;
      if (header?.startsWith('Bearer ')) {
        const found = await auth.authenticateApiKey(header.slice(7).trim());
        if (!found) throw new AppError(401, 'invalid_api_key', 'Invalid or revoked API key');
        req.principal = { userId: found.userId, via: 'apiKey', keyId: found.keyId };
      } else {
        const token = req.cookies[SESSION_COOKIE];
        if (!token) throw unauthorized();
        let payload: { sub?: string };
        try {
          payload = app.jwt.verify<{ sub?: string }>(token);
        } catch {
          throw unauthorized('Session expired, please log in again');
        }
        if (!payload.sub) throw unauthorized();
        // CSRF: cookie-authenticated writes must carry a custom header. Cross-site forms can't
        // set one, and cross-origin fetch() can't without passing a CORS preflight.
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-requested-with'] !== 'linkpulse') {
          throw forbidden('Missing X-Requested-With header');
        }
        req.principal = { userId: payload.sub, via: 'session' };
      }
      await limit(req, reply, 'api', config.rateLimits.api, principalKey(req.principal));
    },
  };

  // ---- plugins ----------------------------------------------------------------------------
  await app.register(cookie);
  await app.register(jwt, { secret: config.jwtSecret, sign: { algorithm: 'HS256' }, verify: { algorithms: ['HS256'] } });
  await app.register(formbody);
  await app.register(cors, {
    origin: config.webOrigins,
    credentials: true,
    exposedHeaders: ['retry-after', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset'],
  });
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'LinkPulse API',
        version: '1.0.0',
        description:
          'URL shortener with real-time analytics. Authenticate with the session cookie (dashboard) or `Authorization: Bearer lp_live_...` (API keys). ' +
          'All limited endpoints return `RateLimit-*` headers and `Retry-After` on 429.',
      },
      servers: [{ url: config.publicBaseUrl }],
      tags: [
        { name: 'Links' }, { name: 'Analytics' }, { name: 'Redirects' }, { name: 'Public' },
        { name: 'Auth' }, { name: 'API keys' }, { name: 'Ops' },
      ],
      components: {
        securitySchemes: {
          sessionCookie: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE },
          apiKey: { type: 'http', scheme: 'bearer', description: 'API key (lp_live_...)' },
        },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs', uiConfig: { docExpansion: 'list', deepLinking: true } });

  for (const schema of [ErrorSchema, UserSchema, LinkSchema, AnalyticsSchema, ApiKeySchema]) app.addSchema(schema);
  app.decorateRequest('principal', null);

  // ---- errors -----------------------------------------------------------------------------
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      for (const [k, v] of Object.entries(err.headers)) reply.header(k, v);
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const e = err as Error & { validation?: unknown; statusCode?: number; code?: string };
    if (e.validation) {
      return reply.code(400).send({ error: { code: 'validation_error', message: e.message, details: e.validation } });
    }
    if (e.statusCode && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: { code: (e.code ?? 'bad_request').toLowerCase(), message: e.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Something went wrong' } });
  });
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } }),
  );

  // ---- routes -----------------------------------------------------------------------------
  app.get('/', { schema: { hide: true } }, async () => ({
    name: 'LinkPulse API',
    docs: `${config.publicBaseUrl}/docs`,
    health: `${config.publicBaseUrl}/health`,
  }));
  await app.register(healthRoutes(ctx));
  await app.register(authRoutes(ctx));
  await app.register(keyRoutes(ctx));
  await app.register(linkRoutes(ctx));
  await app.register(publicRoutes(ctx));

  // ---- lifecycle --------------------------------------------------------------------------
  if (opts.startPipeline) pipeline.start();
  app.addHook('preClose', async () => {
    state.shuttingDown = true;
  });
  app.addHook('onClose', async () => {
    await pipeline.stop(); // drain queued clicks before the stores close
    await infra.close();
  });

  return Object.assign(app, { ctx }) as unknown as App;
}
