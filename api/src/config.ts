/**
 * Typed configuration loaded from environment variables.
 * Every value has a development default so `npm run dev` works with zero setup.
 */

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export interface Config {
  env: 'development' | 'production' | 'test';
  port: number;
  host: string;
  publicBaseUrl: string;
  webOrigins: string[];
  store: 'memory' | 'postgres';
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  codeSecret: string;
  visitorSalt: string;
  redirectStatus: 301 | 302;
  countryHeader: string;
  trustProxy: boolean;
  logLevel: string;
  previewFetch: boolean;
  seedDemo: boolean;
  blockedDomains: string[];
  cache: { ttlSeconds: number; negativeTtlSeconds: number };
  analytics: { flushIntervalMs: number; batchSize: number; maxQueue: number };
  rateLimits: {
    enabled: boolean;
    redirect: RateLimitRule;
    auth: RateLimitRule;
    createPerPrincipal: RateLimitRule;
    createPerIp: RateLimitRule;
    api: RateLimitRule;
    unlock: RateLimitRule;
  };
}

type Env = Record<string, string | undefined>;

function str(env: Env, key: string, fallback: string): string {
  const v = env[key];
  return v === undefined || v === '' ? fallback : v;
}

function int(env: Env, key: string, fallback: number): number {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Invalid integer for ${key}: ${v}`);
  return n;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function rule(env: Env, prefix: string, limit: number, windowMs: number): RateLimitRule {
  return {
    limit: int(env, `${prefix}_LIMIT`, limit),
    windowMs: int(env, `${prefix}_WINDOW_MS`, windowMs),
  };
}

export function loadConfig(env: Env = process.env): Config {
  const nodeEnv = str(env, 'NODE_ENV', 'development');
  const mode = nodeEnv === 'production' || nodeEnv === 'test' ? nodeEnv : 'development';
  const store = str(env, 'STORE', 'memory');
  if (store !== 'memory' && store !== 'postgres') throw new Error(`STORE must be memory|postgres, got ${store}`);
  const redirectStatus = int(env, 'REDIRECT_STATUS', 302);
  if (redirectStatus !== 301 && redirectStatus !== 302) throw new Error('REDIRECT_STATUS must be 301 or 302');

  const jwtSecret = str(env, 'JWT_SECRET', 'dev-only-jwt-secret-change-me-please-32chars');
  if (mode === 'production' && jwtSecret.startsWith('dev-only')) {
    throw new Error('JWT_SECRET must be set in production');
  }
  const port = int(env, 'PORT', 3501);

  return {
    env: mode,
    port,
    host: str(env, 'HOST', '0.0.0.0'),
    publicBaseUrl: str(env, 'PUBLIC_BASE_URL', `http://localhost:${port}`).replace(/\/+$/, ''),
    webOrigins: str(env, 'WEB_ORIGIN', 'http://localhost:3502,http://localhost:3503')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    store,
    databaseUrl: str(env, 'DATABASE_URL', 'postgres://linkpulse:linkpulse@localhost:5432/linkpulse'),
    redisUrl: str(env, 'REDIS_URL', 'redis://localhost:6379'),
    jwtSecret,
    codeSecret: str(env, 'CODE_SECRET', 'dev-only-code-secret'),
    visitorSalt: str(env, 'VISITOR_SALT', 'dev-only-visitor-salt'),
    redirectStatus,
    countryHeader: str(env, 'COUNTRY_HEADER', 'cf-ipcountry').toLowerCase(),
    trustProxy: bool(env, 'TRUST_PROXY', false),
    logLevel: str(env, 'LOG_LEVEL', mode === 'test' ? 'silent' : 'info'),
    previewFetch: bool(env, 'PREVIEW_FETCH', mode !== 'test'),
    seedDemo: bool(env, 'SEED_DEMO', store === 'memory' && mode === 'development'),
    blockedDomains: str(env, 'BLOCKED_DOMAINS', '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    cache: {
      ttlSeconds: int(env, 'CACHE_TTL_SECONDS', 3600),
      negativeTtlSeconds: int(env, 'CACHE_NEGATIVE_TTL_SECONDS', 60),
    },
    analytics: {
      flushIntervalMs: int(env, 'ANALYTICS_FLUSH_MS', 1000),
      batchSize: int(env, 'ANALYTICS_BATCH_SIZE', 500),
      maxQueue: int(env, 'ANALYTICS_MAX_QUEUE', 100_000),
    },
    rateLimits: {
      enabled: bool(env, 'RATE_LIMITS_ENABLED', true),
      redirect: rule(env, 'RL_REDIRECT', 300, 60_000),
      auth: rule(env, 'RL_AUTH', 10, 60_000),
      createPerPrincipal: rule(env, 'RL_CREATE', 30, 60_000),
      createPerIp: rule(env, 'RL_CREATE_IP', 60, 60_000),
      api: rule(env, 'RL_API', 600, 60_000),
      unlock: rule(env, 'RL_UNLOCK', 10, 60_000),
    },
  };
}

/** Config for tests: deterministic, in-memory, no background network calls. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  const base = loadConfig({ NODE_ENV: 'test', PUBLIC_BASE_URL: 'http://lp.test' });
  return { ...base, ...overrides };
}
