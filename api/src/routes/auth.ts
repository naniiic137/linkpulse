import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyReply } from 'fastify';
import { unauthorized } from '../domain/errors.js';
import { principalOf, SESSION_COOKIE, type AppContext } from '../http/context.js';
import { ErrorSchema, UserSchema } from '../http/schemas.js';
import { toPublicUser } from '../services/authService.js';

const SESSION_TTL_S = 7 * 86_400;

export function authRoutes(ctx: AppContext): FastifyPluginAsyncTypebox {
  return async (app) => {
    const setSession = async (reply: FastifyReply, userId: string) => {
      const token = await reply.jwtSign({ sub: userId }, { expiresIn: SESSION_TTL_S });
      reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: ctx.config.publicBaseUrl.startsWith('https://'),
        path: '/',
        maxAge: SESSION_TTL_S,
      });
    };

    const userResponse = { user: Type.Ref(UserSchema) };

    app.post(
      '/api/auth/signup',
      {
        schema: {
          tags: ['Auth'],
          summary: 'Create an account (starts a session)',
          body: Type.Object({
            email: Type.String({ maxLength: 254 }),
            password: Type.String({ maxLength: 200 }),
            name: Type.String({ maxLength: 80 }),
          }),
          response: { 201: Type.Object(userResponse), 400: Type.Ref(ErrorSchema), 409: Type.Ref(ErrorSchema), 429: Type.Ref(ErrorSchema) },
        },
        preHandler: (req, reply) => ctx.limit(req, reply, 'auth', ctx.config.rateLimits.auth, `ip:${req.ip}`),
      },
      async (req, reply) => {
        const user = await ctx.auth.signup(req.body);
        await setSession(reply, user.id);
        return reply.code(201).send({ user: toPublicUser(user) });
      },
    );

    app.post(
      '/api/auth/login',
      {
        schema: {
          tags: ['Auth'],
          summary: 'Log in with email + password (sets an httpOnly session cookie)',
          body: Type.Object({ email: Type.String({ maxLength: 254 }), password: Type.String({ maxLength: 200 }) }),
          response: { 200: Type.Object(userResponse), 401: Type.Ref(ErrorSchema), 429: Type.Ref(ErrorSchema) },
        },
        // Brute-force protection: per-IP limit on credential checks.
        preHandler: (req, reply) => ctx.limit(req, reply, 'auth', ctx.config.rateLimits.auth, `ip:${req.ip}`),
      },
      async (req, reply) => {
        const user = await ctx.auth.login(req.body.email, req.body.password);
        await setSession(reply, user.id);
        return { user: toPublicUser(user) };
      },
    );

    app.post(
      '/api/auth/logout',
      { schema: { tags: ['Auth'], summary: 'End the session', response: { 204: Type.Null() } } },
      async (_req, reply) => {
        reply.clearCookie(SESSION_COOKIE, { path: '/' });
        return reply.code(204).send(null);
      },
    );

    app.get(
      '/api/auth/me',
      {
        schema: {
          tags: ['Auth'],
          summary: 'Current user',
          security: [{ sessionCookie: [] }, { apiKey: [] }] as Record<string, string[]>[],
          response: { 200: Type.Object(userResponse), 401: Type.Ref(ErrorSchema) },
        },
        preHandler: ctx.authenticate,
      },
      async (req) => {
        const user = await ctx.infra.store.findUserById(principalOf(req).userId);
        if (!user) throw unauthorized('Account no longer exists');
        return { user: toPublicUser(user) };
      },
    );
  };
}
