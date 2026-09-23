import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { notFound } from '../domain/errors.js';
import { principalOf, type AppContext } from '../http/context.js';
import { ApiKeySchema, ErrorSchema } from '../http/schemas.js';
import { toPublicKey } from '../services/authService.js';

export function keyRoutes(ctx: AppContext): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.addHook('preHandler', ctx.authenticate);
    const security: Record<string, string[]>[] = [{ sessionCookie: [] }, { apiKey: [] }];

    app.get(
      '/api/keys',
      {
        schema: {
          tags: ['API keys'],
          summary: 'List your API keys (secrets are never returned again)',
          security,
          response: { 200: Type.Object({ items: Type.Array(Type.Ref(ApiKeySchema)) }) },
        },
      },
      async (req) => ({ items: (await ctx.auth.listApiKeys(principalOf(req).userId)).map(toPublicKey) }),
    );

    app.post(
      '/api/keys',
      {
        schema: {
          tags: ['API keys'],
          summary: 'Create an API key. The secret is returned once; only its SHA-256 is stored.',
          security,
          body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 60 }) }, { additionalProperties: false }),
          response: {
            201: Type.Object({ key: Type.Ref(ApiKeySchema), secret: Type.String({ description: 'lp_live_...' }) }),
            400: Type.Ref(ErrorSchema),
          },
        },
      },
      async (req, reply) => {
        const { key, secret } = await ctx.auth.createApiKey(principalOf(req).userId, req.body.name);
        return reply.code(201).send({ key: toPublicKey(key), secret });
      },
    );

    app.delete(
      '/api/keys/:id',
      {
        schema: {
          tags: ['API keys'],
          summary: 'Revoke an API key',
          security,
          params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
          response: { 204: Type.Null(), 404: Type.Ref(ErrorSchema) },
        },
      },
      async (req, reply) => {
        const ok = await ctx.auth.deleteApiKey(principalOf(req).userId, req.params.id);
        if (!ok) throw notFound('API key not found');
        return reply.code(204).send(null);
      },
    );
  };
}
