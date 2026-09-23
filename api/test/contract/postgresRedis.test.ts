import { createRedisPostgresInfrastructure } from '../../src/stores/index.js';
import { DATABASE_URL, REAL_BACKEND, REDIS_URL } from '../helpers/testApp.js';
import { storeContract } from './storeContract.js';

// Runs in CI (npm run test:integration) against PostgreSQL 16 + Redis 7 service containers.
storeContract(
  'postgres + redis',
  () => createRedisPostgresInfrastructure({ databaseUrl: DATABASE_URL, redisUrl: REDIS_URL }),
  REAL_BACKEND,
);
