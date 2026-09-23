import { Redis } from 'ioredis';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp, type App } from '../../src/app.js';
import { testConfig, type Config } from '../../src/config.js';
import { createMemoryInfrastructure, createRedisPostgresInfrastructure } from '../../src/stores/index.js';
import { PostgresStore } from '../../src/stores/postgres/postgresStore.js';
import type { Infrastructure } from '../../src/stores/types.js';

export const REAL_BACKEND = process.env.LP_TEST_BACKEND === 'real';
export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://linkpulse:linkpulse@localhost:5432/linkpulse';
export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/** A controllable clock: tests move time forward to exercise expiry. */
export class Clock {
  constructor(public ms = Date.UTC(2026, 8, 1, 12, 0, 0)) {}
  now = () => new Date(this.ms);
  advance(ms: number) {
    this.ms += ms;
  }
}

/** Wipe shared state between tests when running against real Postgres + Redis. */
export async function resetRealBackends(): Promise<void> {
  const store = PostgresStore.connect(DATABASE_URL);
  const redis = new Redis(REDIS_URL);
  try {
    await store.pool.query('TRUNCATE users, api_keys, links, clicks CASCADE').catch((err: { code?: string }) => {
      if (err.code !== '42P01') throw err; // tables not created yet: nothing to wipe
    });
    await redis.flushdb();
  } finally {
    redis.disconnect();
    await store.close();
  }
}

export interface TestApp {
  app: App;
  infra: Infrastructure;
  clock: Clock;
  config: Config;
  close: () => Promise<void>;
}

export async function createTestApp(overrides: Partial<Config> = {}, opts: { realClock?: boolean } = {}): Promise<TestApp> {
  const clock = new Clock();
  const now = opts.realClock ? () => new Date() : clock.now;
  const config = testConfig(overrides);
  let infra: Infrastructure;
  if (REAL_BACKEND) {
    await resetRealBackends();
    infra = await createRedisPostgresInfrastructure({ databaseUrl: DATABASE_URL, redisUrl: REDIS_URL });
  } else {
    infra = createMemoryInfrastructure({ now: () => now().getTime() });
  }
  const app = await buildApp({ config, infra, now, logger: false });
  await app.ready();
  return { app, infra, clock, config, close: () => app.close() };
}

let counter = 0;

/** Sign up a fresh user and return a helper that sends authenticated requests. */
export async function signUp(app: App, name = 'Test User') {
  counter += 1;
  const email = `user${counter}-${Date.now()}@example.com`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: { email, password: 'correct-horse-battery', name },
  });
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.statusCode} ${res.body}`);
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  const userId = (res.json() as { user: { id: string } }).user.id;

  const request = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<LightMyRequestResponse> =>
    app.inject({
      method,
      url,
      headers: { cookie, 'x-requested-with': 'linkpulse' },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  return { email, cookie, userId, request };
}

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
export const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
export const BOT_UA = 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)';

/** Follow a short link like a browser from a given IP. */
export function visit(app: App, code: string, opts: { ua?: string; ip?: string; referer?: string; country?: string; html?: boolean } = {}) {
  return app.inject({
    method: 'GET',
    url: `/${code}`,
    remoteAddress: opts.ip ?? '203.0.113.10',
    headers: {
      'user-agent': opts.ua ?? BROWSER_UA,
      ...(opts.referer ? { referer: opts.referer } : {}),
      ...(opts.country ? { 'cf-ipcountry': opts.country } : {}),
      ...(opts.html ? { accept: 'text/html,application/xhtml+xml' } : {}),
    },
  });
}
