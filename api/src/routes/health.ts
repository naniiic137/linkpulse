import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { AppContext } from '../http/context.js';

export function healthRoutes(ctx: AppContext): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      '/health',
      {
        logLevel: 'warn',
        schema: {
          tags: ['Ops'],
          summary: 'Liveness: the process is up and serving',
          response: { 200: Type.Object({ status: Type.Literal('ok'), uptimeSeconds: Type.Number() }) },
        },
      },
      async () => ({ status: 'ok' as const, uptimeSeconds: Math.round(process.uptime()) }),
    );

    app.get(
      '/ready',
      {
        logLevel: 'warn',
        schema: {
          tags: ['Ops'],
          summary: 'Readiness: dependencies reachable and not shutting down (503 otherwise)',
        },
      },
      async (_req, reply) => {
        const checks: Record<string, 'ok' | string> = {};
        const run = async (name: string, fn: () => Promise<unknown>) => {
          try {
            await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500).unref())]);
            checks[name] = 'ok';
          } catch (err) {
            checks[name] = (err as Error).message;
          }
        };
        await Promise.all([run('store', () => ctx.infra.store.ping()), run('hot', () => ctx.infra.pingHot())]);
        let queueDepth: number | null = null;
        try {
          queueDepth = await ctx.infra.queue.depth();
        } catch {
          /* informational only */
        }
        const ok = !ctx.state.shuttingDown && Object.values(checks).every((v) => v === 'ok');
        return reply.code(ok ? 200 : 503).send({
          status: ok ? 'ready' : ctx.state.shuttingDown ? 'shutting_down' : 'degraded',
          backend: ctx.infra.kind,
          checks,
          analyticsQueueDepth: queueDepth,
          analyticsFlushed: ctx.pipeline.stats.flushed,
        });
      },
    );
  };
}
