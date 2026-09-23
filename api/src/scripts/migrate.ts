/** Apply pending SQL migrations: `npm run migrate` (uses DATABASE_URL). */
import { loadConfig } from '../config.js';
import { migrate } from '../stores/postgres/migrate.js';
import { PostgresStore } from '../stores/postgres/postgresStore.js';

const store = PostgresStore.connect(loadConfig().databaseUrl);
try {
  const applied = await migrate(store.pool, (m) => console.log(m));
  console.log(applied.length ? `done: ${applied.length} migration(s) applied` : 'database is up to date');
} finally {
  await store.close();
}
