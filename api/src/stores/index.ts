import { Redis } from 'ioredis';
import type { Config } from '../config.js';
import { MemoryStore } from './memory/memoryStore.js';
import {
  MemoryCache,
  MemoryClickQueue,
  MemoryEventBus,
  MemoryQuotaCounter,
  MemoryRateLimiter,
  MemoryUniqueCounter,
} from './memory/memoryHot.js';
import { migrate } from './postgres/migrate.js';
import { PostgresStore } from './postgres/postgresStore.js';
import {
  RedisCache,
  RedisClickQueue,
  RedisEventBus,
  RedisQuotaCounter,
  RedisRateLimiter,
  RedisUniqueCounter,
} from './redis/redisHot.js';
import type { Infrastructure } from './types.js';

export function createMemoryInfrastructure(opts: { now?: () => number; maxQueue?: number } = {}): Infrastructure {
  const now = opts.now ?? Date.now;
  return {
    kind: 'memory',
    store: new MemoryStore(),
    cache: new MemoryCache(now),
    rateLimiter: new MemoryRateLimiter(now),
    queue: new MemoryClickQueue(opts.maxQueue),
    uniques: new MemoryUniqueCounter(),
    quota: new MemoryQuotaCounter(),
    bus: new MemoryEventBus(),
    pingHot: async () => {},
    close: async () => {},
  };
}

export async function createRedisPostgresInfrastructure(
  config: Pick<Config, 'databaseUrl' | 'redisUrl'>,
  log: (msg: string) => void = () => {},
): Promise<Infrastructure> {
  const store = PostgresStore.connect(config.databaseUrl);
  await migrate(store.pool, log);
  // Auto-pipelining batches concurrent commands from many in-flight redirects into one write.
  const redis = new Redis(config.redisUrl, { enableAutoPipelining: true, maxRetriesPerRequest: 2 });
  const sub = redis.duplicate();
  return {
    kind: 'postgres+redis',
    store,
    cache: new RedisCache(redis),
    rateLimiter: new RedisRateLimiter(redis),
    queue: new RedisClickQueue(redis, 1_000_000, (err) => log(`click enqueue failed: ${(err as Error).message}`)),
    uniques: new RedisUniqueCounter(redis),
    quota: new RedisQuotaCounter(redis),
    bus: new RedisEventBus(redis, sub),
    pingHot: async () => {
      await redis.ping();
    },
    close: async () => {
      sub.disconnect();
      await redis.quit().catch(() => redis.disconnect());
      await store.close();
    },
  };
}

export async function createInfrastructure(config: Config, log?: (msg: string) => void): Promise<Infrastructure> {
  return config.store === 'postgres'
    ? createRedisPostgresInfrastructure(config, log)
    : createMemoryInfrastructure({ maxQueue: config.analytics.maxQueue });
}
